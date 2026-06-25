import path from 'path';
import fs from 'fs-extra';
import { execa } from 'execa';
import { query, safeParse } from './org-query.js';
import { fetchOrgInventory } from './org-inventory.js';
import { parallelRetrieve } from './parallel-retrieve.js';

/**
 * Org monitoring & backup runner.
 *
 * Clean-room reimplementation of the scheduled org-health monitoring popular in
 * Salesforce DevOps tooling: org limit consumption, recent async-Apex failures,
 * security health-check score, and full metadata backup. Each check returns the
 * same normalised shape used by audit-runner so all surfaces render uniformly:
 *
 *   { id, title, status: 'ok'|'warn'|'fail'|'error', summary, findings: [...] }
 */

const DAY_MS = 24 * 60 * 60 * 1000;
// Salesforce SOQL datetime literals reject the milliseconds that toISOString()
// emits (…:00.000Z), so strip them for use in WHERE clauses.
const ISODate = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * Single source of truth for monitoring-check fallback defaults. Mirrored in
 * src/templates/sfdt.config.json (under `monitoring`), which is the canonical
 * config the user edits; centralised here so the literals don't drift across
 * the runner and command layers.
 */
export const MONITOR_DEFAULTS = {
  limitWarnThreshold: 0.8,
  errorLookbackDays: 7,
  healthMinScore: 80,
};

/**
 * Org limit consumption — flags limits at/above the warn threshold.
 */
export async function checkLimits(orgAlias, { warnThreshold = MONITOR_DEFAULTS.limitWarnThreshold } = {}) {
  const id = 'limits';
  const title = 'Org limits';
  try {
    const result = await execa('sf', ['org', 'list', 'limits', '--target-org', orgAlias, '--json']);
    const rows = safeParse(result.stdout)?.result ?? [];
    const findings = rows
      .map((r) => {
        const max = r.max ?? 0;
        const remaining = r.remaining ?? 0;
        const used = max - remaining;
        const ratio = max ? used / max : 0;
        return { name: r.name, used, max, ratio: Number(ratio.toFixed(2)) };
      })
      .filter((f) => f.max > 0 && f.ratio >= warnThreshold)
      .sort((a, b) => b.ratio - a.ratio);
    return result_(id, title, findings.length ? 'warn' : 'ok',
      findings.length
        ? `${findings.length} limit(s) at or above ${Math.round(warnThreshold * 100)}% usage`
        : 'All org limits have headroom',
      findings);
  } catch (err) {
    return errored(id, title, err);
  }
}

/**
 * Recent async-Apex failures (batch / queueable / scheduled jobs).
 */
export async function checkErrors(orgAlias, { lookbackDays = MONITOR_DEFAULTS.errorLookbackDays } = {}) {
  const id = 'errors';
  const title = 'Recent Apex job failures';
  try {
    const since = ISODate(Date.now() - lookbackDays * DAY_MS);
    const records = await query(
      orgAlias,
      `SELECT Id, JobType, ApexClass.Name, Status, ExtendedStatus, NumberOfErrors, CompletedDate ` +
        `FROM AsyncApexJob WHERE Status = 'Failed' AND CompletedDate >= ${since} ` +
        `ORDER BY CompletedDate DESC LIMIT 200`,
    );
    const findings = records.map((r) => ({
      job: r.ApexClass?.Name ?? r.JobType,
      type: r.JobType,
      errors: r.NumberOfErrors ?? 0,
      status: r.ExtendedStatus,
      date: r.CompletedDate,
    }));
    return result_(id, title, findings.length ? 'fail' : 'ok',
      findings.length
        ? `${findings.length} failed Apex job(s) in the last ${lookbackDays} days`
        : `No failed Apex jobs in the last ${lookbackDays} days`,
      findings);
  } catch (err) {
    return errored(id, title, err);
  }
}

/**
 * Security health-check score (Tooling API). Flags a score below the floor.
 */
export async function checkHealth(orgAlias, { minScore = MONITOR_DEFAULTS.healthMinScore } = {}) {
  const id = 'health';
  const title = 'Security health check';
  try {
    const rows = await query(orgAlias, 'SELECT Score FROM SecurityHealthCheck', { tooling: true });
    const score = rows[0]?.Score;
    if (score == null) {
      // No rows means the check failed silently or the user lacks permission —
      // not a healthy org. Surface it as a warning rather than a false 'ok'.
      return result_(id, title, 'warn', 'Security health-check score unavailable (no rows returned)', []);
    }
    const rounded = Math.round(score);
    return result_(id, title, rounded < minScore ? 'warn' : 'ok',
      `Security health-check score: ${rounded}% (floor ${minScore}%)`,
      [{ score: rounded, floor: minScore }]);
  } catch (err) {
    return errored(id, title, err);
  }
}

export const CHECKS = {
  limits: checkLimits,
  errors: checkErrors,
  health: checkHealth,
};

export const CHECK_IDS = Object.keys(CHECKS);

/**
 * Full metadata backup — retrieves every metadata member from the org into a
 * timestamped directory under the configured backup root. Reuses the org
 * inventory and the parallel-retrieve engine.
 *
 * @param {string} orgAlias
 * @param {object} config - loaded sfdt config
 * @param {object} [options]
 * @param {function} [options.onProgress]
 * @returns {Promise<{id, title, status, summary, findings, outDir}>}
 */
export async function runBackup(orgAlias, config, { onProgress } = {}) {
  const id = 'backup';
  const title = 'Metadata backup';
  try {
    const backupRoot = path.isAbsolute(config.monitoring?.backupDir ?? 'monitoring-backup')
      ? config.monitoring.backupDir
      : path.join(config._projectRoot ?? process.cwd(), config.monitoring?.backupDir ?? 'monitoring-backup');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outDir = path.join(backupRoot, `${sanitize(orgAlias)}-${stamp}`);

    const inventory = await fetchOrgInventory(orgAlias, config);
    await fs.ensureDir(outDir);

    const { retrieved, total, errors } = await parallelRetrieve(inventory, config, {
      cwd: outDir,
      onProgress,
    });

    const status = errors.length > 0 ? 'warn' : 'ok';
    return {
      id,
      title,
      status,
      summary: `Backed up ${retrieved}/${total} component(s)${errors.length ? `, ${errors.length} batch error(s)` : ''} to ${outDir}`,
      findings: errors.slice(0, 20).map((e) => ({ batch: e.batch, error: oneLine(e.error) })),
      outDir,
      retrieved,
      total,
    };
  } catch (err) {
    return errored(id, title, err);
  }
}

/**
 * Run monitoring checks (and optionally backup) and assemble a snapshot.
 *
 * @param {string} orgAlias
 * @param {object} config
 * @param {object} [options]
 * @param {string[]} [options.checks] - subset of CHECK_IDS; defaults to all.
 * @param {boolean} [options.backup] - also run a metadata backup.
 * @param {object} [options.params] - per-check overrides keyed by id.
 */
export async function runMonitor(orgAlias, config, { checks = CHECK_IDS, backup = false, params = {} } = {}) {
  const selected = checks.filter((cid) => CHECKS[cid]);
  // Checks are independent and self-contained (each catches its own errors), so
  // run them concurrently. Backup runs after, only when requested.
  const results = await Promise.all(selected.map((cid) => CHECKS[cid](orgAlias, params[cid] ?? {})));
  if (backup) results.push(await runBackup(orgAlias, config, params.backup ?? {}));

  const summary = {
    total: results.length,
    ok: results.filter((r) => r.status === 'ok').length,
    warn: results.filter((r) => r.status === 'warn').length,
    fail: results.filter((r) => r.status === 'fail').length,
    error: results.filter((r) => r.status === 'error').length,
  };
  return { timestamp: new Date().toISOString(), org: orgAlias, checks: results, summary };
}

function result_(id, title, status, summary, findings) {
  return { id, title, status, summary, findings };
}

function errored(id, title, err) {
  // sf emits a JSON error envelope on stdout (e.g. auth failure, invalid org
  // alias). Prefer its structured `message` over the opaque execa error so the
  // friendly sf text surfaces. Checks that go through query()/rawQuery() already
  // get this; this covers checks that call execa directly (e.g. checkLimits).
  const structured = safeParse(err?.stdout)?.message;
  return {
    id,
    title,
    status: 'error',
    summary: `Check failed: ${oneLine(structured || err?.message)}`,
    findings: [],
  };
}

function sanitize(s) {
  return String(s).replace(/[^a-z0-9_-]/gi, '_');
}

function oneLine(s) {
  return String(s ?? '').replace(/[\r\n]+/g, ' ').slice(0, 300);
}
