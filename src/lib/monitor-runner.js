import path from 'path';
import fs from 'fs-extra';
import { execa } from 'execa';
import { ORG_HEALTH_THRESHOLDS } from '@sfdt/flow-core';
import { query, safeParse, toSoqlDate } from './org-query.js';
import { fetchOrgInventory } from './org-inventory.js';
import { parallelRetrieve } from './parallel-retrieve.js';
import { expectedGaApiVersion, detectOrgRelease } from './org-release.js';

// Re-exported for back-compat: `expectedGaApiVersion` moved to org-release.js
// (shared with compare/retrofit) but was previously imported from here.
export { expectedGaApiVersion };

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
// SOQL datetime literal helper (shared) — strips the milliseconds Salesforce rejects.
const ISODate = toSoqlDate;

/**
 * Single source of truth for monitoring-check fallback defaults. Usage and
 * health thresholds come from the shared @sfdt/flow-core rulebook
 * (ORG_HEALTH_THRESHOLDS) so the CLI, GUI, and Chrome extension band findings
 * identically. NOTE: limitWarnThreshold changed 0.8 → 0.75 here as part of that
 * unification — the CLI now warns at the same 75% point Chrome uses. CLI-only
 * knobs (errorLookbackDays) have no shared equivalent and stay local. Mirrored
 * in src/templates/sfdt.config.json (under `monitoring`), the canonical config.
 */
export const MONITOR_DEFAULTS = {
  limitWarnThreshold: ORG_HEALTH_THRESHOLDS.usageAmber, // 0.75 (was 0.8 before flow-core unification)
  errorLookbackDays: 7,
  healthMinScore: ORG_HEALTH_THRESHOLDS.healthMinScore, // 80
  orgInfoTrialWarnDays: 14,
  deployHistoryLookback: 20,
  deprecatedApiLookbackDays: 7,
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
    const thresholdFindings = rows
      .map((r) => {
        const max = r.max ?? 0;
        const remaining = r.remaining ?? 0;
        const used = max - remaining;
        const ratio = max ? used / max : 0;
        return { name: r.name, used, max, ratio: Number(ratio.toFixed(2)) };
      })
      .filter((f) => f.max > 0 && f.ratio >= warnThreshold)
      .sort((a, b) => b.ratio - a.ratio);
    const findings = [...thresholdFindings];

    // Summer '26 elastic async Apex (Beta): when the limits payload carries the
    // elastic keys, report usage and warn when the org is running in the elastic
    // overflow band (usage above the standard daily async limit). Orgs without
    // the beta simply don't return these keys — silently skip them.
    const byName = new Map(rows.map((r) => [r.name, r]));
    const elastic = byName.get('DailyAsyncApexElasticExecutions');
    const processed = byName.get('DailyAsyncApexProcessed');
    let overflow = false;
    if (elastic || processed) {
      const standardMax = byName.get('DailyAsyncApexExecutions')?.max ?? 0;
      const src = processed ?? elastic;
      const used = (src.max ?? 0) - (src.remaining ?? 0);
      overflow = standardMax > 0 && used > standardMax;
      findings.push({
        name: 'DailyAsyncApexElastic (Beta)',
        used,
        standardLimit: standardMax,
        elasticLimit: elastic?.max ?? null,
        overflow,
        detail: overflow
          ? `Async Apex usage (${used}) exceeds the standard daily limit (${standardMax}) — running in the elastic overflow band`
          : 'Elastic async Apex available; usage within the standard daily limit',
      });
    }

    const overflowNote = overflow ? '; async Apex is in the elastic overflow band (Beta)' : '';
    return result_(id, title, thresholdFindings.length || overflow ? 'warn' : 'ok',
      (thresholdFindings.length
        ? `${thresholdFindings.length} limit(s) at or above ${Math.round(warnThreshold * 100)}% usage`
        : 'All org limits have headroom') + overflowNote,
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

/**
 * Org info / instance — informational, with a trial/expiration warning. Also
 * reports the org's release version (and preview status) when determinable.
 */
export async function checkOrgInfo(orgAlias, { trialWarnDays = MONITOR_DEFAULTS.orgInfoTrialWarnDays, timeoutMs } = {}) {
  const id = 'org-info';
  const title = 'Org info';
  try {
    const rows = await query(
      orgAlias,
      `SELECT Name, InstanceName, OrganizationType, IsSandbox, TrialExpirationDate FROM Organization LIMIT 1`,
      { timeoutMs },
    );
    const org = rows[0];
    if (!org) return result_(id, title, 'warn', 'Organization record unavailable', []);
    const releaseInfo = await detectOrgRelease(orgAlias, { timeoutMs });
    const finding = {
      name: org.Name,
      instance: org.InstanceName,
      type: org.OrganizationType,
      sandbox: org.IsSandbox,
      trialExpires: org.TrialExpirationDate ?? null,
      release: releaseInfo?.release ?? null,
      releaseApiVersion: releaseInfo?.apiVersion ?? null,
      preview: releaseInfo?.preview ?? null,
    };
    const releaseNote = releaseInfo
      ? ` — ${releaseInfo.release}${releaseInfo.preview ? ' (preview instance)' : ''}`
      : '';
    let status = 'ok';
    let summary = `${org.OrganizationType} on ${org.InstanceName}${org.IsSandbox ? ' (sandbox)' : ''}${releaseNote}`;
    if (org.TrialExpirationDate) {
      const daysLeft = Math.ceil((new Date(org.TrialExpirationDate).getTime() - Date.now()) / DAY_MS);
      finding.daysLeft = daysLeft;
      if (daysLeft <= trialWarnDays) {
        status = 'warn';
        summary = `Trial/expiration in ${daysLeft} day(s) (${org.InstanceName})`;
      }
    }
    return result_(id, title, status, summary, [finding]);
  } catch (err) {
    return errored(id, title, err);
  }
}

/**
 * Recent deployment health (Tooling DeployRequest) — fails when the most recent
 * deployment failed, warns when any in the window failed.
 */
export async function checkDeployHistory(orgAlias, { lookback = MONITOR_DEFAULTS.deployHistoryLookback } = {}) {
  const id = 'deploy-history';
  const title = 'Recent deployments';
  try {
    // lookback is interpolated into SOQL LIMIT and may come from user config —
    // coerce to a safe integer (the checkApiVersions pattern).
    const lim = Number.parseInt(lookback, 10);
    if (!Number.isFinite(lim)) throw new Error(`monitoring.deployHistoryLookback must be a number, got: ${lookback}`);
    const rows = await query(
      orgAlias,
      `SELECT Status, StartDate, CompletedDate, NumberComponentErrors, CreatedBy.Name FROM DeployRequest ` +
        `ORDER BY CompletedDate DESC NULLS LAST LIMIT ${lim}`,
      { tooling: true },
    );
    if (rows.length === 0) return result_(id, title, 'ok', 'No recent deployments found', []);
    const failed = rows.filter((r) => r.Status === 'Failed' || (r.NumberComponentErrors ?? 0) > 0);
    const latestFailed = rows[0].Status === 'Failed';
    const findings = failed.map((r) => ({
      status: r.Status,
      errors: r.NumberComponentErrors ?? 0,
      user: r.CreatedBy?.Name,
      date: r.CompletedDate ?? r.StartDate,
    }));
    const status = latestFailed ? 'fail' : failed.length ? 'warn' : 'ok';
    return result_(id, title, status,
      latestFailed
        ? 'Most recent deployment failed'
        : failed.length
          ? `${failed.length} of last ${rows.length} deployment(s) failed`
          : `Last ${rows.length} deployment(s) succeeded`,
      findings);
  } catch (err) {
    // DeployRequest is a Tooling object that some orgs/permissions reject.
    return degraded(id, title, err, 'Deployment history');
  }
}

/**
 * Legacy/deprecated API usage — presence of ApiTotalUsage event logs indicates
 * traffic against deprecated Salesforce API versions. Degrades to a warning
 * (never a false 'ok') when EventLogFile is inaccessible (no Event Monitoring).
 */
export async function checkDeprecatedApi(orgAlias, { lookbackDays = MONITOR_DEFAULTS.deprecatedApiLookbackDays } = {}) {
  const id = 'deprecated-api';
  const title = 'Legacy API usage';
  try {
    const since = ISODate(Date.now() - lookbackDays * DAY_MS);
    const rows = await query(
      orgAlias,
      `SELECT LogDate, EventType, LogFileLength FROM EventLogFile ` +
        `WHERE EventType = 'ApiTotalUsage' AND LogDate >= ${since} ORDER BY LogDate DESC LIMIT 50`,
    );
    const findings = rows.map((r) => ({ date: r.LogDate, bytes: r.LogFileLength }));
    return result_(id, title, findings.length ? 'warn' : 'ok',
      findings.length
        ? `Legacy/deprecated API traffic logged on ${findings.length} day(s) in the last ${lookbackDays} days`
        : `No legacy API usage logs in the last ${lookbackDays} days`,
      findings);
  } catch (err) {
    return result_(id, title, 'warn',
      `Legacy API usage unavailable (EventLogFile not accessible — requires API/Event Monitoring): ${oneLine(err?.message)}`,
      []);
  }
}

/**
 * Paused flow interviews — interviews stuck in a Paused state (often a Wait
 * element with no resume) that can pile up and mask automation problems.
 */
export async function checkFlowErrors(orgAlias) {
  const id = 'flow-errors';
  const title = 'Paused flow interviews';
  try {
    const rows = await query(
      orgAlias,
      `SELECT InterviewLabel, CurrentElement, CreatedDate FROM FlowInterview ` +
        `WHERE InterviewStatus = 'Paused' ORDER BY CreatedDate ASC LIMIT 200`,
    );
    const findings = rows.map((r) => ({ name: r.InterviewLabel, element: r.CurrentElement, date: r.CreatedDate }));
    return result_(id, title, findings.length ? 'warn' : 'ok',
      findings.length
        ? `${findings.length} paused flow interview(s) (potentially stuck)`
        : 'No paused flow interviews',
      findings);
  } catch (err) {
    // FlowInterview / InterviewStatus is not queryable in every org.
    return degraded(id, title, err, 'Paused flow interviews');
  }
}

export const CHECKS = {
  limits: checkLimits,
  errors: checkErrors,
  health: checkHealth,
  'org-info': checkOrgInfo,
  'deploy-history': checkDeployHistory,
  'deprecated-api': checkDeprecatedApi,
  'flow-errors': checkFlowErrors,
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
  // sf usually writes its JSON error envelope to stdout, but some commands
  // (auth/alias failures) route it to stderr — check both.
  const structured = safeParse(err?.stdout)?.message ?? safeParse(err?.stderr)?.message;
  return {
    id,
    title,
    status: 'error',
    summary: `Check failed: ${oneLine(structured || err?.message)}`,
    findings: [],
  };
}

/**
 * Soft failure for checks that query a Tooling/license-gated object whose
 * absence means "can't run here", not "org is unhealthy". Surfaces `warn` (not
 * `error`) so `monitor all` doesn't exit non-zero over a missing API. Mirrors
 * checkDeprecatedApi.
 */
function degraded(id, title, err, what) {
  const structured = safeParse(err?.stdout)?.message ?? safeParse(err?.stderr)?.message;
  return {
    id,
    title,
    status: 'warn',
    summary: `${what} unavailable in this org: ${oneLine(structured || err?.message)}`,
    findings: [],
  };
}

function sanitize(s) {
  return String(s).replace(/[^a-z0-9_-]/gi, '_');
}

function oneLine(s) {
  return String(s ?? '').replace(/[\r\n]+/g, ' ').slice(0, 300);
}
