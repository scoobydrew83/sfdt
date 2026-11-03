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
    expect(buildSoql(source('login-history'), ['UserId'], ctx)).toBe(
      'SELECT UserId FROM LoginHistory WHERE LoginTime >= 2026-10-04T00:00:00Z ORDER BY LoginTime DESC LIMIT 2000',
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
