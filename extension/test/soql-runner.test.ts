import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createSoqlRunnerFeature,
  _soqlRunnerTestApi,
  readSoqlHistory,
  writeSoqlHistory,
  pushSoqlHistory,
  clearSoqlHistory,
} from '../features/soql-runner.js';
import { _resetSettingsShapesForTests, _clearSettingsCacheForTests } from '../lib/settings.js';
import type { SalesforceApiClient, QueryEnvelope } from '../lib/salesforce-api.js';

const { columnsFromRecords, formatCell, recordsToCsv, HISTORY_CAP } = _soqlRunnerTestApi();

function fakeApi(overrides: Partial<SalesforceApiClient> = {}): SalesforceApiClient {
  return {
    query: vi.fn(async (_soql: string) => ({
      totalSize: 0,
      done: true,
      records: [],
    } as QueryEnvelope<Record<string, unknown>>)),
    toolingQuery: vi.fn(async (_soql: string) => ({
      size: 0,
      done: true,
      records: [],
    })),
    queryMore: vi.fn(async (_url: string) => ({
      totalSize: 0,
      done: true,
      records: [],
    } as QueryEnvelope<Record<string, unknown>>)),
    ...overrides,
  } as unknown as SalesforceApiClient;
}

function clearBody(): void {
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
}

beforeEach(() => {
  _resetSettingsShapesForTests();
  _clearSettingsCacheForTests();
  clearBody();
});

describe('soql-runner — pure helpers', () => {
  describe('columnsFromRecords', () => {
    it('returns the union of keys across all records, in first-seen order', () => {
      expect(
        columnsFromRecords([
          { Id: '1', Name: 'A' },
          { Id: '2', CreatedDate: 'today' },
        ]),
      ).toEqual(['Id', 'Name', 'CreatedDate']);
    });

    it('skips the Salesforce `attributes` envelope', () => {
      expect(
        columnsFromRecords([
          { attributes: { type: 'Account' }, Id: '1', Name: 'A' },
        ]),
      ).toEqual(['Id', 'Name']);
    });

    it('returns an empty list for an empty record set', () => {
      expect(columnsFromRecords([])).toEqual([]);
    });
  });

  describe('formatCell', () => {
    it('renders primitives as strings', () => {
      expect(formatCell('hello')).toBe('hello');
      expect(formatCell(42)).toBe('42');
      expect(formatCell(true)).toBe('true');
    });

    it('renders null/undefined as empty', () => {
      expect(formatCell(null)).toBe('');
      expect(formatCell(undefined)).toBe('');
    });

    it('JSON-stringifies nested objects and arrays', () => {
      expect(formatCell({ x: 1 })).toBe('{"x":1}');
      expect(formatCell([1, 2])).toBe('[1,2]');
    });
  });

  describe('recordsToCsv', () => {
    it('returns empty string for no records', () => {
      expect(recordsToCsv([])).toBe('');
    });

    it('produces a header row + data rows', () => {
      const csv = recordsToCsv([
        { Id: '1', Name: 'Acme' },
        { Id: '2', Name: 'Universal' },
      ]);
      expect(csv).toBe('Id,Name\n1,Acme\n2,Universal');
    });

    it('escapes commas, quotes, and newlines per RFC 4180', () => {
      const csv = recordsToCsv([
        { Name: 'A, B', Notes: 'has "quotes"', Body: 'line1\nline2' },
      ]);
      expect(csv).toBe('Name,Notes,Body\n"A, B","has ""quotes""","line1\nline2"');
    });
  });
});

describe('soql-runner — history storage', () => {
  it('round-trips entries through chrome.storage.local', async () => {
    await writeSoqlHistory([
      { q: 'SELECT Id FROM Account', api: 'rest', ts: 1 },
    ]);
    const back = await readSoqlHistory();
    expect(back).toEqual([{ q: 'SELECT Id FROM Account', api: 'rest', ts: 1 }]);
  });

  it('caps the persisted list at HISTORY_CAP entries', async () => {
    const many = Array.from({ length: HISTORY_CAP + 5 }, (_, i) => ({
      q: `Q${i}`,
      api: 'rest' as const,
      ts: i,
    }));
    await writeSoqlHistory(many);
    const back = await readSoqlHistory();
    expect(back).toHaveLength(HISTORY_CAP);
    expect(back[0]?.q).toBe('Q0');
  });

  it('dedupes by (q, api) when pushing — newest entry wins', async () => {
    await pushSoqlHistory({ q: 'SELECT Id FROM Account', api: 'rest', ts: 1 });
    await pushSoqlHistory({ q: 'SELECT Id FROM Contact', api: 'rest', ts: 2 });
    await pushSoqlHistory({ q: 'SELECT Id FROM Account', api: 'rest', ts: 3 });
    const back = await readSoqlHistory();
    expect(back).toHaveLength(2);
    expect(back[0]).toEqual({ q: 'SELECT Id FROM Account', api: 'rest', ts: 3 });
  });

  it('treats the same query under a different API as a distinct entry', async () => {
    await pushSoqlHistory({ q: 'SELECT Id FROM Flow', api: 'rest', ts: 1 });
    await pushSoqlHistory({ q: 'SELECT Id FROM Flow', api: 'tooling', ts: 2 });
    const back = await readSoqlHistory();
    expect(back).toHaveLength(2);
  });

  it('clears history via clearSoqlHistory()', async () => {
    await pushSoqlHistory({ q: 'x', api: 'rest', ts: 1 });
    await clearSoqlHistory();
    const back = await readSoqlHistory();
    expect(back).toEqual([]);
  });
});

describe('soql-runner — feature manifest', () => {
  it('declares the four expected contexts and the settings schema', () => {
    const feature = createSoqlRunnerFeature({ api: fakeApi() });
    expect(feature.manifest.id).toBe('soql-runner');
    expect(feature.manifest.name).toBe('SOQL Query Runner');
    expect(feature.manifest.contexts).toEqual([
      'setup_flows',
      'setup_other',
      'flow_builder',
      'flow_trigger_explorer',
    ]);
    expect(feature.manifest.settingsSchema).toBeDefined();
  });
});

describe('soql-runner — modal execution', () => {
  function setSalesforceUrl(): void {
    window.history.replaceState(
      {},
      '',
      'https://x.lightning.force.com/lightning/setup/Flows/home',
    );
  }

  it('renders results when query() returns records', async () => {
    setSalesforceUrl();
    const api = fakeApi({
      query: vi.fn(async () => ({
        totalSize: 2,
        done: true,
        records: [
          { Id: '001', Name: 'Acme' },
          { Id: '002', Name: 'Universal' },
        ],
      })) as unknown as SalesforceApiClient['query'],
    });
    const feature = createSoqlRunnerFeature({ api });
    await feature.onActivate?.();

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = 'SELECT Id, Name FROM Account LIMIT 2';
    const runBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === '▶ Run',
    );
    runBtn?.click();

    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(api.query).toHaveBeenCalledWith('SELECT Id, Name FROM Account LIMIT 2');
    const tables = document.querySelectorAll('table');
    expect(tables).toHaveLength(1);
    const headers = Array.from(document.querySelectorAll('th')).map((th) => th.textContent);
    expect(headers).toEqual(['Id', 'Name']);
    const dataRows = document.querySelectorAll('tbody tr');
    expect(dataRows).toHaveLength(2);
  });

  it('routes Tooling mode through toolingQuery()', async () => {
    setSalesforceUrl();
    const api = fakeApi({
      toolingQuery: vi.fn(async () => ({
        size: 1,
        done: true,
        records: [{ Id: '300', DeveloperName: 'My_Flow' }],
      })) as unknown as SalesforceApiClient['toolingQuery'],
    });
    const feature = createSoqlRunnerFeature({ api });
    await feature.onActivate?.();

    const toolingBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Tooling',
    );
    toolingBtn?.click();

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = 'SELECT Id, DeveloperName FROM FlowDefinition';
    const runBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === '▶ Run',
    );
    runBtn?.click();

    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(api.toolingQuery).toHaveBeenCalled();
    expect(api.query).not.toHaveBeenCalled();
  });

  it('renders an error panel when the API throws', async () => {
    setSalesforceUrl();
    const api = fakeApi({
      query: vi.fn(async () => {
        throw new Error("INVALID_FIELD: No such column 'Foo' on entity 'Account'");
      }) as unknown as SalesforceApiClient['query'],
    });
    const feature = createSoqlRunnerFeature({ api });
    await feature.onActivate?.();

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = 'SELECT Foo FROM Account';
    const runBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === '▶ Run',
    );
    runBtn?.click();

    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const errorText = document.body.textContent ?? '';
    expect(errorText).toContain('INVALID_FIELD');
  });

  it('paginates via queryMore() when the envelope is not done', async () => {
    setSalesforceUrl();
    const api = fakeApi({
      query: vi.fn(async () => ({
        totalSize: 3,
        done: false,
        nextRecordsUrl: '/services/data/v62.0/query/01gxx-2000',
        records: [{ Id: '001' }],
      })) as unknown as SalesforceApiClient['query'],
      queryMore: vi.fn(async () => ({
        totalSize: 3,
        done: true,
        records: [{ Id: '002' }, { Id: '003' }],
      })) as unknown as SalesforceApiClient['queryMore'],
    });
    const feature = createSoqlRunnerFeature({ api });
    await feature.onActivate?.();

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = 'SELECT Id FROM Account';
    const runBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === '▶ Run',
    );
    runBtn?.click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(document.querySelectorAll('tbody tr')).toHaveLength(1);
    const loadMoreBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Load more',
    );
    expect(loadMoreBtn).toBeTruthy();
    loadMoreBtn?.click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(api.queryMore).toHaveBeenCalledWith('/services/data/v62.0/query/01gxx-2000');
    expect(document.querySelectorAll('tbody tr')).toHaveLength(3);
  });
});
