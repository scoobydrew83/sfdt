import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  _apexAnonymousTestApi,
  createApexAnonymousFeature,
  type ExecuteAnonymousResult,
} from '../features/apex-anonymous.js';
import type { SalesforceApiClient } from '../lib/salesforce-api.js';
import { loadSettings, saveSettings, type Settings } from '../lib/settings.js';

const {
  summariseResult,
  readApexHistory,
  pushApexHistory,
  readApexSnippets,
  pushApexSnippet,
  HISTORY_CAP,
  DEBUG_LEVEL_DEVELOPER_NAME,
  buildDebugLevelLookup,
  buildDebugLevelListQuery,
  readSelectedDebugLevelId,
  writeSelectedDebugLevelId,
  buildTraceFlagLookup,
  buildLatestApexLogLookup,
  debugLevelCreatePayload,
  traceFlagWindow,
  traceFlagCreatePayload,
  traceFlagIsActive,
  pickNewLogId,
} = _apexAnonymousTestApi();

function clearBody(): void {
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
}

function setSetupUrl(): void {
  window.history.replaceState({}, '', 'https://x.lightning.force.com/lightning/setup/SetupOneHome/home');
}

function setNoneUrl(): void {
  window.history.replaceState({}, '', 'https://x.lightning.force.com/lightning/page/home');
}

// saveSettings() updates the module's in-memory settings cache directly. A raw
// chrome.storage write would be ignored because the test setup wipes the
// onChanged listener that normally invalidates that cache.
async function seedSettings(
  featureSettings: Record<string, Record<string, unknown>>,
): Promise<void> {
  const base = await loadSettings();
  await saveSettings({ ...base, featureSettings } as Settings);
}

function okResult(overrides: Partial<ExecuteAnonymousResult> = {}): ExecuteAnonymousResult {
  return {
    compiled: true,
    compileProblem: null,
    success: true,
    line: -1,
    column: -1,
    exceptionMessage: null,
    exceptionStackTrace: null,
    ...overrides,
  };
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

function result(overrides: Partial<ExecuteAnonymousResult>): ExecuteAnonymousResult {
  return {
    compiled: true,
    compileProblem: null,
    success: true,
    line: -1,
    column: -1,
    exceptionMessage: null,
    exceptionStackTrace: null,
    ...overrides,
  };
}

describe('apex-anonymous — summariseResult', () => {
  it('reports success when compiled and executed', () => {
    expect(summariseResult(result({}))).toEqual({
      ok: true,
      message: 'Compiled and executed successfully.',
    });
  });

  it('reports compile errors with line/column', () => {
    const s = summariseResult(
      result({ compiled: false, success: false, line: 3, column: 7, compileProblem: 'Unexpected token' }),
    );
    expect(s.ok).toBe(false);
    expect(s.message).toContain('line 3');
    expect(s.message).toContain('col 7');
    expect(s.message).toContain('Unexpected token');
  });

  it('reports runtime exceptions', () => {
    const s = summariseResult(
      result({ success: false, exceptionMessage: 'System.NullPointerException' }),
    );
    expect(s.ok).toBe(false);
    expect(s.message).toContain('System.NullPointerException');
  });
});

describe('apex-anonymous — log capture SOQL builders', () => {
  it('looks up the feature-owned DebugLevel by developer name', () => {
    const q = buildDebugLevelLookup();
    expect(q).toContain('FROM DebugLevel');
    expect(q).toContain(`DeveloperName = '${DEBUG_LEVEL_DEVELOPER_NAME}'`);
    expect(q).toContain('LIMIT 1');
  });

  it('scopes the trace-flag lookup to the user and DEVELOPER_LOG', () => {
    const q = buildTraceFlagLookup('005000000000001');
    expect(q).toContain('FROM TraceFlag');
    expect(q).toContain("TracedEntityId = '005000000000001'");
    expect(q).toContain("LogType = 'DEVELOPER_LOG'");
  });

  it('escapes single quotes in the user id to avoid SOQL injection', () => {
    const q = buildTraceFlagLookup("005' OR Id != null --");
    expect(q).toContain("005\\' OR Id != null --");
  });

  it('finds the newest ApexLog for the user', () => {
    const q = buildLatestApexLogLookup('005000000000001');
    expect(q).toContain('FROM ApexLog');
    expect(q).toContain("LogUserId = '005000000000001'");
    expect(q).toContain('ORDER BY StartTime DESC');
    expect(q).toContain('LIMIT 1');
  });

  it('lists the org DebugLevels for the picker', () => {
    const q = buildDebugLevelListQuery();
    expect(q).toContain('FROM DebugLevel');
    expect(q).toContain('DeveloperName');
    expect(q).toContain('MasterLabel');
    expect(q).toContain('ORDER BY DeveloperName');
  });
});

describe('apex-anonymous — selected debug level persistence', () => {
  it('returns empty when nothing is stored', async () => {
    expect(await readSelectedDebugLevelId()).toBe('');
  });

  it('round-trips the picked DebugLevel id through storage', async () => {
    await writeSelectedDebugLevelId('7dl000000000001');
    expect(await readSelectedDebugLevelId()).toBe('7dl000000000001');
  });
});

describe('apex-anonymous — trace-flag payloads', () => {
  it('builds a FINEST DebugLevel payload', () => {
    const p = debugLevelCreatePayload();
    expect(p.DeveloperName).toBe(DEBUG_LEVEL_DEVELOPER_NAME);
    expect(p.ApexCode).toBe('FINEST');
  });

  it('holds the trace-flag window to exactly 24h from a back-dated start', () => {
    const now = Date.parse('2026-06-22T12:00:00.000Z');
    const w = traceFlagWindow(now);
    // start is back-dated 60s to dodge clock skew
    expect(w.StartDate).toBe('2026-06-22T11:59:00.000Z');
    // expiration is exactly 24h after the (back-dated) start — within the cap
    const span = Date.parse(w.ExpirationDate) - Date.parse(w.StartDate);
    expect(span).toBe(24 * 60 * 60 * 1000);
  });

  it('targets the trace flag at the user, debug level, and DEVELOPER_LOG', () => {
    const now = Date.parse('2026-06-22T12:00:00.000Z');
    const p = traceFlagCreatePayload('005xx', '7dlxx', now);
    expect(p.TracedEntityId).toBe('005xx');
    expect(p.DebugLevelId).toBe('7dlxx');
    expect(p.LogType).toBe('DEVELOPER_LOG');
    expect(p.StartDate).toBe('2026-06-22T11:59:00.000Z');
  });
});

describe('apex-anonymous — trace-flag/log decisions', () => {
  const now = Date.parse('2026-06-22T12:00:00.000Z');

  it('treats a future-dated flag as active', () => {
    expect(traceFlagIsActive({ ExpirationDate: '2026-06-22T13:00:00.000Z' }, now)).toBe(true);
  });

  it('treats an expired flag as inactive', () => {
    expect(traceFlagIsActive({ ExpirationDate: '2026-06-22T11:00:00.000Z' }, now)).toBe(false);
  });

  it('treats a missing/empty flag as inactive', () => {
    expect(traceFlagIsActive(undefined, now)).toBe(false);
    expect(traceFlagIsActive(null, now)).toBe(false);
    expect(traceFlagIsActive({}, now)).toBe(false);
  });

  it('returns the latest log id only when it differs from the baseline', () => {
    expect(pickNewLogId('07Lnew', '07Lold')).toBe('07Lnew');
    expect(pickNewLogId('07Lsame', '07Lsame')).toBeNull();
    expect(pickNewLogId('07Lfirst', null)).toBe('07Lfirst');
    expect(pickNewLogId(null, '07Lold')).toBeNull();
  });
});

describe('apex-anonymous — history storage', () => {
  it('returns an empty array when nothing has been stored', async () => {
    expect(await readApexHistory()).toEqual([]);
  });

  it('prepends new entries (newest first) and dedupes identical code', async () => {
    await pushApexHistory({ code: 'a', ts: 1 });
    await pushApexHistory({ code: 'b', ts: 2 });
    await pushApexHistory({ code: 'a', ts: 3 }); // dedupes the earlier 'a'
    const hist = await readApexHistory();
    expect(hist.map((e) => e.code)).toEqual(['a', 'b']);
    expect(hist[0]?.ts).toBe(3);
  });

  it('caps history at HISTORY_CAP entries', async () => {
    for (let i = 0; i < HISTORY_CAP + 5; i++) {
      await pushApexHistory({ code: `code-${i}`, ts: i });
    }
    const hist = await readApexHistory();
    expect(hist).toHaveLength(HISTORY_CAP);
    // Most recent push is first.
    expect(hist[0]?.code).toBe(`code-${HISTORY_CAP + 4}`);
  });
});

describe('apex-anonymous — snippet storage', () => {
  it('returns an empty array when nothing has been stored', async () => {
    expect(await readApexSnippets()).toEqual([]);
  });

  it('prepends snippets and dedupes by name', async () => {
    await pushApexSnippet({ name: 'one', code: 'A' });
    await pushApexSnippet({ name: 'two', code: 'B' });
    await pushApexSnippet({ name: 'one', code: 'A2' }); // replaces by name
    const snips = await readApexSnippets();
    expect(snips.map((s) => s.name)).toEqual(['one', 'two']);
    expect(snips[0]?.code).toBe('A2');
  });
});

function fakeApi(overrides: Partial<SalesforceApiClient> = {}): SalesforceApiClient {
  return {
    apiGet: vi.fn(async () => okResult()),
    apiGetText: vi.fn(async () => 'LOG BODY'),
    apiRequest: vi.fn(async () => ({ id: 'created' })),
    toolingQuery: vi.fn(async () => ({ records: [], size: 0, done: true })),
    ...overrides,
  } as unknown as SalesforceApiClient;
}

describe('apex-anonymous — onActivate context gate', () => {
  beforeEach(() => clearBody());

  it('warns and does not open outside a Salesforce page', async () => {
    setNoneUrl();
    const api = fakeApi();
    const feature = createApexAnonymousFeature({ api });
    await feature.onActivate?.();
    await flush();
    expect(document.querySelector('.sfdt-view-overlay')).toBeNull();
    expect(document.querySelector('.sfdt-toast')?.textContent).toContain('run Apex');
  });
});

describe('apex-anonymous — execute (log capture off)', () => {
  beforeEach(async () => {
    clearBody();
    setSetupUrl();
    await seedSettings({ 'apex-anonymous': { captureLogs: false, historyEnabled: true } });
  });

  it('opens the modal with a default editor and Execute button', async () => {
    const feature = createApexAnonymousFeature({ api: fakeApi() });
    await feature.onActivate?.();
    await flush();
    const editor = document.querySelector<HTMLTextAreaElement>('.sfdt-view-overlay textarea')!;
    expect(editor.value).toContain('System.debug');
    const labels = Array.from(document.querySelectorAll('.sfdt-view-overlay button')).map((b) => b.textContent);
    expect(labels).toContain('Execute');
  });

  it('runs the code and reports success, recording history', async () => {
    const apiGet = vi.fn(async () => okResult());
    const feature = createApexAnonymousFeature({ api: fakeApi({ apiGet: apiGet as unknown as SalesforceApiClient['apiGet'] }) });
    await feature.onActivate?.();
    await flush();
    const runBtn = Array.from(document.querySelectorAll<HTMLButtonElement>('.sfdt-view-overlay button')).find(
      (b) => b.textContent === 'Execute',
    )!;
    runBtn.click();
    await flush();
    expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('executeAnonymous'), expect.objectContaining({ anonymousBody: expect.any(String) }));
    const overlayText = document.querySelector('.sfdt-view-overlay')?.textContent ?? '';
    expect(overlayText).toContain('✓ Success');
    expect(overlayText).toContain('Compiled and executed successfully.');
    // historyEnabled true → the run is recorded.
    expect((await readApexHistory()).length).toBe(1);
  });

  it('reports a compile error in the result pane', async () => {
    const api = fakeApi({
      apiGet: vi.fn(async () => okResult({ compiled: false, success: false, line: 2, column: 5, compileProblem: 'bad token' })) as unknown as SalesforceApiClient['apiGet'],
    });
    const feature = createApexAnonymousFeature({ api });
    await feature.onActivate?.();
    await flush();
    Array.from(document.querySelectorAll<HTMLButtonElement>('.sfdt-view-overlay button')).find((b) => b.textContent === 'Execute')!.click();
    await flush();
    const text = document.querySelector('.sfdt-view-overlay')?.textContent ?? '';
    expect(text).toContain('✗ Failed');
    expect(text).toContain('bad token');
  });

  it('warns and skips the API call for empty code', async () => {
    const apiGet = vi.fn(async () => okResult());
    const feature = createApexAnonymousFeature({ api: fakeApi({ apiGet: apiGet as unknown as SalesforceApiClient['apiGet'] }) });
    await feature.onActivate?.();
    await flush();
    const editor = document.querySelector<HTMLTextAreaElement>('.sfdt-view-overlay textarea')!;
    editor.value = '   ';
    Array.from(document.querySelectorAll<HTMLButtonElement>('.sfdt-view-overlay button')).find((b) => b.textContent === 'Execute')!.click();
    await flush();
    expect(apiGet).not.toHaveBeenCalled();
    expect(document.querySelector('.sfdt-toast')?.textContent).toContain('Enter some Apex');
  });

  it('shows the thrown error message when the run throws', async () => {
    const api = fakeApi({
      apiGet: vi.fn(async () => {
        throw new Error('REQUEST_LIMIT_EXCEEDED');
      }) as unknown as SalesforceApiClient['apiGet'],
    });
    const feature = createApexAnonymousFeature({ api });
    await feature.onActivate?.();
    await flush();
    Array.from(document.querySelectorAll<HTMLButtonElement>('.sfdt-view-overlay button')).find((b) => b.textContent === 'Execute')!.click();
    await flush();
    expect(document.querySelector('.sfdt-view-overlay')?.textContent).toContain('REQUEST_LIMIT_EXCEEDED');
  });

  it('Ctrl+Enter in the editor triggers execution', async () => {
    const apiGet = vi.fn(async () => okResult());
    const feature = createApexAnonymousFeature({ api: fakeApi({ apiGet: apiGet as unknown as SalesforceApiClient['apiGet'] }) });
    await feature.onActivate?.();
    await flush();
    const editor = document.querySelector<HTMLTextAreaElement>('.sfdt-view-overlay textarea')!;
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    await flush();
    expect(apiGet).toHaveBeenCalled();
  });

  it('Save snippet stores the editor contents under a prompted name', async () => {
    Object.defineProperty(window, 'prompt', { value: () => 'my snippet', configurable: true, writable: true });
    const feature = createApexAnonymousFeature({ api: fakeApi() });
    await feature.onActivate?.();
    await flush();
    Array.from(document.querySelectorAll<HTMLButtonElement>('.sfdt-view-overlay button')).find((b) => b.textContent === 'Save snippet')!.click();
    await flush();
    const snips = await readApexSnippets();
    expect(snips[0]?.name).toBe('my snippet');
  });

  it('does not record history when historyEnabled is false', async () => {
    await seedSettings({ 'apex-anonymous': { captureLogs: false, historyEnabled: false } });
    const feature = createApexAnonymousFeature({ api: fakeApi() });
    await feature.onActivate?.();
    await flush();
    Array.from(document.querySelectorAll<HTMLButtonElement>('.sfdt-view-overlay button')).find((b) => b.textContent === 'Execute')!.click();
    await flush();
    expect(await readApexHistory()).toEqual([]);
  });
});

describe('apex-anonymous — execute with log capture', () => {
  beforeEach(async () => {
    clearBody();
    setSetupUrl();
    await seedSettings({ 'apex-anonymous': { captureLogs: true, historyEnabled: false } });
  });

  it('arms the trace flag, captures the new log, and reveals Open log', async () => {
    let apexLogCalls = 0;
    const api = fakeApi({
      // executeAnonymous (POST-ish GET) + userinfo identity both go through apiGet.
      apiGet: vi.fn(async (endpoint: string) => {
        if (endpoint.includes('userinfo')) return { user_id: '005xx0000000001' };
        return okResult();
      }) as unknown as SalesforceApiClient['apiGet'],
      toolingQuery: vi.fn(async (soql: string) => {
        if (soql.includes('FROM TraceFlag')) {
          // An already-active flag → ensureTraceFlag returns without creating one.
          return { records: [{ Id: '7tfxx', ExpirationDate: '2999-01-01T00:00:00.000Z', DebugLevelId: '7dlxx' }], size: 1, done: true };
        }
        if (soql.includes('FROM ApexLog')) {
          apexLogCalls += 1;
          // First call = baseline (old log); subsequent poll returns a new id.
          return { records: [{ Id: apexLogCalls === 1 ? '07Lold' : '07Lnew' }], size: 1, done: true };
        }
        return { records: [], size: 0, done: true };
      }) as unknown as SalesforceApiClient['toolingQuery'],
      apiGetText: vi.fn(async () => 'EXECUTION_STARTED\nUSER_DEBUG|captured') as unknown as SalesforceApiClient['apiGetText'],
    });
    const feature = createApexAnonymousFeature({ api });
    await feature.onActivate?.();
    await flush();
    Array.from(document.querySelectorAll<HTMLButtonElement>('.sfdt-view-overlay button')).find((b) => b.textContent === 'Execute')!.click();
    await flush();

    const overlayText = document.querySelector('.sfdt-view-overlay')?.textContent ?? '';
    expect(overlayText).toContain('log ready');
    const openLogBtn = Array.from(document.querySelectorAll<HTMLButtonElement>('.sfdt-view-overlay button')).find(
      (b) => b.textContent === '🪵 Open log',
    )!;
    expect(openLogBtn.style.display).not.toBe('none');

    openLogBtn.click();
    await flush();
    expect(api.apiGetText).toHaveBeenCalledWith(expect.stringContaining('/ApexLog/07Lnew/Body'));
    expect(document.querySelector('.sfdt-view-overlay')?.textContent).toContain('USER_DEBUG|captured');
  });

  it('arms the trace flag with the picked DebugLevel from the picker', async () => {
    // Persist a pick; the picker restores it from this list on open.
    await writeSelectedDebugLevelId('7dlPICKED');
    const api = fakeApi({
      apiGet: vi.fn(async (endpoint: string) => {
        if (endpoint.includes('userinfo')) return { user_id: '005xx0000000001' };
        return okResult();
      }) as unknown as SalesforceApiClient['apiGet'],
      toolingQuery: vi.fn(async (soql: string) => {
        if (soql.includes('ORDER BY DeveloperName')) {
          return {
            records: [{ Id: '7dlPICKED', DeveloperName: 'Picked', MasterLabel: 'Picked Level' }],
            size: 1,
            done: true,
          };
        }
        if (soql.includes('FROM TraceFlag')) return { records: [], size: 0, done: true };
        if (soql.includes('FROM ApexLog')) return { records: [{ Id: '07Lbaseline' }], size: 1, done: true };
        return { records: [], size: 0, done: true };
      }) as unknown as SalesforceApiClient['toolingQuery'],
    });
    const feature = createApexAnonymousFeature({ api });
    await feature.onActivate?.();
    await flush();
    // The picker should have restored the persisted selection.
    const select = document.querySelector<HTMLSelectElement>('.sfdt-view-overlay select')!;
    expect(select.value).toBe('7dlPICKED');
    Array.from(document.querySelectorAll<HTMLButtonElement>('.sfdt-view-overlay button')).find(
      (b) => b.textContent === 'Execute',
    )!.click();
    await flush();
    // No active flag existed → a TraceFlag is created carrying the picked level.
    expect(api.apiRequest).toHaveBeenCalledWith(
      'POST',
      expect.stringContaining('/TraceFlag'),
      expect.objectContaining({ DebugLevelId: '7dlPICKED' }),
    );
  });

  it('notes "could not identify user" when no identity is resolvable', async () => {
    const api = fakeApi({
      apiGet: vi.fn(async (endpoint: string) => {
        if (endpoint.includes('userinfo')) throw new Error('no userinfo');
        if (endpoint.includes('chatter/users/me')) throw new Error('no chatter');
        return okResult();
      }) as unknown as SalesforceApiClient['apiGet'],
    });
    const feature = createApexAnonymousFeature({ api });
    await feature.onActivate?.();
    await flush();
    Array.from(document.querySelectorAll<HTMLButtonElement>('.sfdt-view-overlay button')).find((b) => b.textContent === 'Execute')!.click();
    await flush();
    expect(document.querySelector('.sfdt-view-overlay')?.textContent).toContain('could not identify user');
  });
});
