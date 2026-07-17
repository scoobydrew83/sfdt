import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  _traceFlagsTestApi,
  createTraceFlagsFeature,
  DEBUG_CATEGORIES,
  type CategoryMap,
} from '../features/trace-flags.js';
import type { SalesforceApiClient } from '../lib/salesforce-api.js';

const {
  presetCategories,
  buildActiveTraceFlagsQuery,
  buildEntityTraceFlagLookup,
  buildUserSearchQuery,
  buildUsersByIdQuery,
  buildDebugLevelsByIdQuery,
  buildManagedDebugLevelLookup,
  traceFlagWindow,
  traceFlagCreatePayload,
  renewTraceFlagPayload,
  debugLevelPayload,
  traceFlagCountdown,
  readCustomPreset,
  writeCustomPreset,
  traceFlagEndpoint,
  debugLevelEndpoint,
  MANAGED_LEVEL_NAMES,
  PRESET_FULL,
  PRESET_BASIC,
} = _traceFlagsTestApi();

function clearBody(): void {
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
}
function setSetupUrl(): void {
  window.history.replaceState({}, '', 'https://x.lightning.force.com/lightning/setup/SetupOneHome/home');
}
function setNoneUrl(): void {
  window.history.replaceState({}, '', 'https://x.lightning.force.com/lightning/page/home');
}
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
}

// --- Pure helpers ---------------------------------------------------------

describe('trace-flags — presets', () => {
  it('Basic keeps ApexCode/System at DEBUG', () => {
    const p = presetCategories('basic');
    expect(p.ApexCode).toBe('DEBUG');
    expect(p.System).toBe('DEBUG');
    expect(p.ApexProfiling).toBe('NONE');
  });

  it('Full sets every category to FINEST', () => {
    const p = presetCategories('full');
    for (const cat of DEBUG_CATEGORIES) expect(p[cat]).toBe('FINEST');
    expect(p).toEqual(PRESET_FULL);
  });

  it('Custom overlays the provided per-category map onto Basic', () => {
    const custom = { ...PRESET_BASIC, Callout: 'FINEST', Database: 'FINE' } as CategoryMap;
    const p = presetCategories('custom', custom);
    expect(p.Callout).toBe('FINEST');
    expect(p.Database).toBe('FINE');
    // Untouched categories fall back to Basic.
    expect(p.ApexProfiling).toBe('NONE');
  });
});

describe('trace-flags — SOQL builders', () => {
  it('lists all trace flags with the AC fields', () => {
    const q = buildActiveTraceFlagsQuery();
    for (const f of ['Id', 'TracedEntityId', 'DebugLevelId', 'LogType', 'StartDate', 'ExpirationDate']) {
      expect(q).toContain(f);
    }
    expect(q).toContain('FROM TraceFlag');
  });

  it('scopes the entity lookup to the user and DEVELOPER_LOG', () => {
    const q = buildEntityTraceFlagLookup('005000000000001');
    expect(q).toContain("TracedEntityId = '005000000000001'");
    expect(q).toContain("LogType = 'DEVELOPER_LOG'");
  });

  it('escapes single quotes in the entity id (SOQL injection guard)', () => {
    const q = buildEntityTraceFlagLookup("005' OR Id != null --");
    expect(q).toContain("005\\' OR Id != null --");
  });

  it('searches users by name OR username, active only', () => {
    const q = buildUserSearchQuery('jane');
    expect(q).toContain('FROM User');
    expect(q).toContain('IsActive = true');
    expect(q).toContain("Name LIKE '%jane%'");
    expect(q).toContain("Username LIKE '%jane%'");
  });

  it('builds an IN() list for user-name resolution', () => {
    const q = buildUsersByIdQuery(['005a', '005b']);
    expect(q).toContain("Id IN ('005a', '005b')");
  });

  it('builds an IN() list for debug-level resolution', () => {
    const q = buildDebugLevelsByIdQuery(['7dl1', '7dl2']);
    expect(q).toContain('FROM DebugLevel');
    expect(q).toContain("Id IN ('7dl1', '7dl2')");
  });

  it('looks up a managed debug level by developer name', () => {
    const q = buildManagedDebugLevelLookup('SFDT_TF_Basic');
    expect(q).toContain("DeveloperName = 'SFDT_TF_Basic'");
    expect(q).toContain('LIMIT 1');
  });
});

describe('trace-flags — Tooling payloads', () => {
  const now = Date.parse('2026-06-22T12:00:00.000Z');

  it('holds the window to exactly 24h from a back-dated start', () => {
    const w = traceFlagWindow(now);
    expect(w.StartDate).toBe('2026-06-22T11:59:00.000Z');
    expect(Date.parse(w.ExpirationDate) - Date.parse(w.StartDate)).toBe(24 * 60 * 60 * 1000);
  });

  it('CREATE payload targets user, level, DEVELOPER_LOG and carries the window', () => {
    const p = traceFlagCreatePayload('005xx', '7dlxx', now);
    expect(p.TracedEntityId).toBe('005xx');
    expect(p.DebugLevelId).toBe('7dlxx');
    expect(p.LogType).toBe('DEVELOPER_LOG');
    expect(p.StartDate).toBe('2026-06-22T11:59:00.000Z');
    expect(p.ExpirationDate).toBe('2026-06-23T11:59:00.000Z');
  });

  it('RENEW payload pushes both dates forward (respecting the 24h cap)', () => {
    const p = renewTraceFlagPayload(now);
    expect(p.StartDate).toBe('2026-06-22T11:59:00.000Z');
    expect(p.ExpirationDate).toBe('2026-06-23T11:59:00.000Z');
  });

  it('DebugLevel payload carries DeveloperName/MasterLabel + all categories', () => {
    const p = debugLevelPayload('SFDT_TF_Full', PRESET_FULL);
    expect(p.DeveloperName).toBe('SFDT_TF_Full');
    expect(p.MasterLabel).toBe('SFDT_TF_Full');
    for (const cat of DEBUG_CATEGORIES) expect(p[cat]).toBe('FINEST');
  });

  it('endpoints target the Tooling sobjects collections', () => {
    expect(traceFlagEndpoint('7tf1')).toContain('/tooling/sobjects/TraceFlag/7tf1');
    expect(debugLevelEndpoint('7dl1')).toContain('/tooling/sobjects/DebugLevel/7dl1');
  });
});

describe('trace-flags — countdown', () => {
  const now = Date.parse('2026-06-22T12:00:00.000Z');

  it('reports remaining time for a future expiry', () => {
    const c = traceFlagCountdown('2026-06-22T15:30:00.000Z', now);
    expect(c.expired).toBe(false);
    expect(c.remainingMs).toBe(3.5 * 60 * 60 * 1000);
    expect(c.label).toBe('3h 30m');
  });

  it('labels minutes+seconds under an hour', () => {
    expect(traceFlagCountdown('2026-06-22T12:02:30.000Z', now).label).toBe('2m 30s');
  });

  it('marks a past expiry expired', () => {
    const c = traceFlagCountdown('2026-06-22T11:00:00.000Z', now);
    expect(c.expired).toBe(true);
    expect(c.label).toBe('Expired');
  });

  it('handles missing/invalid dates', () => {
    expect(traceFlagCountdown(undefined, now).expired).toBe(true);
    expect(traceFlagCountdown(null, now).label).toBe('—');
    expect(traceFlagCountdown('not-a-date', now).label).toBe('—');
  });
});

describe('trace-flags — custom preset round-trip', () => {
  it('defaults to Basic when nothing is stored', async () => {
    expect(await readCustomPreset()).toEqual(PRESET_BASIC);
  });

  it('saves per-category selections and reapplies them identically', async () => {
    const custom: CategoryMap = {
      ApexCode: 'FINEST',
      ApexProfiling: 'FINE',
      Callout: 'FINER',
      Database: 'DEBUG',
      System: 'FINEST',
      Validation: 'WARN',
      Visualforce: 'ERROR',
      Workflow: 'NONE',
    };
    await writeCustomPreset(custom);
    expect(await readCustomPreset()).toEqual(custom);
  });

  it('merges a partial stored map onto Basic so every category is present', async () => {
    await writeCustomPreset({ Callout: 'FINEST' } as CategoryMap);
    const read = await readCustomPreset();
    expect(read.Callout).toBe('FINEST');
    expect(read.ApexCode).toBe(PRESET_BASIC.ApexCode);
  });
});

// --- Feature integration --------------------------------------------------

function fakeApi(overrides: Partial<SalesforceApiClient> = {}): SalesforceApiClient {
  return {
    apiGet: vi.fn(async () => ({})),
    apiRequest: vi.fn(async () => ({ id: '7dlNEW' })),
    toolingQuery: vi.fn(async () => ({ records: [], size: 0, done: true })),
    query: vi.fn(async () => ({ records: [], done: true, totalSize: 0 })),
    ...overrides,
  } as unknown as SalesforceApiClient;
}

describe('trace-flags — onActivate context gate', () => {
  beforeEach(() => clearBody());

  it('warns and does not open outside a Salesforce page', async () => {
    setNoneUrl();
    const feature = createTraceFlagsFeature({ api: fakeApi() });
    await feature.onActivate?.();
    await flush();
    expect(document.querySelector('.sfdt-view-overlay')).toBeNull();
    expect(document.querySelector('.sfdt-toast')?.textContent).toContain('trace flags');
  });
});

describe('trace-flags — list + actions', () => {
  beforeEach(() => {
    clearBody();
    setSetupUrl();
  });

  it('renders a flag row with resolved names, a countdown, and Renew/Stop', async () => {
    const api = fakeApi({
      toolingQuery: vi.fn(async (soql: string) => {
        if (soql.includes('FROM TraceFlag')) {
          return {
            records: [
              {
                Id: '7tf1',
                TracedEntityId: '005user',
                DebugLevelId: '7dllevel',
                LogType: 'DEVELOPER_LOG',
                StartDate: '2999-01-01T00:00:00.000Z',
                ExpirationDate: '2999-01-01T12:00:00.000Z',
              },
            ],
            size: 1,
            done: true,
          };
        }
        if (soql.includes('FROM DebugLevel')) {
          return { records: [{ Id: '7dllevel', MasterLabel: 'SFDT Full' }], size: 1, done: true };
        }
        return { records: [], size: 0, done: true };
      }) as unknown as SalesforceApiClient['toolingQuery'],
      query: vi.fn(async () => ({
        records: [{ Id: '005user', Name: 'Jane Dev' }],
        done: true,
        totalSize: 1,
      })) as unknown as SalesforceApiClient['query'],
    });
    const feature = createTraceFlagsFeature({ api });
    await feature.onActivate?.();
    await flush();
    const text = document.querySelector('.sfdt-view-overlay')?.textContent ?? '';
    expect(text).toContain('Jane Dev');
    expect(text).toContain('SFDT Full');
    const labels = Array.from(document.querySelectorAll('.sfdt-view-overlay button')).map((b) => b.textContent);
    expect(labels).toContain('Renew');
    expect(labels).toContain('Stop');
  });

  it('Renew PATCHes the flag with a fresh window', async () => {
    const api = fakeApi({
      toolingQuery: vi.fn(async (soql: string) => {
        if (soql.includes('FROM TraceFlag')) {
          return {
            records: [
              {
                Id: '7tfRENEW',
                TracedEntityId: '005user',
                DebugLevelId: '7dllevel',
                LogType: 'DEVELOPER_LOG',
                StartDate: '2020-01-01T00:00:00.000Z',
                ExpirationDate: '2020-01-01T12:00:00.000Z',
              },
            ],
            size: 1,
            done: true,
          };
        }
        return { records: [], size: 0, done: true };
      }) as unknown as SalesforceApiClient['toolingQuery'],
    });
    const feature = createTraceFlagsFeature({ api });
    await feature.onActivate?.();
    await flush();
    Array.from(document.querySelectorAll<HTMLButtonElement>('.sfdt-view-overlay button')).find(
      (b) => b.textContent === 'Renew',
    )!.click();
    await flush();
    expect(api.apiRequest).toHaveBeenCalledWith(
      'PATCH',
      expect.stringContaining('/TraceFlag/7tfRENEW'),
      expect.objectContaining({ StartDate: expect.any(String), ExpirationDate: expect.any(String) }),
    );
  });

  it('Stop DELETEs the flag', async () => {
    const api = fakeApi({
      toolingQuery: vi.fn(async (soql: string) => {
        if (soql.includes('FROM TraceFlag')) {
          return {
            records: [
              {
                Id: '7tfSTOP',
                TracedEntityId: '005user',
                DebugLevelId: '7dllevel',
                LogType: 'DEVELOPER_LOG',
                StartDate: '2999-01-01T00:00:00.000Z',
                ExpirationDate: '2999-01-01T12:00:00.000Z',
              },
            ],
            size: 1,
            done: true,
          };
        }
        return { records: [], size: 0, done: true };
      }) as unknown as SalesforceApiClient['toolingQuery'],
    });
    const feature = createTraceFlagsFeature({ api });
    await feature.onActivate?.();
    await flush();
    Array.from(document.querySelectorAll<HTMLButtonElement>('.sfdt-view-overlay button')).find(
      (b) => b.textContent === 'Stop',
    )!.click();
    await flush();
    expect(api.apiRequest).toHaveBeenCalledWith('DELETE', expect.stringContaining('/TraceFlag/7tfSTOP'));
  });
});

describe('trace-flags — start a session for me', () => {
  beforeEach(() => {
    clearBody();
    setSetupUrl();
  });

  it('creates a DebugLevel (if absent) and a TraceFlag for the current user', async () => {
    const api = fakeApi({
      apiGet: vi.fn(async (endpoint: string) => {
        if (endpoint.includes('userinfo')) return { user_id: '005me' };
        return {};
      }) as unknown as SalesforceApiClient['apiGet'],
      // No managed DebugLevel, no existing TraceFlag, empty list.
      toolingQuery: vi.fn(async () => ({ records: [], size: 0, done: true })) as unknown as SalesforceApiClient['toolingQuery'],
      apiRequest: vi.fn(async (method: string, endpoint: string) => {
        if (endpoint.includes('/DebugLevel')) return { id: '7dlBASIC' };
        return { id: '7tfNEW' };
      }) as unknown as SalesforceApiClient['apiRequest'],
    });
    const feature = createTraceFlagsFeature({ api });
    await feature.onActivate?.();
    await flush();
    Array.from(document.querySelectorAll<HTMLButtonElement>('.sfdt-view-overlay button')).find(
      (b) => b.textContent === 'Me',
    )!.click();
    await flush();
    // A managed DebugLevel was created…
    expect(api.apiRequest).toHaveBeenCalledWith(
      'POST',
      expect.stringContaining('/DebugLevel'),
      expect.objectContaining({ DeveloperName: MANAGED_LEVEL_NAMES.basic }),
    );
    // …and a TraceFlag pointing at it, for the current user.
    expect(api.apiRequest).toHaveBeenCalledWith(
      'POST',
      expect.stringContaining('/TraceFlag'),
      expect.objectContaining({ TracedEntityId: '005me', DebugLevelId: '7dlBASIC', LogType: 'DEVELOPER_LOG' }),
    );
  });
});
