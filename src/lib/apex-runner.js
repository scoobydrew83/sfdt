import os from 'os';
import path from 'path';
import fs from 'fs-extra';
import { execa } from 'execa';
import { query, safeParse } from './org-query.js';

/**
 * Apex observability runner — trace flags, debug log retrieve/watch, and
 * Anonymous Apex execution. Complements the `test` runner (which owns test
 * execution; targeted tests live there, not here).
 *
 * Native clean-room implementation (inspired by sf-pi's SF Apex extension, no
 * code shared): everything shells out to the Salesforce CLI —
 *   - debug logs / Anonymous Apex via `sf apex list log` / `sf apex get log` /
 *     `sf apex run` (same execa + stdout-JSON conventions as data-runner.js);
 *   - trace flags via the Tooling API (`org-query` for reads,
 *     `sf data create|delete record --use-tooling-api` for writes) because the
 *     sf CLI has no first-class trace-flag command.
 *
 * Arg-building and the watch loop are pure/injectable so they can be
 * unit-tested without a live org.
 */

/** Default DebugLevel DeveloperName owned by sfdt (created on demand). */
export const DEFAULT_DEBUG_LEVEL = 'SFDT_Trace';

/** Field values used when sfdt creates its own DebugLevel. */
export const DEBUG_LEVEL_DEFAULTS = {
  ApexCode: 'DEBUG',
  ApexProfiling: 'INFO',
  Callout: 'INFO',
  Database: 'INFO',
  System: 'DEBUG',
  Validation: 'INFO',
  Visualforce: 'INFO',
  Workflow: 'INFO',
};

/** Salesforce caps a TraceFlag window at 24 hours. */
export const MAX_TRACE_MINUTES = 24 * 60;

/** Escape a value for interpolation into a SOQL single-quoted literal. */
export function soqlQuote(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Format a Date for Tooling API datetime field values (no milliseconds). */
export function toApiDateTime(d) {
  return new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Rethrow an sf/execa failure with the CLI's structured JSON error message
 * (from stdout or stderr) instead of the opaque "Command failed…" string.
 * When the failure looks like a missing `sf apex` plugin, degrade gracefully
 * with an actionable install hint rather than fabricating any result.
 */
export function sfError(err) {
  const text = `${err?.stderr ?? ''}\n${err?.shortMessage ?? err?.message ?? ''}`;
  if (/not a sf command|NonExistentCommand|command .*apex.* not found/i.test(text)) {
    const e = new Error(
      'The Salesforce CLI apex plugin is unavailable — run `sf plugins install @salesforce/plugin-apex` (bundled with recent sf releases) and retry.',
    );
    e.code = 'SF_APEX_PLUGIN_MISSING';
    return e;
  }
  const msg = safeParse(err?.stdout)?.message ?? safeParse(err?.stderr)?.message;
  if (msg) {
    const e = new Error(msg);
    e.stderr = err?.stderr;
    return e;
  }
  return err;
}

async function sfJson(args) {
  let result;
  try {
    result = await execa('sf', args);
  } catch (err) {
    throw sfError(err);
  }
  return safeParse(result.stdout)?.result ?? null;
}

/** Resolve the username the org alias is authenticated as. */
export async function getDefaultUsername(orgAlias) {
  const result = await sfJson(['org', 'display', '--target-org', orgAlias, '--json']);
  const username = result?.username;
  if (!username) throw new Error(`Could not resolve the username for org "${orgAlias}".`);
  return username;
}

/** Resolve a username to its User Id. */
export async function resolveUserId(orgAlias, username) {
  const records = await query(
    orgAlias,
    `SELECT Id, Username FROM User WHERE Username = '${soqlQuote(username)}' LIMIT 1`,
  );
  if (records.length === 0) throw new Error(`User "${username}" not found in org "${orgAlias}".`);
  return records[0].Id;
}

/**
 * Resolve a DebugLevel DeveloperName to its Id. The sfdt-owned default level
 * (SFDT_Trace) is created on demand; any other missing name is an error — we
 * never silently create a level the user believes already exists.
 */
export async function ensureDebugLevel(orgAlias, developerName = DEFAULT_DEBUG_LEVEL) {
  const records = await query(
    orgAlias,
    `SELECT Id FROM DebugLevel WHERE DeveloperName = '${soqlQuote(developerName)}' LIMIT 1`,
    { tooling: true },
  );
  if (records.length > 0) return { id: records[0].Id, created: false };
  if (developerName !== DEFAULT_DEBUG_LEVEL) {
    throw new Error(
      `Debug level "${developerName}" not found in org "${orgAlias}" — pass an existing DebugLevel DeveloperName, or omit --level to use the sfdt-managed "${DEFAULT_DEBUG_LEVEL}".`,
    );
  }
  const values = Object.entries({
    DeveloperName: DEFAULT_DEBUG_LEVEL,
    MasterLabel: DEFAULT_DEBUG_LEVEL,
    ...DEBUG_LEVEL_DEFAULTS,
  })
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  const result = await sfJson([
    'data', 'create', 'record', '--use-tooling-api', '--sobject', 'DebugLevel',
    '--values', values, '--target-org', orgAlias, '--json',
  ]);
  const id = result?.id;
  if (!id) throw new Error(`Could not create debug level "${DEFAULT_DEBUG_LEVEL}" in org "${orgAlias}".`);
  return { id, created: true };
}

/**
 * Start (create) a USER_DEBUG trace flag for a user.
 *
 * @param {string} orgAlias
 * @param {object} [options]
 * @param {string} [options.user] - Username to trace (default: the org's authenticated user).
 * @param {number} [options.durationMinutes] - Trace window in minutes (default 60, capped at 24 h).
 * @param {string} [options.debugLevel] - DebugLevel DeveloperName (default SFDT_Trace, created on demand).
 */
export async function startTrace(orgAlias, { user, durationMinutes = 60, debugLevel = DEFAULT_DEBUG_LEVEL } = {}) {
  const minutes = Math.min(Math.max(Number(durationMinutes) || 60, 1), MAX_TRACE_MINUTES);
  const username = user ?? (await getDefaultUsername(orgAlias));
  const userId = await resolveUserId(orgAlias, username);
  const level = await ensureDebugLevel(orgAlias, debugLevel);
  const start = new Date();
  const expiration = new Date(start.getTime() + minutes * 60_000);
  const values = [
    `TracedEntityId=${userId}`,
    'LogType=USER_DEBUG',
    `DebugLevelId=${level.id}`,
    `StartDate=${toApiDateTime(start)}`,
    `ExpirationDate=${toApiDateTime(expiration)}`,
  ].join(' ');
  const result = await sfJson([
    'data', 'create', 'record', '--use-tooling-api', '--sobject', 'TraceFlag',
    '--values', values, '--target-org', orgAlias, '--json',
  ]);
  const traceFlagId = result?.id;
  if (!traceFlagId) throw new Error(`Could not create a trace flag for ${username} in org "${orgAlias}".`);
  return {
    org: orgAlias,
    user: username,
    userId,
    traceFlagId,
    debugLevel,
    debugLevelCreated: level.created,
    durationMinutes: minutes,
    startDate: toApiDateTime(start),
    expirationDate: toApiDateTime(expiration),
  };
}

/** List trace flags in the org (USER_DEBUG and otherwise). Read-only. */
export async function listTraceFlags(orgAlias) {
  const records = await query(
    orgAlias,
    'SELECT Id, TracedEntityId, LogType, StartDate, ExpirationDate, DebugLevel.DeveloperName FROM TraceFlag ORDER BY ExpirationDate DESC',
    { tooling: true },
  );
  const now = Date.now();
  return {
    org: orgAlias,
    traceFlags: records.map((r) => ({
      id: r.Id,
      tracedEntityId: r.TracedEntityId,
      logType: r.LogType,
      startDate: r.StartDate ?? null,
      expirationDate: r.ExpirationDate ?? null,
      debugLevel: r.DebugLevel?.DeveloperName ?? null,
      active: !!r.ExpirationDate && Date.parse(r.ExpirationDate) > now,
    })),
  };
}

/**
 * Stop (delete) trace flags.
 *
 * @param {string} orgAlias
 * @param {object} [options]
 * @param {string} [options.user] - Only this username's USER_DEBUG flags (default: the org's authenticated user).
 * @param {boolean} [options.all] - Delete every USER_DEBUG trace flag in the org.
 */
export async function stopTrace(orgAlias, { user, all = false } = {}) {
  let soql = "SELECT Id FROM TraceFlag WHERE LogType = 'USER_DEBUG'";
  let username = null;
  if (!all) {
    username = user ?? (await getDefaultUsername(orgAlias));
    const userId = await resolveUserId(orgAlias, username);
    soql += ` AND TracedEntityId = '${soqlQuote(userId)}'`;
  }
  const records = await query(orgAlias, soql, { tooling: true });
  const deleted = [];
  for (const r of records) {
    await sfJson([
      'data', 'delete', 'record', '--use-tooling-api', '--sobject', 'TraceFlag',
      '--record-id', r.Id, '--target-org', orgAlias, '--json',
    ]);
    deleted.push(r.Id);
  }
  return { org: orgAlias, user: username, deleted: deleted.length, ids: deleted };
}

/** Map a raw ApexLog record to the compact shape sfdt reports. */
export function mapLogRecord(r) {
  return {
    id: r.Id,
    user: r.LogUser?.Name ?? null,
    operation: r.Operation ?? null,
    application: r.Application ?? null,
    status: r.Status ?? null,
    request: r.Request ?? null,
    durationMs: r.DurationMilliseconds ?? null,
    lengthBytes: r.LogLength ?? null,
    startTime: r.StartTime ?? null,
  };
}

/**
 * List recent debug logs (newest first). Read-only.
 *
 * @param {string} orgAlias
 * @param {object} [options]
 * @param {number} [options.limit] - Maximum logs to return (default 20).
 * @param {string} [options.user] - Only logs generated by this user (display name).
 */
export async function listLogs(orgAlias, { limit = 20, user } = {}) {
  const result = await sfJson(['apex', 'list', 'log', '--target-org', orgAlias, '--json']);
  let records = Array.isArray(result) ? result : [];
  if (user) records = records.filter((r) => r.LogUser?.Name === user);
  records = [...records].sort(
    (a, b) => (Date.parse(b.StartTime ?? 0) || 0) - (Date.parse(a.StartTime ?? 0) || 0),
  );
  const max = Math.max(Number(limit) || 20, 1);
  return { org: orgAlias, total: records.length, logs: records.slice(0, max).map(mapLogRecord) };
}

/**
 * Retrieve one debug log's body.
 *
 * @param {string} orgAlias
 * @param {string} logId
 * @param {object} [options]
 * @param {string} [options.outputFile] - Also write the raw body to this path
 *   (raw on disk; the JSON envelope stays a stdout-only concern).
 */
export async function getLog(orgAlias, logId, { outputFile } = {}) {
  if (!logId) throw new Error('A debug log Id is required.');
  const result = await sfJson(['apex', 'get', 'log', '--log-id', logId, '--target-org', orgAlias, '--json']);
  // plugin-apex has returned both [{ log }] and { log } shapes across versions.
  const body = Array.isArray(result) ? (result[0]?.log ?? '') : (result?.log ?? '');
  if (outputFile) {
    await fs.outputFile(outputFile, body);
  }
  return { org: orgAlias, id: logId, lengthBytes: Buffer.byteLength(body, 'utf8'), log: body, outputFile: outputFile ?? null };
}

/**
 * Watch (tail) debug logs: poll for new ApexLog entries and stream each new
 * log through `onLog`. Bounded by design so it is CI-safe — the loop stops at
 * `durationMs` (default 5 minutes) or after `maxLogs` new logs; `durationMs: 0`
 * means watch until the process is interrupted (interactive use).
 *
 * Pre-existing logs are seeded as "seen" so only logs generated after the
 * watch starts are reported.
 *
 * @param {string} orgAlias
 * @param {object} [options]
 * @param {number} [options.intervalMs] - Poll interval (default 5000).
 * @param {number} [options.durationMs] - Total watch window; 0 = unbounded (default 300000).
 * @param {number} [options.maxLogs] - Stop after this many new logs (default Infinity).
 * @param {boolean} [options.fetchBody] - Fetch each new log's body (default true).
 * @param {(entry: {meta: object, body: string|null}) => void} [options.onLog]
 * @param {object} [deps] - Injectable for tests: { list, get, sleep, now }.
 */
export async function watchLogs(orgAlias, options = {}, deps = {}) {
  const {
    intervalMs = 5000,
    durationMs = 300_000,
    maxLogs = Infinity,
    fetchBody = true,
    onLog = () => {},
  } = options;
  const list = deps.list ?? listLogs;
  const get = deps.get ?? getLog;
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => Date.now());

  const startedAt = now();
  const seen = new Set();
  const initial = await list(orgAlias, { limit: 200 });
  for (const l of initial.logs) seen.add(l.id);

  const collected = [];
  const timedOut = () => durationMs > 0 && now() - startedAt >= durationMs;

  while (!timedOut() && collected.length < maxLogs) {
    await sleep(intervalMs);
    if (timedOut()) break;
    const { logs } = await list(orgAlias, { limit: 200 });
    // Oldest-first so a tail reads chronologically.
    const fresh = logs.filter((l) => !seen.has(l.id)).reverse();
    for (const meta of fresh) {
      if (collected.length >= maxLogs) break;
      seen.add(meta.id);
      let body = null;
      if (fetchBody) {
        body = (await get(orgAlias, meta.id)).log;
      }
      collected.push(meta);
      onLog({ meta, body });
    }
  }
  return { org: orgAlias, watchedMs: now() - startedAt, newLogs: collected.length, logs: collected };
}

/**
 * Execute Anonymous Apex from a file or an inline code string.
 * Mutating — the code runs with the authenticated user's permissions.
 *
 * Returns the compile/execution diagnostics whether or not the run succeeded;
 * callers decide the exit code. Throws only for transport-level failures
 * (org unreachable, plugin missing, unreadable file).
 *
 * @param {string} orgAlias
 * @param {object} options
 * @param {string} [options.file] - Path to a .apex file.
 * @param {string} [options.code] - Inline Apex code (written to a temp file).
 */
export async function runAnonymous(orgAlias, { file, code } = {}) {
  if (!file && !code) throw new Error('Provide Apex code via a file or inline string.');
  let apexFile = file;
  let tmpDir = null;
  if (!apexFile) {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sfdt-apex-'));
    apexFile = path.join(tmpDir, 'anonymous.apex');
    await fs.writeFile(apexFile, code);
  }
  try {
    // `sf apex run` exits non-zero on compile/runtime failure but still emits
    // its JSON envelope on stdout — capture it either way (reject: false).
    const proc = await execa('sf', ['apex', 'run', '--file', apexFile, '--target-org', orgAlias, '--json'], {
      reject: false,
    });
    const parsed = safeParse(proc.stdout);
    const r = parsed?.result ?? (parsed?.compiled != null ? parsed : null);
    if (!r || typeof r !== 'object') {
      throw sfError({ stdout: proc.stdout, stderr: proc.stderr, message: proc.shortMessage ?? `sf apex run exited with code ${proc.exitCode}` });
    }
    return {
      org: orgAlias,
      file: file ?? null,
      success: !!r.success,
      compiled: !!r.compiled,
      compileProblem: r.compileProblem || null,
      exceptionMessage: r.exceptionMessage || null,
      exceptionStackTrace: r.exceptionStackTrace || null,
      line: r.line ?? null,
      column: r.column ?? null,
      logs: r.logs ?? null,
    };
  } finally {
    if (tmpDir) await fs.remove(tmpDir).catch(() => {});
  }
}
