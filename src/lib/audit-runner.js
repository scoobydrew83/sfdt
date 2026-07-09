import { ORG_HEALTH_THRESHOLDS } from '@sfdt/flow-core';
import { query, safeParse, toSoqlDate } from './org-query.js';

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
 * Usage/coverage/age thresholds come from the shared @sfdt/flow-core rulebook
 * (ORG_HEALTH_THRESHOLDS) so the CLI, GUI, and Chrome extension band findings
 * identically. NOTE: licenseWarnThreshold changed 0.9 → 0.75 here as part of
 * that unification — the CLI now warns at the same 75% point Chrome uses.
 * CLI-only knobs (auditTrailLookbackDays) have no shared equivalent and stay
 * local. These values are mirrored in src/templates/sfdt.config.json (under
 * `audit`), which remains the canonical config the user edits.
 */
export const AUDIT_DEFAULTS = {
  auditTrailLookbackDays: 30,
  licenseWarnThreshold: ORG_HEALTH_THRESHOLDS.usageAmber, // 0.75 (was 0.9 before flow-core unification)
  inactiveUserDays: ORG_HEALTH_THRESHOLDS.inactiveUserDays, // 90
  minApiVersion: ORG_HEALTH_THRESHOLDS.minApiVersionFloor, // 45
  fieldDescriptionMaxMissing: 0,
  connectedAppFlagPermissive: true,
  soapLoginLookbackDays: 30,
};

// SOAP login() retirement window: Salesforce is retiring the SOAP login() call
// on API versions 31.0 through 64.0. Traffic in this band must move to OAuth
// (or a current API version) before the retirement lands.
const SOAP_LOGIN_RETIREMENT = { minApi: 31, maxApi: 64 };

// Salesforce's Connected-Apps hardening: new Connected App installs are moving
// to default-off (blocked until an admin approves), and External Client Apps
// are the strategic successor. Surfaced whenever connected apps are found.
const ECA_MIGRATION_NOTE =
  'Salesforce is moving Connected Apps to default-off (blocked until admin-approved); plan migration to External Client Apps.';

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

// SOQL datetime literal helper (shared) — strips the milliseconds Salesforce rejects.
const ISODate = toSoqlDate;

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
    // NOTE: this returns a single page (~2000 rows). A server-side semi-join
    // (`User WHERE Id NOT IN (SELECT UserId FROM TwoFactorMethodsInfo)`) would be
    // ideal but Salesforce rejects it (INVALID_TYPE — not semi-join-able), so we
    // diff client-side; very large orgs may under-count enrolled users.
    // Both queries return a single SOQL page (~2000 rows). The two truncations
    // compound in opposite directions: a capped TwoFactorMethodsInfo over-reports
    // non-compliance (enrolled users past the cap look unenrolled), while a capped
    // User list under-reports it (non-enrolled users past the cap are invisible).
    // We can't reliably page both, so flag when either hits the cap.
    const PAGE = 2000;
    const mfaRows = await query(orgAlias, 'SELECT UserId FROM TwoFactorMethodsInfo');
    const enrolled = new Set(mfaRows.map((r) => r.UserId));
    // Active, human (non-integration) users.
    const users = await query(
      orgAlias,
      `SELECT Id, Username, Name, Profile.UserLicense.Name FROM User ` +
        `WHERE IsActive = true AND UserType = 'Standard' ORDER BY Name LIMIT ${PAGE}`,
    );
    const truncated = mfaRows.length >= PAGE || users.length >= PAGE;
    const findings = users
      .filter((u) => !enrolled.has(u.Id))
      .map((u) => ({ username: u.Username, name: u.Name, license: u.Profile?.UserLicense?.Name }));
    const truncNote = truncated
      ? ` (results truncated at ${PAGE} rows — MFA coverage count may be incomplete)`
      : '';
    return result(id, title, findings.length || truncated ? 'warn' : 'ok',
      (findings.length
        ? `${findings.length} active user(s) without a registered MFA method`
        : 'All active standard users have MFA registered') + truncNote,
      findings);
  } catch (err) {
    // TwoFactorMethodsInfo is permission-gated and unsupported in some orgs
    // (e.g. Dev Hub / Developer Edition returns INVALID_TYPE). A rejected query
    // means "this org can't run the check", not "the org is broken" — degrade to
    // warn so `audit all` doesn't fail CI over a missing API, matching
    // checkMfaReadiness which queries the same object.
    return degraded(id, title, err, 'MFA coverage (TwoFactorMethodsInfo)');
  }
}

/**
 * MFA enforcement readiness — active users who are not ready for Salesforce's
 * phishing-resistant MFA enforcement (July 2026): no MFA method registered at
 * all, or only non-phishing-resistant methods (TOTP / Salesforce Authenticator /
 * temporary code). Phishing-resistant = security key (HasSecurityKey for modern
 * WebAuthn registrations, HasU2F for legacy U2F ones) or built-in (platform)
 * authenticator (HasBuiltInAuthenticator), per TwoFactorMethodsInfo.
 *
 * TwoFactorMethodsInfo is queryable in most orgs but is permission-gated, so a
 * rejected query degrades to warn (never error) — a missing API must not fail CI.
 */
export async function checkMfaReadiness(orgAlias) {
  const id = 'mfa-readiness';
  const title = 'MFA enforcement readiness';
  try {
    // Same single-page caveat as checkMfa: both queries return one SOQL page
    // (~2000 rows) and Salesforce rejects the semi-join, so diff client-side and
    // flag when either result hits the cap.
    const PAGE = 2000;
    const methods = await query(
      orgAlias,
      'SELECT UserId, HasTotp, HasU2F, HasSecurityKey, HasBuiltInAuthenticator, HasSalesforceAuthenticator, HasTempCode FROM TwoFactorMethodsInfo',
    );
    const byUser = new Map();
    for (const m of methods) {
      const prev = byUser.get(m.UserId) ?? { any: false, phishingResistant: false };
      const phishingResistant =
        m.HasSecurityKey === true || m.HasU2F === true || m.HasBuiltInAuthenticator === true;
      byUser.set(m.UserId, {
        any: prev.any || phishingResistant || m.HasTotp === true ||
          m.HasSalesforceAuthenticator === true || m.HasTempCode === true,
        phishingResistant: prev.phishingResistant || phishingResistant,
      });
    }
    const users = await query(
      orgAlias,
      `SELECT Id, Username, Name FROM User WHERE IsActive = true AND UserType = 'Standard' ORDER BY Name LIMIT ${PAGE}`,
    );
    const truncated = methods.length >= PAGE || users.length >= PAGE;
    const findings = [];
    for (const u of users) {
      const reg = byUser.get(u.Id);
      if (!reg || !reg.any) {
        findings.push({ username: u.Username, name: u.Name, detail: 'No MFA method registered' });
      } else if (!reg.phishingResistant) {
        findings.push({
          username: u.Username,
          name: u.Name,
          detail: 'Only non-phishing-resistant MFA (TOTP/authenticator app/temp code) — no security key or built-in authenticator',
        });
      }
    }
    const truncNote = truncated
      ? ` (results truncated at ${PAGE} rows — readiness count may be incomplete)`
      : '';
    return result(id, title, findings.length || truncated ? 'warn' : 'ok',
      (findings.length
        ? `${findings.length} active user(s) not ready for Salesforce's phishing-resistant MFA enforcement (July 2026)`
        : `All active standard users have a phishing-resistant MFA method ahead of the July 2026 enforcement`) + truncNote,
      findings);
  } catch (err) {
    return degraded(id, title, err, 'MFA readiness (TwoFactorMethodsInfo)');
  }
}

/**
 * SOAP login() retirement — recent logins that used the SOAP login() call on a
 * retiring API version (31.0–64.0). LoginHistory's ApiType/ApiVersion fields
 * identify SOAP traffic; findings are aggregated per user + API version +
 * client application so one chatty integration doesn't flood the report.
 * LoginHistory is permission-gated in some orgs, so failures degrade to warn.
 */
export async function checkSoapLogins(orgAlias, { lookbackDays = AUDIT_DEFAULTS.soapLoginLookbackDays } = {}) {
  const id = 'soap-logins';
  const title = 'SOAP login() retirement';
  try {
    // lookbackDays is interpolated into SOQL and may come from user config —
    // coerce to a safe integer (the checkApiVersions pattern).
    const days = Number.parseInt(lookbackDays, 10);
    if (!Number.isFinite(days)) {
      throw new Error(`audit.soapLoginLookbackDays must be a number, got: ${lookbackDays}`);
    }
    const since = ISODate(Date.now() - days * DAY_MS);
    const rows = await query(
      orgAlias,
      `SELECT UserId, LoginTime, LoginType, ApiType, ApiVersion, Application FROM LoginHistory ` +
        `WHERE LoginTime >= ${since} AND ApiType LIKE 'SOAP%' ORDER BY LoginTime DESC LIMIT 2000`,
    );
    // Version banding is client-side: ApiVersion is returned as a string/decimal
    // and SOQL comparisons on it are unreliable across orgs.
    const { minApi, maxApi } = SOAP_LOGIN_RETIREMENT;
    const agg = new Map();
    for (const r of rows) {
      const v = Number.parseFloat(r.ApiVersion);
      if (!Number.isFinite(v) || v < minApi || v > maxApi) continue;
      const key = `${r.UserId}|${v}|${r.Application ?? ''}`;
      const entry = agg.get(key) ?? {
        userId: r.UserId,
        apiType: r.ApiType,
        apiVersion: v,
        application: r.Application ?? null,
        logins: 0,
        lastLogin: r.LoginTime,
      };
      entry.logins += 1;
      if (r.LoginTime > entry.lastLogin) entry.lastLogin = r.LoginTime;
      agg.set(key, entry);
    }
    const findings = [...agg.values()];
    const truncNote = rows.length >= 2000
      ? ' (login history truncated at 2000 rows — counts may be incomplete)'
      : '';
    return result(id, title, findings.length || rows.length >= 2000 ? 'warn' : 'ok',
      findings.length
        ? `${findings.length} client(s) used SOAP login() on retiring API versions ${minApi}.0–${maxApi}.0 in the last ${days} days — migrate to OAuth or a current API version before the retirement${truncNote}`
        : `No SOAP login() traffic on retiring API versions ${minApi}.0–${maxApi}.0 in the last ${days} days${truncNote}`,
      findings);
  } catch (err) {
    return degraded(id, title, err, 'SOAP login history (LoginHistory)');
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
    // Aggregate coverage per class id. Note: this returns at most one page
    // (~2000 rows); very large orgs may under-report coverage here.
    const coverage = await query(
      orgAlias,
      `SELECT ApexClassOrTriggerId, NumLinesCovered, NumLinesUncovered FROM ApexCodeCoverageAggregate`,
      { tooling: true },
    );
    // ApexCodeCoverageAggregate is empty until tests have been run in the org.
    // Without that data every class would look "uncovered", so don't flag a
    // storm of false positives — report that coverage data is unavailable.
    if (coverage.length === 0) {
      return result(id, title, 'warn',
        'No Apex code-coverage data in this org (run tests first); unused-class detection skipped', []);
    }
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

/**
 * Inactive flows — flow definitions with no active version (deactivated or
 * draft-only automations that clutter the org and can mask intent).
 */
export async function checkInactiveFlows(orgAlias) {
  const id = 'inactive-flows';
  const title = 'Inactive flows';
  try {
    const rows = await query(
      orgAlias,
      `SELECT DeveloperName, ActiveVersionId FROM FlowDefinition WHERE ActiveVersionId = null ORDER BY DeveloperName`,
      { tooling: true },
    );
    const findings = rows.map((r) => ({ name: r.DeveloperName }));
    return result(id, title, findings.length ? 'warn' : 'ok',
      findings.length
        ? `${findings.length} flow(s) with no active version`
        : 'All flow definitions have an active version',
      findings);
  } catch (err) {
    return errored(id, title, err);
  }
}

/**
 * Unused permission sets — custom permission sets (not profile-owned) with no
 * user assignments, directly or via an assigned permission set group. Mirrors
 * the client-side diff used by checkMfa because Salesforce rejects the semi-join
 * (PermissionSet WHERE Id NOT IN (SELECT PermissionSetId FROM
 * PermissionSetAssignment)).
 */
export async function checkUnusedPermsets(orgAlias) {
  const id = 'unused-permsets';
  const title = 'Unused permission sets';
  try {
    const assignments = await query(orgAlias, 'SELECT PermissionSetId FROM PermissionSetAssignment');
    const assigned = new Set(assignments.map((a) => a.PermissionSetId));
    // A permission set used only inside an assigned permission set group has no
    // direct PermissionSetAssignment row, so fold in group membership to avoid
    // false positives.
    const groupComponents = await query(orgAlias, 'SELECT PermissionSetId FROM PermissionSetGroupComponent');
    for (const g of groupComponents) assigned.add(g.PermissionSetId);
    const permsets = await query(
      orgAlias,
      `SELECT Id, Name, Label FROM PermissionSet WHERE IsOwnedByProfile = false ORDER BY Name`,
    );
    const findings = permsets
      .filter((p) => !assigned.has(p.Id))
      .map((p) => ({ name: p.Label || p.Name }));
    return result(id, title, findings.length ? 'warn' : 'ok',
      findings.length
        ? `${findings.length} permission set(s) with no user assignments`
        : 'All custom permission sets are assigned',
      findings);
  } catch (err) {
    return errored(id, title, err);
  }
}

/**
 * Connected apps review — surfaces connected apps that permit all users (admin
 * approval not required), which widens the integration attack surface.
 */
export async function checkConnectedApps(orgAlias, { flagPermissive = AUDIT_DEFAULTS.connectedAppFlagPermissive } = {}) {
  const id = 'connected-apps';
  const title = 'Connected apps review';
  try {
    const rows = await query(
      orgAlias,
      `SELECT Name, OptionsAllowAdminApprovedUsersOnly FROM ConnectedApplication ORDER BY Name`,
    );
    const findings = flagPermissive
      ? rows
          .filter((r) => r.OptionsAllowAdminApprovedUsersOnly === false)
          .map((r) => ({
            name: r.Name,
            detail: 'All users permitted (admin approval not required)',
            recommendation: 'Migrate to an External Client App',
          }))
      : [];
    // Additive context only — the ok/warn banding above is unchanged. Whenever
    // the org has connected apps at all, note the default-off direction and the
    // External Client Apps migration path.
    const note = rows.length ? ` Note: ${ECA_MIGRATION_NOTE}` : '';
    return result(id, title, findings.length ? 'warn' : 'ok',
      (findings.length
        ? `${findings.length} connected app(s) permit all users`
        : `${rows.length} connected app(s); none flagged`) + note,
      findings);
  } catch (err) {
    // ConnectedApplication is not queryable for every user/permission set.
    return degraded(id, title, err, 'Connected apps review');
  }
}

/**
 * Missing field descriptions — custom fields without a Description, which hurts
 * maintainability and auto-generated docs. Capped to keep the Tooling query
 * bounded; very large orgs may under-count (documented).
 */
export async function checkFieldDescriptions(orgAlias, { maxMissing = AUDIT_DEFAULTS.fieldDescriptionMaxMissing } = {}) {
  const id = 'field-descriptions';
  const title = 'Missing field descriptions';
  try {
    const rows = await query(
      orgAlias,
      `SELECT DeveloperName, TableEnumOrId FROM CustomField WHERE NamespacePrefix = null AND Description = null ORDER BY TableEnumOrId LIMIT 2000`,
      { tooling: true },
    );
    const findings = rows.map((r) => ({ name: `${r.TableEnumOrId}.${r.DeveloperName}` }));
    const over = findings.length > maxMissing;
    return result(id, title, over ? 'warn' : 'ok',
      over
        ? `${findings.length} custom field(s) missing a description (threshold ${maxMissing})`
        : `${findings.length} custom field(s) missing a description (within threshold ${maxMissing})`,
      findings);
  } catch (err) {
    return errored(id, title, err);
  }
}

/**
 * Unreferenced Apex — non-test classes that no other metadata component depends
 * on (Tooling MetadataComponentDependency). Complements the coverage-based
 * `unused-apex` heuristic with a dependency-graph view.
 */
export async function checkApexUnreferenced(orgAlias) {
  const id = 'apex-unreferenced';
  const title = 'Unreferenced Apex';
  try {
    const classes = await query(
      orgAlias,
      `SELECT Name FROM ApexClass WHERE NamespacePrefix = null ORDER BY Name`,
      { tooling: true },
    );
    const deps = await query(
      orgAlias,
      `SELECT RefMetadataComponentName FROM MetadataComponentDependency WHERE RefMetadataComponentType = 'ApexClass'`,
      { tooling: true },
    );
    // MetadataComponentDependency is empty/unsupported in some orgs; without it
    // every class would look unreferenced, so skip rather than false-positive.
    if (deps.length === 0) {
      return result(id, title, 'warn',
        'No dependency data available (MetadataComponentDependency empty or unsupported); unreferenced-Apex detection skipped', []);
    }
    const referenced = new Set(deps.map((d) => d.RefMetadataComponentName));
    const findings = classes
      .filter((c) => !/(^test|test$)/i.test(c.Name) && !referenced.has(c.Name))
      .map((c) => ({ name: c.Name }));
    return result(id, title, findings.length ? 'warn' : 'ok',
      findings.length
        ? `${findings.length} Apex class(es) not referenced by any component (review for removal)`
        : 'All Apex classes are referenced',
      findings);
  } catch (err) {
    // MetadataComponentDependency is a Beta Tooling object with limited WHERE
    // support and isn't available/queryable in every org.
    return degraded(id, title, err, 'Dependency analysis');
  }
}

/**
 * Object access lint — custom objects that have permission entries but grant
 * Read to nobody. Objects-only heuristic via ObjectPermissions aggregation;
 * full field-level lint is deferred to a later phase. Objects with NO permission
 * rows at all are not surfaced here (a separate, known gap).
 */
export async function checkLintAccess(orgAlias) {
  const id = 'lint-access';
  const title = 'Object access';
  try {
    // Filter custom objects client-side: SOQL LIKE treats '_' as a wildcard, so
    // a `LIKE '%__c'` filter would over-match — fetch grants and match the
    // literal '__c' suffix in JS instead.
    const rows = await query(orgAlias, `SELECT SobjectType, PermissionsRead FROM ObjectPermissions`);
    const custom = rows.filter((r) => typeof r.SobjectType === 'string' && r.SobjectType.endsWith('__c'));
    if (custom.length === 0) {
      return result(id, title, 'ok', 'No custom-object permission entries to evaluate', []);
    }
    const readByType = new Map();
    for (const r of custom) {
      readByType.set(r.SobjectType, (readByType.get(r.SobjectType) || false) || r.PermissionsRead === true);
    }
    const findings = [...readByType.entries()]
      .filter(([, hasRead]) => !hasRead)
      .map(([type]) => ({ name: type, detail: 'No profile or permission set grants Read' }));
    return result(id, title, findings.length ? 'warn' : 'ok',
      findings.length
        ? `${findings.length} custom object(s) with no Read access granted`
        : 'All custom objects with permission entries grant Read',
      findings);
  } catch (err) {
    return errored(id, title, err);
  }
}

/**
 * Inactive validation rules. ValidationRule is Tooling-queryable with an Active
 * flag, so this is a fast SOQL check (no metadata retrieve needed).
 */
export async function checkInactiveValidations(orgAlias) {
  const id = 'inactive-validations';
  const title = 'Inactive validation rules';
  try {
    const rows = await query(
      orgAlias,
      `SELECT ValidationName, EntityDefinition.QualifiedApiName FROM ValidationRule WHERE Active = false ORDER BY ValidationName`,
      { tooling: true },
    );
    const findings = rows.map((r) => ({
      name: `${r.EntityDefinition?.QualifiedApiName ?? '?'}.${r.ValidationName}`,
    }));
    return result(id, title, findings.length ? 'warn' : 'ok',
      findings.length
        ? `${findings.length} inactive validation rule(s)`
        : 'All validation rules are active',
      findings);
  } catch (err) {
    return degraded(id, title, err, 'Validation rule status');
  }
}

/**
 * Inactive workflow rules. Workflow rules are a legacy (deprecated) automation;
 * WorkflowRule's Active field is not queryable in every org, so this attempts a
 * Tooling query and degrades gracefully: an org without the workflow feature
 * rejects WorkflowRule outright (treated as "none"), other failures degrade to warn.
 */
export async function checkInactiveWorkflows(orgAlias) {
  const id = 'inactive-workflows';
  const title = 'Inactive workflow rules';
  try {
    const rows = await query(
      orgAlias,
      `SELECT Name, TableEnumOrId, Active FROM WorkflowRule WHERE Active = false ORDER BY Name`,
      { tooling: true },
    );
    const findings = rows.map((r) => ({ name: `${r.TableEnumOrId}.${r.Name}` }));
    return result(id, title, findings.length ? 'warn' : 'ok',
      findings.length ? `${findings.length} inactive workflow rule(s)` : 'No inactive workflow rules',
      findings);
  } catch (err) {
    // "Cannot use: WorkflowRule in this organization" (INVALID_TYPE) means the
    // org simply has no workflow rules — that's fine, report ok.
    if (/cannot use|invalid_type/i.test(String(err?.message || ''))) {
      return result(id, title, 'ok', 'No workflow rules in this org', []);
    }
    return degraded(id, title, err, 'Workflow rule status');
  }
}

/**
 * Field access lint — custom fields that grant Read to no profile or permission
 * set (via FieldPermissions). Complements the object-level `lint-access` check.
 * Client-side aggregation (the checkMfa diff pattern). Note: `sf data query`
 * auto-paginates, but FieldPermissions is large in big orgs — this scans every
 * FLS grant row.
 */
export async function checkLintAccessFields(orgAlias) {
  const id = 'lint-access-fields';
  const title = 'Field access';
  try {
    const rows = await query(orgAlias, `SELECT Field, PermissionsRead FROM FieldPermissions`);
    // FieldPermissions.Field is "SObject.FieldApiName"; custom fields end in __c.
    const custom = rows.filter((r) => typeof r.Field === 'string' && r.Field.endsWith('__c'));
    if (custom.length === 0) {
      return result(id, title, 'ok', 'No custom-field permission entries to evaluate', []);
    }
    const readByField = new Map();
    for (const r of custom) {
      readByField.set(r.Field, (readByField.get(r.Field) || false) || r.PermissionsRead === true);
    }
    const findings = [...readByField.entries()]
      .filter(([, hasRead]) => !hasRead)
      .map(([field]) => ({ name: field, detail: 'No profile or permission set grants Read' }));
    return result(id, title, findings.length ? 'warn' : 'ok',
      findings.length
        ? `${findings.length} custom field(s) with no Read access granted`
        : 'All custom fields with permission entries grant Read',
      findings);
  } catch (err) {
    return degraded(id, title, err, 'Field access lint');
  }
}

export const CHECKS = {
  audittrail: checkAuditTrail,
  licenses: checkLicenses,
  mfa: checkMfa,
  'mfa-readiness': checkMfaReadiness,
  'soap-logins': checkSoapLogins,
  'unused-apex': checkUnusedApex,
  'inactive-users': checkInactiveUsers,
  'api-versions': checkApiVersions,
  'inactive-flows': checkInactiveFlows,
  'unused-permsets': checkUnusedPermsets,
  'connected-apps': checkConnectedApps,
  'field-descriptions': checkFieldDescriptions,
  'apex-unreferenced': checkApexUnreferenced,
  'lint-access': checkLintAccess,
  'inactive-validations': checkInactiveValidations,
  'inactive-workflows': checkInactiveWorkflows,
  'lint-access-fields': checkLintAccessFields,
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
  // Mirror monitor-runner: prefer sf's structured JSON error message (from
  // stdout or stderr) over the opaque execa string. Today all audit checks go
  // through query() (which already rethrows with the structured message), but
  // keeping the two errored() helpers symmetric guards against a future check
  // that calls execa directly.
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
 * Soft failure for checks that query a Beta / license-gated / permission-gated
 * object (e.g. MetadataComponentDependency, ConnectedApplication): a query
 * failure there usually means "this org can't run the check", not "the org is
 * broken". Surface a `warn` so `audit all` doesn't exit non-zero (red CI) over a
 * missing API, while never reading as a clean `ok`. Mirrors checkDeprecatedApi
 * in monitor-runner.
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

function oneLine(s) {
  return String(s ?? '').replace(/[\r\n]+/g, ' ').slice(0, 300);
}
