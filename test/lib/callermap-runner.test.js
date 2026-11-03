import { describe, it, expect, vi } from 'vitest';
import {
  PROBE_SOURCES,
  buildSoql,
  probeSource,
  assessAppNaming,
  runCallermapProbe,
} from '../../src/lib/callermap-runner.js';

const NOW = Date.parse('2026-11-03T00:00:00Z');
const ctx = { since: '2026-10-04T00:00:00Z', sinceMs: Date.parse('2026-10-04T00:00:00Z'), lookbackDays: 30 };
const source = (id) => PROBE_SOURCES.find((s) => s.id === id);

describe('PROBE_SOURCES', () => {
  it('only ever builds read-only SELECT queries with a LIMIT', () => {
    for (const s of PROBE_SOURCES) {
      const soql = buildSoql(s, s.fields, ctx);
      expect(soql).toMatch(/^SELECT /);
      expect(soql).toMatch(/ LIMIT \d+$/);
    }
  });

  it('puts the lookback window into the LoginHistory query', () => {
    expect(buildSoql(source('login-history'), ['UserId', 'LoginTime'], ctx)).toBe(
      'SELECT UserId, LoginTime FROM LoginHistory WHERE LoginTime >= 2026-10-04T00:00:00Z ORDER BY LoginTime DESC LIMIT 2000',
    );
  });
});

describe('probeSource', () => {
  it('reports a readable source with counts only, never raw identifiers', async () => {
    const rows = [
      { UserId: '005A', ApiType: 'SOAP Partner', Application: 'Data Loader', LoginType: 'Partner Product', SourceIp: '10.0.0.1' },
      { UserId: '005B', ApiType: 'REST', Application: 'N/A', LoginType: 'Remote Access 2.0', SourceIp: '10.0.0.2' },
      { UserId: '005C', ApiType: 'N/A', Application: 'Browser', LoginType: 'Application', SourceIp: '10.0.0.3' },
    ];
    const queryFn = vi.fn().mockResolvedValue(rows);
    const r = await probeSource('dev', source('login-history'), ctx, { queryFn });

    expect(r.status).toBe('readable');
    expect(r.fieldsMissing).toEqual([]);
    expect(r.stats).toMatchObject({ rows: 3, apiLogins: 2, apiLoginsWithApplication: 1, distinctApplications: 1 });
    expect(r.stats.apiTypes).toEqual({ 'SOAP Partner': 1, REST: 1 });
    const text = JSON.stringify(r.stats);
    for (const secret of ['005A', '10.0.0.1', 'Data Loader']) expect(text).not.toContain(secret);
  });

  it('pinpoints missing fields and still reports the rest as partial', async () => {
    const queryFn = vi.fn(async (_org, soql) => {
      if (soql.includes('PermissionsUseAnyApiClient')) throw new Error("INVALID_FIELD: No such column 'PermissionsUseAnyApiClient' on entity 'PermissionSet'");
      return [{ IsOwnedByProfile: true, PermissionsApiEnabled: true }, { IsOwnedByProfile: false, PermissionsApiEnabled: true }];
    });
    const r = await probeSource('dev', source('api-permission'), ctx, { queryFn });

    expect(r.status).toBe('partial');
    expect(r.fieldsMissing).toEqual(['PermissionsUseAnyApiClient']);
    expect(r.fieldsReadable).toEqual(['IsOwnedByProfile', 'PermissionsApiEnabled']);
    expect(r.stats).toEqual({ apiEnabledPermsets: 1, apiEnabledProfiles: 1, withUseAnyApiClient: null });
  });

  it('marks the whole source unreadable on a non-field error and keeps the reason', async () => {
    const queryFn = vi.fn().mockRejectedValue(new Error("sObject type 'EventLogFile' is not supported."));
    const r = await probeSource('dev', source('api-total-usage'), ctx, { queryFn });

    expect(r.status).toBe('unreadable');
    expect(r.error).toContain('not supported');
    expect(r.stats).toBeNull();
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it('is unreadable when no probed field can be read', async () => {
    const queryFn = vi.fn().mockRejectedValue(new Error('INVALID_FIELD: nope'));
    const r = await probeSource('dev', source('oauth-tokens'), ctx, { queryFn });
    expect(r.status).toBe('unreadable');
    expect(r.fieldsMissing).toEqual(source('oauth-tokens').fields);
  });

  it('does not report a field as missing when its probe fails for another reason', async () => {
    const queryFn = vi.fn(async (_org, soql) => {
      if (soql.includes('PermissionsUseAnyApiClient')) throw new Error('INVALID_FIELD: No such column');
      if (soql === 'SELECT IsOwnedByProfile FROM PermissionSet LIMIT 1') throw new Error('Session expired or invalid');
      return [];
    });
    const r = await probeSource('dev', source('api-permission'), ctx, { queryFn });

    expect(r.status).toBe('unreadable');
    expect(r.error).toContain('Session expired');
    expect(r.fieldsMissing).toEqual([]);
  });

  it('reports stats built on a missing field as unknown, not zero', async () => {
    const queryFn = vi.fn(async (_org, soql) => {
      if (soql.includes('Application')) throw new Error("INVALID_FIELD: No such column 'Application' on entity 'LoginHistory'");
      return [{ ApiType: 'REST', LoginType: 'Remote Access 2.0' }];
    });
    const r = await probeSource('dev', source('login-history'), ctx, { queryFn });

    expect(r.status).toBe('partial');
    expect(r.fieldsMissing).toEqual(['Application']);
    expect(r.stats).toMatchObject({ apiLogins: 1, apiLoginsWithApplication: null, distinctApplications: null });
    expect(assessAppNaming([r, { id: 'oauth-tokens', stats: { distinctApps: 0 } }]).verdict).toBe('unknown');
  });

  it('combines API access and "Use Any API Client" across a user\'s assignments', async () => {
    const queryFn = vi.fn().mockResolvedValue([
      { AssigneeId: '005A', PermissionSet: { IsOwnedByProfile: true, PermissionsApiEnabled: true, PermissionsUseAnyApiClient: false } },
      { AssigneeId: '005A', PermissionSet: { IsOwnedByProfile: false, PermissionsApiEnabled: false, PermissionsUseAnyApiClient: true } },
      { AssigneeId: '005B', PermissionSet: { IsOwnedByProfile: true, PermissionsApiEnabled: true, PermissionsUseAnyApiClient: false } },
    ]);
    const r = await probeSource('dev', source('api-permission-assignments'), ctx, { queryFn });

    expect(queryFn.mock.calls[0][1]).toContain('PermissionSet.PermissionsApiEnabled = true OR PermissionSet.PermissionsUseAnyApiClient = true');
    expect(r.stats).toEqual({ activeApiUsers: 2, withUseAnyApiClient: 1, withoutUseAnyApiClient: 1 });
  });

  it('drops "Use Any API Client" from the filter when the org lacks it', async () => {
    const queryFn = vi.fn(async (_org, soql) => {
      if (soql.includes('PermissionsUseAnyApiClient')) throw new Error('INVALID_FIELD: No such column');
      return [{ AssigneeId: '005A', PermissionSet: { IsOwnedByProfile: true, PermissionsApiEnabled: true } }];
    });
    const r = await probeSource('dev', source('api-permission-assignments'), ctx, { queryFn });

    expect(r.status).toBe('partial');
    expect(r.soql).toContain('WHERE Assignee.IsActive = true AND PermissionSet.PermissionsApiEnabled = true LIMIT');
    expect(r.stats).toEqual({ activeApiUsers: 1, withUseAnyApiClient: null, withoutUseAnyApiClient: null });
  });

  it('drops the ORDER BY when its field is missing, so the source stays partial', async () => {
    const queryFn = vi.fn(async (_org, soql) => {
      if (soql.includes('LastUsedDate')) throw new Error("INVALID_FIELD: No such column 'LastUsedDate' on entity 'OauthToken'");
      return [{ AppName: 'X', UseCount: 3 }];
    });
    const r = await probeSource('dev', source('oauth-tokens'), ctx, { queryFn });

    expect(r.status).toBe('partial');
    expect(r.fieldsMissing).toEqual(['LastUsedDate']);
    expect(r.soql).not.toContain('ORDER BY');
    expect(r.stats).toMatchObject({ distinctApps: 1, rowsWithLastUsed: null, usedInWindow: null });
  });

  it('reports the original error when no selected field is missing', async () => {
    const queryFn = vi.fn(async (_org, soql) => {
      if (soql.includes('WHERE')) throw new Error("INVALID_FIELD: No such column 'PermissionsApiEnabled' in WHERE");
      return [];
    });
    const r = await probeSource('dev', source('api-permission'), ctx, { queryFn });

    expect(r.status).toBe('unreadable');
    expect(r.fieldsMissing).toEqual([]);
    expect(r.error).toContain('in WHERE');
  });

  it('reads ApiTotalUsage columns from the first log that lists them', async () => {
    const queryFn = vi.fn().mockResolvedValue([
      { LogDate: '2026-11-03T00:00:00.000+0000', LogFileFieldNames: '' },
      { LogDate: '2026-11-02T00:00:00.000+0000', LogFileFieldNames: 'EVENT_TYPE,API_CLIENT_CATEGORY' },
    ]);
    const r = await probeSource('dev', source('api-total-usage'), ctx, { queryFn });
    expect(r.stats).toMatchObject({ logFiles: 2, columns: 2, hasApiClientCategory: true, newestLogDate: '2026-11-03T00:00:00.000+0000' });
  });

  it('strips control characters from tally keys', async () => {
    const queryFn = vi.fn().mockResolvedValue([{ UserType: 'Stan\u001b[31mdard' }]);
    const r = await probeSource('dev', source('users'), ctx, { queryFn });
    expect(Object.keys(r.stats.userTypes)).toEqual(['Stan[31mdard']);
  });

  it('flags a result that hit the row limit', async () => {
    const queryFn = vi.fn().mockResolvedValue(Array.from({ length: 2000 }, () => ({ UserType: 'Standard' })));
    const r = await probeSource('dev', source('users'), ctx, { queryFn });
    expect(r.truncated).toBe(true);
  });

  it('reads ApiTotalUsage column names without downloading the log', async () => {
    const queryFn = vi.fn().mockResolvedValue([
      { LogDate: '2026-11-02T00:00:00.000+0000', LogFileFieldNames: 'EVENT_TYPE,USER_ID,CONNECTED_APP_ID,API_CLIENT_CATEGORY,CLIENT_IP' },
    ]);
    const r = await probeSource('dev', source('api-total-usage'), ctx, { queryFn });
    expect(r.stats).toMatchObject({
      logFiles: 1,
      columns: 5,
      hasApiClientCategory: true,
      appColumnsPresent: ['API_CLIENT_CATEGORY', 'CONNECTED_APP_ID', 'USER_ID', 'CLIENT_IP'],
    });
  });

  it('counts integration users on admin profiles', async () => {
    const queryFn = vi.fn().mockResolvedValue([
      { UserType: 'Standard', Profile: { Name: 'System Administrator', UserLicense: { Name: 'Salesforce Integration' }, PermissionsApiUserOnly: true } },
      { UserType: 'Standard', Profile: { Name: 'Standard User', UserLicense: { Name: 'Salesforce' }, PermissionsApiUserOnly: false } },
    ]);
    const r = await probeSource('dev', source('users'), ctx, { queryFn });
    expect(r.stats).toMatchObject({ activeUsers: 2, onAdminProfile: 1, apiOnlyOnAdminProfile: 1, integrationLicenseOnAdminProfile: 1 });
  });
});

describe('assessAppNaming', () => {
  const lh = (apiLogins, named) => ({ id: 'login-history', stats: { apiLogins, apiLoginsWithApplication: named } });

  it('says yes when LoginHistory names the app on most API logins', () => {
    expect(assessAppNaming([lh(10, 9)]).verdict).toBe('yes');
  });

  it('does not say yes from a LoginHistory sample that hit its row limit', () => {
    const a = assessAppNaming([{ ...lh(2000, 1990), truncated: true }]);
    expect(a.verdict).toBe('partly');
    expect(a.signals.join(' ')).toMatch(/row limit/);
  });

  it('says partly when only some sources can name the app', () => {
    expect(assessAppNaming([lh(10, 2)]).verdict).toBe('partly');
    expect(assessAppNaming([lh(10, 0), { id: 'oauth-tokens', stats: { distinctApps: 3 } }]).verdict).toBe('partly');
  });

  it('says no when the readable data names nothing', () => {
    expect(assessAppNaming([lh(10, 0), { id: 'oauth-tokens', stats: { distinctApps: 0 } }]).verdict).toBe('no');
  });

  it('says unknown when nothing is readable, and is labeled a heuristic', () => {
    const a = assessAppNaming([{ id: 'login-history', stats: null }]);
    expect(a).toMatchObject({ verdict: 'unknown', heuristic: true });
    expect(a.signals[0]).toMatch(/not readable/);
  });
});

describe('runCallermapProbe', () => {
  it('probes every source in order and summarises the result', async () => {
    const queryFn = vi.fn(async (_org, soql) => {
      if (soql.includes('FROM OauthToken')) throw new Error('INSUFFICIENT_ACCESS: OauthToken');
      return [];
    });
    const res = await runCallermapProbe('dev', { lookbackDays: 7, now: NOW, queryFn });

    expect(res).toMatchObject({ probe: true, org: 'dev', lookbackDays: 7, timestamp: '2026-11-03T00:00:00.000Z' });
    expect(res.sources.map((s) => s.id)).toEqual(PROBE_SOURCES.map((s) => s.id));
    expect(res.summary).toEqual({ total: PROBE_SOURCES.length, readable: PROBE_SOURCES.length - 1, partial: 0, unreadable: 1 });
    expect(queryFn.mock.calls[0][1]).toContain('LoginTime >= 2026-10-27T00:00:00Z');
    for (const [, soql] of queryFn.mock.calls) expect(soql).toMatch(/^SELECT /);
  });
});
