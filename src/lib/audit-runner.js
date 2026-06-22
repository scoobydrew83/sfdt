import { query } from './org-query.js';

/**
 * Org diagnose & audit runner.
 *
 * Clean-room reimplementation of the read-only org-health diagnostics popular
 * in Salesforce DevOps tooling (audit trail, license usage, MFA coverage,
 * unused Apex, inactive users, deprecated API versions). Each check is a pure
 * async function that returns a normalised result object so the CLI, GUI, and
 * MCP surfaces can render them uniformly:
 *
 *   { id, title, status: 'ok'|'warn'|'fail'|'error', summary, findings: [...] }
 *
 * Checks never throw to the orchestrator — a failed query is captured as an
 * `error` status so `audit all` always produces a complete snapshot.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Single source of truth for audit-check fallback defaults.
 *
 * These values are mirrored in src/templates/sfdt.config.json (under `audit`)
 * which remains the canonical config the user edits. They are duplicated here
 * only as a defensive fallback for programmatic callers and when a config key
 * is absent — keeping them in one constant prevents the literals from drifting
 * across the runner and command layers. Update the floor (e.g. when Salesforce
 * retires an API version) in `.sfdt/config.json` → `audit.minApiVersion`, or
 * here for the built-in default.
 */
export const AUDIT_DEFAULTS = {
  auditTrailLookbackDays: 30,
  licenseWarnThreshold: 0.9,
  inactiveUserDays: 90,
  minApiVersion: 45,
};

// Setup-audit-trail actions/sections that warrant a closer look. Matched as
// case-insensitive substrings against the Action and Section columns.
const SUSPECT_PATTERNS = [
  'deleted',
  'changedpassword',
  'resetpassword',
  'suorgadminlogin', // "Login as" another user
  'frozeuser',
  'PermSetAssign',
  'PermSetLicenseAssign',
  'changedprofile',
  'changedadmin',
  'deactivateuser',
  'connectedapp',
  'remoteaccess',
  'certificate',
  'namedcredential',
  'changedsessionsettings',
  'changedpasswordpolicy',
  'manageipranges',
];

// Salesforce SOQL datetime literals reject the milliseconds that
// toISOString() emits (…:00.000Z), so strip them for use in WHERE clauses.
const ISODate = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * Recent suspicious setup activity from SetupAuditTrail.
 */
export async function checkAuditTrail(orgAlias, { lookbackDays = AUDIT_DEFAULTS.auditTrailLookbackDays } = {}) {
  const id = 'audittrail';
  const title = 'Suspicious setup activity';
  try {
    const since = ISODate(Date.now() - lookbackDays * DAY_MS);
    const records = await query(
      orgAlias,
      `SELECT Action, Section, CreatedDate, CreatedBy.Name, Display, DelegateUser ` +
        `FROM SetupAuditTrail WHERE CreatedDate >= ${since} ORDER BY CreatedDate DESC LIMIT 500`,
    );
    const findings = records
      .filter((r) => {
        const hay = `${r.Action || ''} ${r.Section || ''}`.toLowerCase();
        return SUSPECT_PATTERNS.some((p) => hay.includes(p.toLowerCase()));
      })
      .map((r) => ({
        action: r.Action,
        section: r.Section,
        user: r.CreatedBy?.Name ?? r.DelegateUser ?? 'Unknown',
        date: r.CreatedDate,
        detail: r.Display,
      }));
    return result(id, title, findings.length ? 'warn' : 'ok',
      findings.length
        ? `${findings.length} suspicious change(s) in the last ${lookbackDays} days`
        : `No suspicious setup changes in the last ${lookbackDays} days`,
      findings);
  } catch (err) {
    return errored(id, title, err);
  }
}

/**
 * License usage — flags licenses near or at their limit.
 */
export async function checkLicenses(orgAlias, { warnThreshold = AUDIT_DEFAULTS.licenseWarnThreshold } = {}) {
  const id = 'licenses';
  const title = 'License usage';
  try {
    const records = await query(
      orgAlias,
      `SELECT Name, TotalLicenses, UsedLicenses, Status FROM UserLicense ` +
        `WHERE Status = 'Active' AND TotalLicenses > 0 ORDER BY Name`,
    );
    const findings = records
      .map((r) => {
        const ratio = r.TotalLicenses ? r.UsedLicenses / r.TotalLicenses : 0;
        return {
          name: r.Name,
          used: r.UsedLicenses,
          total: r.TotalLicenses,
          ratio: Number(ratio.toFixed(2)),
          atRisk: ratio >= warnThreshold,
        };
      })
      .filter((f) => f.atRisk);
    return result(id, title, findings.length ? 'warn' : 'ok',
      findings.length
        ? `${findings.length} license type(s) at or above ${Math.round(warnThreshold * 100)}% usage`
        : 'All license types have headroom',
      findings);
  } catch (err) {
    return errored(id, title, err);
  }
}

/**
 * MFA coverage — active human users with no registered MFA method.
 */
export async function checkMfa(orgAlias) {
  const id = 'mfa';
  const title = 'MFA coverage';
  try {
    // Users that have registered at least one verification method.
    const mfaRows = await query(orgAlias, 'SELECT UserId FROM TwoFactorMethodsInfo');
    const enrolled = new Set(mfaRows.map((r) => r.UserId));
    // Active, human (non-integration) users.
    const users = await query(
      orgAlias,
      `SELECT Id, Username, Name, Profile.UserLicense.Name FROM User ` +
        `WHERE IsActive = true AND UserType = 'Standard' ORDER BY Name LIMIT 2000`,
    );
    const findings = users
      .filter((u) => !enrolled.has(u.Id))
      .map((u) => ({ username: u.Username, name: u.Name, license: u.Profile?.UserLicense?.Name }));
    return result(id, title, findings.length ? 'warn' : 'ok',
      findings.length
        ? `${findings.length} active user(s) without a registered MFA method`
        : 'All active standard users have MFA registered',
      findings);
  } catch (err) {
    return errored(id, title, err);
  }
}

/**
 * Potentially unused Apex classes — non-test classes with zero code coverage
 * (never exercised by any test). Heuristic: zero coverage strongly correlates
 * with dead or untested code; flagged for review, not auto-deletion.
 */
export async function checkUnusedApex(orgAlias) {
  const id = 'unused-apex';
  const title = 'Potentially unused Apex';
  try {
    const classes = await query(
      orgAlias,
      `SELECT Id, Name, ApiVersion FROM ApexClass WHERE NamespacePrefix = null ORDER BY Name`,
      { tooling: true },
    );
    // Aggregate coverage per class id.
    const coverage = await query(
      orgAlias,
      `SELECT ApexClassOrTriggerId, NumLinesCovered, NumLinesUncovered FROM ApexCodeCoverageAggregate`,
      { tooling: true },
    );
    const covered = new Set(
      coverage
        .filter((c) => (c.NumLinesCovered ?? 0) > 0)
        .map((c) => c.ApexClassOrTriggerId),
    );
    const findings = classes
      .filter((c) => !/(^test|test$)/i.test(c.Name) && !covered.has(c.Id))
      .map((c) => ({ name: c.Name, apiVersion: c.ApiVersion }));
    return result(id, title, findings.length ? 'warn' : 'ok',
      findings.length
        ? `${findings.length} Apex class(es) with no test coverage (review for removal)`
        : 'All Apex classes have some coverage',
      findings);
  } catch (err) {
    return errored(id, title, err);
  }
}

/**
 * Inactive users — active licenses held by users who have not logged in
 * within the lookback window (or never).
 */
export async function checkInactiveUsers(orgAlias, { lookbackDays = AUDIT_DEFAULTS.inactiveUserDays } = {}) {
  const id = 'inactive-users';
  const title = 'Inactive users';
  try {
    const cutoff = ISODate(Date.now() - lookbackDays * DAY_MS);
    const records = await query(
      orgAlias,
      `SELECT Username, Name, LastLoginDate, Profile.Name FROM User ` +
        `WHERE IsActive = true AND UserType = 'Standard' ` +
        `AND (LastLoginDate < ${cutoff} OR LastLoginDate = null) ORDER BY LastLoginDate NULLS FIRST LIMIT 2000`,
    );
    const findings = records.map((r) => ({
      username: r.Username,
      name: r.Name,
      lastLogin: r.LastLoginDate ?? null,
      profile: r.Profile?.Name,
    }));
    return result(id, title, findings.length ? 'warn' : 'ok',
      findings.length
        ? `${findings.length} active user(s) inactive for >${lookbackDays} days`
        : `No users inactive beyond ${lookbackDays} days`,
      findings);
  } catch (err) {
    return errored(id, title, err);
  }
}

/**
 * Deprecated API versions — Apex classes/triggers on an API version below the
 * configured floor. Salesforce hard-blocks very old versions, so this surfaces
 * remediation work before it becomes a breaking change.
 */
export async function checkApiVersions(orgAlias, { minApiVersion = AUDIT_DEFAULTS.minApiVersion } = {}) {
  const id = 'api-versions';
  const title = 'Deprecated API versions';
  try {
    // minApiVersion is interpolated into SOQL and may originate from
    // user-editable config — coerce to a safe number to prevent SOQL injection.
    const minApi = Number.parseInt(minApiVersion, 10);
    if (!Number.isFinite(minApi)) {
      throw new Error(`audit.minApiVersion must be a number, got: ${minApiVersion}`);
    }
    // ApexClass and ApexTrigger are independent Tooling queries — run them in
    // parallel. Iterate the types in order afterwards so findings stay stable
    // (all ApexClass rows before ApexTrigger rows).
    const types = ['ApexClass', 'ApexTrigger'];
    const rowsByType = await Promise.all(
      types.map((type) => query(
        orgAlias,
        `SELECT Name, ApiVersion FROM ${type} WHERE NamespacePrefix = null AND ApiVersion < ${minApi} ORDER BY ApiVersion`,
        { tooling: true },
      )),
    );
    const findings = [];
    types.forEach((type, i) => {
      for (const r of rowsByType[i]) findings.push({ type, name: r.Name, apiVersion: r.ApiVersion });
    });
    return result(id, title, findings.length ? 'warn' : 'ok',
      findings.length
        ? `${findings.length} component(s) below API v${minApi}`
        : `All components on API v${minApi} or newer`,
      findings);
  } catch (err) {
    return errored(id, title, err);
  }
}

export const CHECKS = {
  audittrail: checkAuditTrail,
  licenses: checkLicenses,
  mfa: checkMfa,
  'unused-apex': checkUnusedApex,
  'inactive-users': checkInactiveUsers,
  'api-versions': checkApiVersions,
};

export const CHECK_IDS = Object.keys(CHECKS);

/**
 * Run one or all audit checks and assemble a snapshot.
 *
 * @param {string} orgAlias
 * @param {object} [options]
 * @param {string[]} [options.checks] - subset of CHECK_IDS; defaults to all.
 * @param {object} [options.params] - per-check option overrides keyed by id.
 * @returns {Promise<{timestamp, org, checks, summary}>}
 */
export async function runAudit(orgAlias, { checks = CHECK_IDS, params = {} } = {}) {
  const selected = checks.filter((id) => CHECKS[id]);
  // Each check makes independent SOQL/Tooling calls and catches its own errors
  // (returning an 'error'-status result), so run them concurrently rather than
  // serialising ~18 round-trips.
  const results = await Promise.all(selected.map((id) => CHECKS[id](orgAlias, params[id] ?? {})));
  const summary = {
    total: results.length,
    ok: results.filter((r) => r.status === 'ok').length,
    warn: results.filter((r) => r.status === 'warn').length,
    fail: results.filter((r) => r.status === 'fail').length,
    error: results.filter((r) => r.status === 'error').length,
  };
  return { timestamp: new Date().toISOString(), org: orgAlias, checks: results, summary };
}

function result(id, title, status, summary, findings) {
  return { id, title, status, summary, findings };
}

function errored(id, title, err) {
  return {
    id,
    title,
    status: 'error',
    summary: `Check failed: ${oneLine(err.message)}`,
    findings: [],
  };
}

function oneLine(s) {
  return String(s ?? '').replace(/[\r\n]+/g, ' ').slice(0, 300);
}
