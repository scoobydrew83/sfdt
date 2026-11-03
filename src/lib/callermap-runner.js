import { query, toSoqlDate } from './org-query.js';
import { oneLine } from './check-result.js';

/**
 * `sfdt audit callermap --probe` — find out which login and API-usage data an
 * org exposes before the caller inventory is built on top of it.
 *
 * Read-only: every source is a SELECT with a LIMIT. Nothing is written to the
 * org or to disk. The result holds counts, Salesforce field names and picklist
 * values only — no user IDs, app names, IP addresses or other org records — so
 * it is safe to paste into an issue.
 */

export const CALLERMAP_DEFAULTS = { lookbackDays: 30, maxLookbackDays: 180 };

const ROW_LIMIT = 2000;

/** Salesforce returns these when a field or relationship does not exist on the object. */
const MISSING_FIELD = /INVALID_FIELD|No such column|Didn't understand relationship/i;

const isApiLogin = (r) => !!r.ApiType && r.ApiType !== 'N/A';
const hasValue = (v) => v != null && v !== '' && v !== 'N/A';
const distinct = (values) => new Set(values.filter(hasValue)).size;
const tally = (values) => {
  const out = {};
  for (const v of values) {
    const key = hasValue(v) ? String(v) : '(blank)';
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
 * that identify a user, app or address.
 */
export const PROBE_SOURCES = [
  {
    id: 'login-history',
    object: 'LoginHistory',
    purpose: 'Who logs in, through which API and version, and from which app',
    fields: ['UserId', 'LoginTime', 'LoginType', 'LoginSubType', 'ApiType', 'ApiVersion', 'Application', 'ClientVersion', 'Platform', 'SourceIp', 'Status'],
    where: ({ since }) => `LoginTime >= ${since}`,
    orderBy: 'LoginTime DESC',
    limit: ROW_LIMIT,
    stats: (rows) => {
      const api = rows.filter(isApiLogin);
      const named = api.filter((r) => hasValue(r.Application));
      return {
        rows: rows.length,
        apiLogins: api.length,
        apiLoginsWithApplication: named.length,
        distinctApplications: distinct(api.map((r) => r.Application)),
        apiTypes: tally(api.map((r) => r.ApiType)),
        loginTypes: tally(rows.map((r) => r.LoginType)),
        loginSubTypes: tally(rows.map((r) => r.LoginSubType)),
      };
    },
  },
  {
    id: 'oauth-tokens',
    object: 'OauthToken',
    purpose: 'Connected app usage per user: last used and use count',
    fields: ['AppName', 'UserId', 'LastUsedDate', 'UseCount', 'CreatedDate'],
    orderBy: 'LastUsedDate DESC NULLS LAST',
    limit: ROW_LIMIT,
    stats: (rows, { sinceMs }) => ({
      rows: rows.length,
      distinctApps: distinct(rows.map((r) => r.AppName)),
      rowsWithLastUsed: rows.filter((r) => hasValue(r.LastUsedDate)).length,
      usedInWindow: rows.filter((r) => hasValue(r.LastUsedDate) && Date.parse(r.LastUsedDate) >= sinceMs).length,
      rowsWithUseCount: rows.filter((r) => typeof r.UseCount === 'number').length,
    }),
  },
  {
    id: 'api-permission',
    object: 'PermissionSet',
    purpose: 'Permission sets and profiles that grant API access, and the newer "Use Any API Client" permission',
    fields: ['IsOwnedByProfile', 'PermissionsApiEnabled', 'PermissionsUseAnyApiClient'],
    where: () => 'PermissionsApiEnabled = true',
    limit: ROW_LIMIT,
    stats: (rows) => ({
      apiEnabledPermsets: rows.filter((r) => !r.IsOwnedByProfile).length,
      apiEnabledProfiles: rows.filter((r) => r.IsOwnedByProfile).length,
      withUseAnyApiClient: rows.some((r) => 'PermissionsUseAnyApiClient' in r)
        ? rows.filter((r) => r.PermissionsUseAnyApiClient).length
        : null,
    }),
  },
  {
    id: 'api-permission-assignments',
    object: 'PermissionSetAssignment',
    purpose: 'Active users who hold API access, with and without "Use Any API Client"',
    fields: ['AssigneeId', 'PermissionSet.IsOwnedByProfile', 'PermissionSet.PermissionsUseAnyApiClient'],
    where: () => 'Assignee.IsActive = true AND PermissionSet.PermissionsApiEnabled = true',
    limit: ROW_LIMIT,
    stats: (rows) => {
      const users = new Set(rows.map((r) => r.AssigneeId));
      const readable = rows.some((r) => r.PermissionSet && 'PermissionsUseAnyApiClient' in r.PermissionSet);
      const withClient = new Set(rows.filter((r) => r.PermissionSet?.PermissionsUseAnyApiClient).map((r) => r.AssigneeId));
      return {
        activeApiUsers: users.size,
        withUseAnyApiClient: readable ? withClient.size : null,
        withoutUseAnyApiClient: readable ? users.size - withClient.size : null,
      };
    },
  },
  {
    id: 'users',
    object: 'User',
    purpose: 'Active users by license and profile, to spot integration users on admin profiles',
    fields: ['UserType', 'Profile.Name', 'Profile.UserLicense.Name', 'Profile.PermissionsApiUserOnly', 'Profile.PermissionsModifyAllData'],
    where: () => 'IsActive = true',
    limit: ROW_LIMIT,
    stats: (rows) => {
      const admin = (r) => get(r, 'Profile.Name') === 'System Administrator' || get(r, 'Profile.PermissionsModifyAllData') === true;
      const apiOnly = (r) => get(r, 'Profile.PermissionsApiUserOnly') === true;
      const integrationLicense = (r) => /integration/i.test(get(r, 'Profile.UserLicense.Name') ?? '');
      return {
        activeUsers: rows.length,
        userTypes: tally(rows.map((r) => r.UserType)),
        onAdminProfile: rows.filter(admin).length,
        apiOnlyOnAdminProfile: rows.filter((r) => admin(r) && apiOnly(r)).length,
        integrationLicense: rows.filter(integrationLicense).length,
        integrationLicenseOnAdminProfile: rows.filter((r) => admin(r) && integrationLicense(r)).length,
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
    limit: 7,
    stats: (rows) => {
      const columns = String(rows[0]?.LogFileFieldNames ?? '')
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean);
      return {
        logFiles: rows.length,
        newestLogDate: rows[0]?.LogDate ?? null,
        columns: columns.length,
        appColumnsPresent: APP_COLUMNS.filter((c) => columns.includes(c)),
        hasApiClientCategory: columns.includes('API_CLIENT_CATEGORY'),
      };
    },
  },
];

export function buildSoql(source, fields, ctx) {
  let soql = `SELECT ${fields.join(', ')} FROM ${source.object}`;
  if (source.where) soql += ` WHERE ${source.where(ctx)}`;
  if (source.orderBy) soql += ` ORDER BY ${source.orderBy}`;
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

  try {
    const { soql, rows } = await run(source.fields);
    return { ...base, status: 'readable', soql, fieldsReadable: [...source.fields], fieldsMissing: [], truncated: rows.length >= source.limit, stats: source.stats(rows, ctx) };
  } catch (err) {
    if (!MISSING_FIELD.test(err?.message ?? '')) {
      return { ...base, status: 'unreadable', soql: buildSoql(source, source.fields, ctx), fieldsReadable: [], fieldsMissing: [], error: oneLine(err?.message), stats: null };
    }
  }

  const fieldsReadable = [];
  const fieldsMissing = [];
  for (const field of source.fields) {
    try {
      await queryFn(orgAlias, `SELECT ${field} FROM ${source.object} LIMIT 1`);
      fieldsReadable.push(field);
    } catch {
      fieldsMissing.push(field);
    }
  }
  if (!fieldsReadable.length) {
    return { ...base, status: 'unreadable', soql: buildSoql(source, source.fields, ctx), fieldsReadable, fieldsMissing, error: 'None of the probed fields are readable', stats: null };
  }
  try {
    const { soql, rows } = await run(fieldsReadable);
    return { ...base, status: 'partial', soql, fieldsReadable, fieldsMissing, truncated: rows.length >= source.limit, stats: source.stats(rows, ctx) };
  } catch (err) {
    // The WHERE clause itself can reference a missing field.
    return { ...base, status: 'unreadable', soql: buildSoql(source, fieldsReadable, ctx), fieldsReadable, fieldsMissing, error: oneLine(err?.message), stats: null };
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

  const signals = [];
  let coverage = null;
  if (lh?.stats && lh.stats.apiLogins > 0) {
    coverage = lh.stats.apiLoginsWithApplication / lh.stats.apiLogins;
    signals.push(`LoginHistory names an application on ${Math.round(coverage * 100)}% of ${lh.stats.apiLogins} API logins`);
  } else if (lh?.stats) {
    signals.push('LoginHistory has no API logins in the window');
  } else {
    signals.push('LoginHistory is not readable');
  }
  const oauthApps = oauth?.stats?.distinctApps ?? 0;
  signals.push(oauth?.stats ? `OauthToken lists ${oauthApps} connected app(s)` : 'OauthToken is not readable');
  const elfCols = elf?.stats?.appColumnsPresent ?? [];
  if (elf?.stats?.logFiles) {
    signals.push(`ApiTotalUsage log columns that identify callers: ${elfCols.length ? elfCols.join(', ') : 'none'}`);
  } else {
    signals.push(elf?.stats ? 'No ApiTotalUsage log files available' : 'EventLogFile is not readable');
  }

  let verdict;
  if (coverage != null && coverage >= 0.8) verdict = 'yes';
  else if ((coverage ?? 0) > 0 || oauthApps > 0 || elfCols.some((c) => c !== 'USER_ID' && c !== 'CLIENT_IP')) verdict = 'partly';
  else if (coverage === 0 && oauth?.stats) verdict = 'no';
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
