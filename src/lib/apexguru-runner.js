import path from 'path';
import fs from 'fs-extra';
import { execa } from 'execa';
import { glob } from 'glob';
import { safeParse } from './org-query.js';
import { archiveSnapshot } from './log-writer.js';
import { recordRun } from './run-history.js';

/**
 * ApexGuru org-side analysis runner.
 *
 * Native re-implementation of the ApexGuru pass popularised by Salesforce's
 * Code Analyzer tooling (and sf-pi's SF Code Analyzer extension) — no code is
 * shared or vendored. ApexGuru is Salesforce's org-side Apex performance/
 * anti-pattern service, reached over the org REST API:
 *
 *   GET  /services/data/v{V}/apexguru/validate          → is ApexGuru enabled?
 *   POST /services/data/v{V}/apexguru/request           → submit one class (base64)
 *   GET  /services/data/v{V}/apexguru/request/{id}      → poll; report is base64 JSON
 *
 * All HTTP goes through `sf api request rest` (the org-release.js pattern) so
 * no auth plumbing or new dependencies are needed.
 *
 * ApexGuru is license/edition-gated (and must be enabled by an admin), so this
 * check follows the established gated-org-check policy: it degrades to
 * `skipped` (org/feature unreachable) or `warn` (enabled but analysis could not
 * complete) — **never `error`**, and never a fabricated pass. Results are
 * advisory: they must not change the `sfdt quality` exit code from what Code
 * Analyzer v5 alone would produce.
 *
 * The normalised result shape matches the audit/monitor runners
 * (`{ id, title, status, summary, findings }`) so every surface renders it the
 * same way; `status` here is 'ok' | 'warn' | 'skipped'.
 */

export const APEXGURU_DEFAULTS = {
  apiVersion: '64.0',
  maxClasses: 10,
  pollIntervalMs: 2000,
  pollTimeoutMs: 120000,
};

const guruBase = (apiVersion) => `/services/data/v${apiVersion}/apexguru`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Minimal REST helper over `sf api request rest`. sf colorizes this command's
 * output even without a TTY, which breaks JSON.parse — force color off
 * (same workaround as detectOrgRelease in org-release.js).
 */
export async function apexGuruRest(orgAlias, urlPath, { method = 'GET', body, timeoutMs } = {}) {
  const args = ['api', 'request', 'rest', urlPath, '--target-org', orgAlias];
  if (method !== 'GET') args.push('--method', method);
  if (body !== undefined) args.push('--body', JSON.stringify(body));
  const opts = { env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } };
  if (timeoutMs) opts.timeout = timeoutMs;
  const resp = await execa('sf', args, opts);
  return safeParse(resp.stdout);
}

/**
 * Pull the friendliest message out of a failed `sf api request rest` call.
 * Salesforce REST errors arrive as `[{ message, errorCode }]`, sf CLI errors
 * as `{ message }` — check stdout then stderr, then fall back to the execa
 * message (e.g. ENOENT when the sf CLI itself is missing).
 */
function restErrorMessage(err) {
  for (const raw of [err?.stdout, err?.stderr]) {
    const parsed = safeParse(raw);
    const message = Array.isArray(parsed) ? parsed[0]?.message : parsed?.message;
    if (message) return message;
  }
  return err?.shortMessage || err?.message || 'unknown error';
}

/**
 * Availability probe: GET apexguru/validate. Returns `{ available, reason }`
 * and never throws — any failure (org unreachable, no auth, older sf CLI
 * without `sf api request`, 404 because the org's edition/license has no
 * ApexGuru) is a reason to skip, not an error.
 */
export async function checkApexGuruAccess(orgAlias, { apiVersion = APEXGURU_DEFAULTS.apiVersion, timeoutMs } = {}) {
  try {
    const resp = await apexGuruRest(orgAlias, `${guruBase(apiVersion)}/validate`, { timeoutMs });
    const status = String(resp?.status ?? '').toLowerCase();
    if (status === 'success') return { available: true, reason: null };
    return {
      available: false,
      reason: `ApexGuru is not enabled for this org (validate returned "${resp?.status ?? 'no status'}")`,
    };
  } catch (err) {
    return { available: false, reason: oneLine(restErrorMessage(err)) };
  }
}

/**
 * Decode and normalise one ApexGuru report (base64-encoded JSON array of
 * insights). Defensive by design — a malformed report yields zero findings
 * rather than a crash.
 */
export function parseApexGuruReport(reportB64, file) {
  if (!reportB64) return [];
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(String(reportB64), 'base64').toString('utf8'));
  } catch {
    return [];
  }
  const entries = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.reports) ? parsed.reports : [];
  return entries.map((entry) => {
    const props = Array.isArray(entry?.properties) ? entry.properties : [];
    const prop = (name) => props.find((p) => p?.name === name)?.value;
    const line = Number.parseInt(prop('line_number'), 10);
    return {
      file,
      type: entry?.type ?? 'Insight',
      line: Number.isFinite(line) ? line : null,
      description: oneLine(entry?.value ?? ''),
    };
  });
}

/**
 * Submit one Apex class to ApexGuru and poll until the report is ready.
 * Throws on submit/poll failure or timeout — runApexGuruCheck catches per
 * class and degrades.
 */
export async function analyzeApexClass(orgAlias, filePath, {
  apiVersion = APEXGURU_DEFAULTS.apiVersion,
  pollIntervalMs = APEXGURU_DEFAULTS.pollIntervalMs,
  pollTimeoutMs = APEXGURU_DEFAULTS.pollTimeoutMs,
  timeoutMs,
} = {}) {
  const content = await fs.readFile(filePath, 'utf8');
  const base = guruBase(apiVersion);
  const submit = await apexGuruRest(orgAlias, `${base}/request`, {
    method: 'POST',
    body: { classContent: Buffer.from(content, 'utf8').toString('base64') },
    timeoutMs,
  });
  const requestId = submit?.requestId;
  if (!requestId) {
    throw new Error(`ApexGuru did not return a requestId (status: ${submit?.status ?? 'unknown'})`);
  }

  const deadline = Date.now() + pollTimeoutMs;
  for (;;) {
    const poll = await apexGuruRest(orgAlias, `${base}/request/${requestId}`, { timeoutMs });
    const status = String(poll?.status ?? '').toLowerCase();
    if (status === 'success') return parseApexGuruReport(poll?.report, filePath);
    if (status === 'failed' || status === 'error') {
      throw new Error(`ApexGuru analysis failed for ${path.basename(filePath)} (status: ${poll?.status})`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`ApexGuru analysis timed out after ${pollTimeoutMs}ms for ${path.basename(filePath)}`);
    }
    if (pollIntervalMs > 0) await sleep(pollIntervalMs);
  }
}

/**
 * Discover the Apex classes to analyze: non-test .cls files under the
 * project's default source path, largest first (ApexGuru is a performance
 * profiler — big classes are where it earns its keep).
 */
export async function findApexClasses(config) {
  const root = config._projectRoot ?? process.cwd();
  const sourcePath = config.defaultSourcePath ?? 'force-app/main/default';
  const matches = await glob('**/*.cls', { cwd: path.join(root, sourcePath), absolute: true, nodir: true });
  const candidates = matches.filter((f) => !/tests?\.cls$/i.test(path.basename(f)));
  const withSizes = await Promise.all(
    candidates.map(async (f) => {
      try {
        return { f, size: (await fs.stat(f)).size };
      } catch {
        return { f, size: 0 };
      }
    }),
  );
  return withSizes.sort((a, b) => b.size - a.size).map((s) => s.f);
}

/**
 * The ApexGuru quality check. Returns the normalised check shape and NEVER
 * throws and never returns status 'error' — every unavailability path
 * (no org, no license/edition, feature disabled, sf CLI too old) is
 * `skipped`, and an enabled-but-failing analysis is `warn`.
 *
 * @param {string} orgAlias - Target org alias ('' / null → skipped).
 * @param {object} config - Loaded sfdt config.
 * @param {object} [overrides] - APEXGURU_DEFAULTS overrides; `files` bypasses
 *   discovery with an explicit list of .cls paths (used by tests).
 */
export async function runApexGuruCheck(orgAlias, config, overrides = {}) {
  const id = 'apexguru';
  const title = 'ApexGuru org-side analysis';
  const opts = { ...APEXGURU_DEFAULTS, ...overrides };
  const started = Date.now();
  const result = (status, summary, findings = [], extra = {}) => ({
    id,
    title,
    status,
    summary,
    findings,
    org: orgAlias || null,
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - started,
    ...extra,
  });

  try {
    if (!orgAlias) {
      return result('skipped', 'No target org — pass --org <alias> or set defaultOrg in .sfdt/config.json');
    }

    const access = await checkApexGuruAccess(orgAlias, opts);
    if (!access.available) {
      return result('skipped', `ApexGuru unavailable for ${orgAlias} (license/edition-gated): ${access.reason}`);
    }

    const classes = overrides.files ?? (await findApexClasses(config));
    if (classes.length === 0) {
      return result('skipped', `No Apex classes found under ${config.defaultSourcePath ?? 'force-app/main/default'}`);
    }

    const selected = classes.slice(0, opts.maxClasses);
    const findings = [];
    const degraded = [];
    for (const file of selected) {
      try {
        findings.push(...(await analyzeApexClass(orgAlias, file, opts)));
      } catch (err) {
        degraded.push({ file, error: oneLine(err?.message) });
      }
    }

    const analyzed = selected.length - degraded.length;
    const scope = `${analyzed}/${selected.length} class(es)` + (classes.length > selected.length ? ` (largest of ${classes.length})` : '');
    if (analyzed === 0) {
      // Enabled but nothing completed — degraded, not broken (gated-check policy).
      return result('warn', `ApexGuru analysis could not be completed for any of ${selected.length} class(es): ${degraded[0].error}`, [], { degraded });
    }
    if (findings.length === 0) {
      return result('ok', `ApexGuru found no issues in ${scope}`, [], degraded.length ? { degraded } : {});
    }
    return result(
      'warn',
      `ApexGuru reported ${findings.length} insight(s) across ${scope}`,
      findings,
      degraded.length ? { degraded } : {},
    );
  } catch (err) {
    // Belt and braces: no failure inside a gated org check may become 'error'.
    return result('skipped', `ApexGuru check could not run: ${oneLine(err?.message)}`);
  }
}

/**
 * Persist the ApexGuru snapshot (raw shape on disk, like audit/monitor):
 * logs/apexguru-latest.json + a timestamped archive copy + a run-history row.
 * Best-effort — telemetry never breaks the measured work (golden principle #5).
 * Returns the latest-file path or null.
 */
export async function persistApexGuruSnapshot(config, result) {
  try {
    const logDir = config.logDir ?? path.join(config._projectRoot ?? process.cwd(), 'logs');
    const latestPath = path.join(logDir, 'apexguru-latest.json');
    await fs.outputJson(latestPath, result, { spaces: 2 });
    await archiveSnapshot(logDir, 'apexguru-results', result, { retention: config.logRetention ?? 50 });
    await recordRun(logDir, {
      type: 'apexguru',
      timestamp: result.timestamp,
      org: result.org ?? '',
      exitCode: 0,
      durationMs: result.durationMs ?? 0,
      status: result.status,
      summary: { findings: result.findings?.length ?? 0, summary: result.summary },
    });
    return latestPath;
  } catch {
    return null;
  }
}

function oneLine(s) {
  return String(s ?? '').replace(/[\r\n]+/g, ' ').slice(0, 300);
}
