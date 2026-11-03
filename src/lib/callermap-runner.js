import { query, toSoqlDate } from './org-query.js';
import { oneLine } from './check-result.js';

/**
 * `sfdt audit callermap --probe` — find out which login and API-usage data an
 * org exposes before the caller inventory is built on top of it.
 *
 * Read-only: every source is a SELECT with a LIMIT. Nothing is written to the
 * org or to disk. The result holds counts, Salesforce field names and picklist
 * values only — no user IDs, app names, IP addresses or other org records — so
 * the org data in it is safe to paste into an issue. The org alias and sf error
 * messages are passed through as-is and can name the org or its username.
 */

export const CALLERMAP_DEFAULTS = { lookbackDays: 30, maxLookbackDays: 180 };

const ROW_LIMIT = 2000;

/** Salesforce returns these when a field or relationship does not exist on the object. */
const MISSING_FIELD = /INVALID_FIELD|No such column|Didn't understand relationship/i;

const isApiLogin = (r) => !!r.ApiType && r.ApiType !== 'N/A';
const hasValue = (v) => v != null && v !== '' && v !== 'N/A';
const distinct = (values) => new Set(values.filter(hasValue)).size;
/**
 * Strip control characters (C0, DEL, C1) from an org-derived string, so nothing
 * odd reaches a terminal, a JSON consumer or a pasted report. Exported so every
 * output path uses the same rule.
 */
export const stripControl = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
/** One-line, control-free text of an error, as stored in a source's `error`. */
// Control characters become spaces (so `INVALID\tFIELD` stays two words), and
// the result is cleaned before `oneLine` caps its length.
const errorText = (err) => oneLine(String(err?.message ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')).replace(/ {2,}/g, ' ').trim();
const tally = (values) => {
  const out = {};
  for (const v of values) {
    // Clean first, so a value made only of control characters reads as blank.
    const cleaned = v == null ? v : stripControl(v);
    const key = hasValue(cleaned) ? cleaned : '(blank)';
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
};
const get = (record, dotted) => dotted.split('.').reduce((o, k) => (o == null ? o : o[k]), record);

/** ApiTotalUsage columns that could name or classify the calling app. */
const APP_COLUMNS = ['API_CLIENT_CATEGORY', 'CONNECTED_APP_ID', 'CONNECTED_APP_NAME', 'CLIENT_NAME', 'USER_ID', 'CLIENT_IP'];

/**
 * Each source is one read-only query. `fields` are probed one by one when the
 * full query is rejected for a missing field, so the report names exactly which
 * fields this org lacks. `stats` turns records into counts — never raw values
 * that identify a user, app or address. `has(field)` says whether a field was
 * readable: a stat built on a missing field is `null` (unknown), never a
 * misleading zero.
 */
export const PROBE_SOURCES = [
  {
    id: 'login-history',
    object: 'LoginHistory',
    purpose: 'Who logs in, through which API and version, and from which app',
    fields: ['UserId', 'LoginTime', 'LoginType', 'LoginSubType', 'ApiType', 'ApiVersion', 'Application', 'ClientVersion', 'Platform', 'SourceIp', 'Status'],
    where: ({ since }) => `LoginTime >= ${since}`,
    orderBy: 'LoginTime DESC',
    orderByField: 'LoginTime',
    limit: ROW_LIMIT,
    stats: (rows, _ctx, has) => {
      const api = has('ApiType') ? rows.filter(isApiLogin) : null;
      const app = has('Application');
      return {
        rows: rows.length,
        apiLogins: api ? api.length : null,
        apiLoginsWithApplication: api && app ? api.filter((r) => hasValue(r.Application)).length : null,
        distinctApplications: api && app ? distinct(api.map((r) => r.Application)) : null,
        apiTypes: api ? tally(api.map((r) => r.ApiType)) : null,
        loginTypes: has('LoginType') ? tally(rows.map((r) => r.LoginType)) : null,
        loginSubTypes: has('LoginSubType') ? tally(rows.map((r) => r.LoginSubType)) : null,
      };
    },
  },
  {
    id: 'oauth-tokens',
    object: 'OauthToken',
    purpose: 'Connected app usage per user: last used and use count',
    fields: ['AppName', 'UserId', 'LastUsedDate', 'UseCount', 'CreatedDate'],
    orderBy: 'LastUsedDate DESC NULLS LAST',
    orderByField: 'LastUsedDate',
    limit: ROW_LIMIT,
    stats: (rows, { sinceMs }, has) => ({
      rows: rows.length,
      distinctApps: has('AppName') ? distinct(rows.map((r) => r.AppName)) : null,
      rowsWithLastUsed: has('LastUsedDate') ? rows.filter((r) => hasValue(r.LastUsedDate)).length : null,
      usedInWindow: has('LastUsedDate') ? rows.filter((r) => hasValue(r.LastUsedDate) && Date.parse(r.LastUsedDate) >= sinceMs).length : null,
      rowsWithUseCount: has('UseCount') ? rows.filter((r) => typeof r.UseCount === 'number').length : null,
    }),
  },
  {
    id: 'api-permission',
    object: 'PermissionSet',
    purpose: 'Permission sets and profiles that grant API access, and the newer "Use Any API Client" permission',
    fields: ['IsOwnedByProfile', 'PermissionsApiEnabled', 'PermissionsUseAnyApiClient'],
    where: () => 'PermissionsApiEnabled = true',
    limit: ROW_LIMIT,
    stats: (rows, _ctx, has) => ({
      apiEnabledPermsets: has('IsOwnedByProfile') ? rows.filter((r) => !r.IsOwnedByProfile).length : null,
      apiEnabledProfiles: has('IsOwnedByProfile') ? rows.filter((r) => r.IsOwnedByProfile).length : null,
      withUseAnyApiClient: has('PermissionsUseAnyApiClient') ? rows.filter((r) => r.PermissionsUseAnyApiClient).length : null,
    }),
  },
  {
    id: 'api-permission-assignments',
    object: 'PermissionSetAssignment',
    purpose: 'Active users who hold API access, with and without "Use Any API Client"',
    fields: ['AssigneeId', 'PermissionSet.IsOwnedByProfile', 'PermissionSet.PermissionsApiEnabled', 'PermissionSet.PermissionsUseAnyApiClient'],
    // A user can get API access from one profile or permission set and "Use Any
    // API Client" from another, so fetch both kinds of grant and combine them per
    // user in `stats`. When the newer permission doesn't exist, filter on API
    // access alone so the query stays valid.
    where: (_ctx, fields) =>
      fields.includes('PermissionSet.PermissionsUseAnyApiClient')
        ? 'Assignee.IsActive = true AND (PermissionSet.PermissionsApiEnabled = true OR PermissionSet.PermissionsUseAnyApiClient = true)'
        : 'Assignee.IsActive = true AND PermissionSet.PermissionsApiEnabled = true',
    limit: ROW_LIMIT,
    stats: (rows, _ctx, has) => {
      if (!has('AssigneeId') || !has('PermissionSet.PermissionsApiEnabled')) {
        return { activeApiUsers: null, withUseAnyApiClient: null, withoutUseAnyApiClient: null };
      }
      const apiUsers = new Set(rows.filter((r) => r.PermissionSet?.PermissionsApiEnabled).map((r) => r.AssigneeId));
      if (!has('PermissionSet.PermissionsUseAnyApiClient')) {
        return { activeApiUsers: apiUsers.size, withUseAnyApiClient: null, withoutUseAnyApiClient: null };
      }
      const clientUsers = new Set(rows.filter((r) => r.PermissionSet?.PermissionsUseAnyApiClient).map((r) => r.AssigneeId));
      const withClient = [...apiUsers].filter((u) => clientUsers.has(u)).length;
      return { activeApiUsers: apiUsers.size, withUseAnyApiClient: withClient, withoutUseAnyApiClient: apiUsers.size - withClient };
    },
  },
  {
    id: 'users',
    object: 'User',
    purpose: 'Active users by license and profile, to spot integration users on admin profiles',
    fields: ['UserType', 'Profile.Name', 'Profile.UserLicense.Name', 'Profile.PermissionsApiUserOnly', 'Profile.PermissionsModifyAllData'],
    where: () => 'IsActive = true',
    limit: ROW_LIMIT,
    stats: (rows, _ctx, has) => {
      const admin = (r) => get(r, 'Profile.Name') === 'System Administrator' || get(r, 'Profile.PermissionsModifyAllData') === true;
      const apiOnly = (r) => get(r, 'Profile.PermissionsApiUserOnly') === true;
      const integrationLicense = (r) => /integration/i.test(get(r, 'Profile.UserLicense.Name') ?? '');
      const canAdmin = has('Profile.Name') || has('Profile.PermissionsModifyAllData');
      const canApiOnly = has('Profile.PermissionsApiUserOnly');
      const canLicense = has('Profile.UserLicense.Name');
      const countIf = (ok, pred) => (ok ? rows.filter(pred).length : null);
      return {
        activeUsers: rows.length,
        userTypes: has('UserType') ? tally(rows.map((r) => r.UserType)) : null,
        onAdminProfile: countIf(canAdmin, admin),
        apiOnlyOnAdminProfile: countIf(canAdmin && canApiOnly, (r) => admin(r) && apiOnly(r)),
        integrationLicense: countIf(canLicense, integrationLicense),
        integrationLicenseOnAdminProfile: countIf(canAdmin && canLicense, (r) => admin(r) && integrationLicense(r)),
      };
    },
  },
  {
    id: 'api-total-usage',
    object: 'EventLogFile',
    purpose: 'ApiTotalUsage event logs (free tier keeps one day) and whether they classify AI and MCP clients',
    fields: ['EventType', 'LogDate', 'Interval', 'LogFileLength', 'LogFileFieldNames'],
    where: () => "EventType = 'ApiTotalUsage'",
    orderBy: 'LogDate DESC',
    orderByField: 'LogDate',
    limit: 7,
    stats: (rows, _ctx, has) => {
      if (!has('LogFileFieldNames')) {
        return { logFiles: rows.length, newestLogDate: has('LogDate') ? rows[0]?.LogDate ?? null : null, columnsFromLogDate: null, columns: null, appColumnsPresent: null, hasApiClientCategory: null };
      }
      // The newest log can still be generating with no field names yet, so use
      // the first log that lists its columns.
      const withNames = rows.find((r) => String(r.LogFileFieldNames ?? '').trim());
      const columns = String(withNames?.LogFileFieldNames ?? '')
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean);
      return {
        logFiles: rows.length,
        newestLogDate: rows[0]?.LogDate ?? null,
        // The columns can come from an older log than the newest one; say which.
        columnsFromLogDate: withNames?.LogDate ?? null,
        columns: columns.length,
        appColumnsPresent: APP_COLUMNS.filter((c) => columns.includes(c)),
        hasApiClientCategory: columns.includes('API_CLIENT_CATEGORY'),
      };
    },
  },
];

export function buildSoql(source, fields, ctx) {
  let soql = `SELECT ${fields.join(', ')} FROM ${source.object}`;
  if (source.where) soql += ` WHERE ${source.where(ctx, fields)}`;
  // Sort only when the sort field is in the readable set, or a partial source
  // would fail again on its ORDER BY.
  if (source.orderBy && fields.includes(source.orderByField)) soql += ` ORDER BY ${source.orderBy}`;
  if (source.limit) soql += ` LIMIT ${source.limit}`;
  return soql;
}

/**
 * Probe one source. A rejected query is retried field by field only when the
 * error says a field is missing; any other error (object not supported, no
 * access) means the whole source is unreadable in this org.
 */
export async function probeSource(orgAlias, source, ctx, { queryFn = query } = {}) {
  const base = { id: source.id, object: source.object, purpose: source.purpose };
  const run = async (fields) => {
    const soql = buildSoql(source, fields, ctx);
    const rows = await queryFn(orgAlias, soql);
    return { soql, rows };
  };

  let firstError;
  try {
    const { soql, rows } = await run(source.fields);
    return { ...base, status: 'readable', soql, fieldsReadable: [...source.fields], fieldsMissing: [], truncated: rows.length >= source.limit, stats: source.stats(rows, ctx, () => true) };
  } catch (err) {
    firstError = err;
    if (!MISSING_FIELD.test(err?.message ?? '')) {
      return { ...base, status: 'unreadable', soql: buildSoql(source, source.fields, ctx), fieldsReadable: [], fieldsMissing: [], error: errorText(err), stats: null };
    }
  }

  const fieldsReadable = [];
  const fieldsMissing = [];
  for (const field of source.fields) {
    try {
      await queryFn(orgAlias, `SELECT ${field} FROM ${source.object} LIMIT 1`);
      fieldsReadable.push(field);
    } catch (err) {
      // Only a missing-field error means the field is absent. Anything else
      // (timeout, expired session, rate limit) would make the report list real
      // fields as missing, so stop and report the source as unreadable instead.
      if (!MISSING_FIELD.test(err?.message ?? '')) {
        return { ...base, status: 'unreadable', soql: buildSoql(source, source.fields, ctx), fieldsReadable: [], fieldsMissing: [], error: errorText(err), stats: null };
      }
      fieldsMissing.push(field);
    }
  }
  if (!fieldsReadable.length) {
    return { ...base, status: 'unreadable', soql: buildSoql(source, source.fields, ctx), fieldsReadable, fieldsMissing, error: 'None of the probed fields are readable', stats: null };
  }
  if (!fieldsMissing.length) {
    // Every selected field exists, so the rejection came from elsewhere in the
    // query (e.g. a WHERE field). Report the original error rather than retry.
    return { ...base, status: 'unreadable', soql: buildSoql(source, source.fields, ctx), fieldsReadable, fieldsMissing, error: errorText(firstError), stats: null };
  }
  try {
    const { soql, rows } = await run(fieldsReadable);
    return { ...base, status: 'partial', soql, fieldsReadable, fieldsMissing, truncated: rows.length >= source.limit, stats: source.stats(rows, ctx, (f) => fieldsReadable.includes(f)) };
  } catch (err) {
    // The WHERE clause itself can reference a missing field.
    return { ...base, status: 'unreadable', soql: buildSoql(source, fieldsReadable, ctx), fieldsReadable, fieldsMissing, error: errorText(err), stats: null };
  }
}

/**
 * The biggest risk in the caller inventory: can the org's data name the app
 * behind each API login? A heuristic over the probe results, labeled as such.
 */
export function assessAppNaming(sources) {
  const by = Object.fromEntries(sources.map((s) => [s.id, s]));
  const lh = by['login-history'];
  const oauth = by['oauth-tokens'];
  const elf = by['api-total-usage'];

  // Each signal is null when its source or field could not be read, so a
  // missing field reads as "unknown", never as "names nothing".
  const signals = [];
  let coverage = null;
  const lhStats = lh?.stats;
  if (!lhStats) {
    signals.push('LoginHistory is not readable');
  } else if (lhStats.apiLogins == null) {
    signals.push('LoginHistory.ApiType is not readable, so API logins cannot be told apart');
  } else if (lhStats.apiLogins === 0) {
    signals.push('LoginHistory has no API logins in the window');
  } else if (lhStats.apiLoginsWithApplication == null) {
    signals.push('LoginHistory.Application is not readable');
  } else {
    coverage = lhStats.apiLoginsWithApplication / lhStats.apiLogins;
    signals.push(`LoginHistory names an application on ${Math.round(coverage * 100)}% of ${lhStats.apiLogins} API logins`);
    if (lh.truncated) signals.push('LoginHistory hit its row limit, so coverage covers only the newest logins');
  }

  const oauthApps = oauth?.stats ? oauth.stats.distinctApps : null;
  if (!oauth?.stats) signals.push('OauthToken is not readable');
  else if (oauthApps == null) signals.push('OauthToken.AppName is not readable');
  else signals.push(`OauthToken lists ${oauthApps} connected app(s)`);

  const elfCols = elf?.stats?.appColumnsPresent ?? null;
  if (!elf?.stats) signals.push('EventLogFile is not readable');
  else if (!elf.stats.logFiles) signals.push('No ApiTotalUsage log files available');
  else if (elfCols == null) signals.push('EventLogFile.LogFileFieldNames is not readable');
  else signals.push(`ApiTotalUsage log columns that identify callers: ${elfCols.length ? elfCols.join(', ') : 'none'}`);

  const elfNamesApp = (elfCols ?? []).some((c) => c !== 'USER_ID' && c !== 'CLIENT_IP');
  let verdict;
  // A capped sample only covers the newest logins; an older integration that
  // never sets Application could be missing, so it can't support a plain "yes".
  if (coverage != null && coverage >= 0.8 && !lh.truncated) verdict = 'yes';
  else if ((coverage ?? 0) > 0 || (oauthApps ?? 0) > 0 || elfNamesApp) verdict = 'partly';
  else if (coverage === 0 && oauthApps === 0) verdict = 'no';
  else verdict = 'unknown';

  return { verdict, heuristic: true, signals };
}

/**
 * Run every probe source against one org. Sources run one after another so a
 * large org is not hit with parallel 2,000-row queries.
 */
export async function runCallermapProbe(orgAlias, { lookbackDays = CALLERMAP_DEFAULTS.lookbackDays, now = Date.now(), queryFn = query } = {}) {
  const sinceMs = now - lookbackDays * 24 * 60 * 60 * 1000;
  const ctx = { since: toSoqlDate(sinceMs), sinceMs, lookbackDays };
  const sources = [];
  for (const source of PROBE_SOURCES) {
    sources.push(await probeSource(orgAlias, source, ctx, { queryFn }));
  }
  const count = (status) => sources.filter((s) => s.status === status).length;
  return {
    probe: true,
    timestamp: new Date(now).toISOString(),
    org: orgAlias,
    lookbackDays,
    sources,
    appNaming: assessAppNaming(sources),
    summary: { total: sources.length, readable: count('readable'), partial: count('partial'), unreadable: count('unreadable') },
  };
}
