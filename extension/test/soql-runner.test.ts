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

const {
  columnsFromRecords,
  formatCell,
  recordsToCsv,
  generateLangGraphNode,
  HISTORY_CAP,
  readSavedQueries,
  writeSavedQueries,
  pushSavedQuery,
  deleteSavedQuery,
  DescribeCache,
  runQuery,
} = _soqlRunnerTestApi();

function fakeApi(overrides: Partial<SalesforceApiClient> = {}): SalesforceApiClient {
  return {
    apiVersion: 'v62.0',
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
    apiGet: vi.fn(async () => ({})),
    apiRequest: vi.fn(async () => ({})),
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

  describe('generateLangGraphNode', () => {
    it('infers Python types from the first record row', () => {
      const code = generateLangGraphNode('SELECT Name, Amount, IsWon FROM Opportunity', [
        { Name: 'Acme', Amount: 1000, IsWon: true },
      ]);
      expect(code).toContain('class SoqlResult(BaseModel):');
      expect(code).toContain('Name: str');
      expect(code).toContain('Amount: float');
      expect(code).toContain('IsWon: bool');
      expect(code).toContain('def execute_soql_node(');
    });

    it('embeds the supplied SOQL string in the node body', () => {
      const soql = 'SELECT Id FROM Account';
      expect(generateLangGraphNode(soql, [{ Id: '001' }])).toContain(soql);
    });

    it('falls back to a pass body when there are no records', () => {
      const code = generateLangGraphNode('SELECT Id FROM Account', []);
      expect(code).toContain('class SoqlResult(BaseModel):\n    pass');
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

  it('renders and updates autocomplete suggestions', async () => {
    setSalesforceUrl();
    const globalMock = vi.fn().mockResolvedValue({
      sobjects: [
        { name: 'Account', label: 'Account Label', keyPrefix: '001' },
        { name: 'Contact', label: 'Contact Label', keyPrefix: '003' }
      ]
    });
    const api = fakeApi({ apiGet: globalMock });
    const feature = createSoqlRunnerFeature({ api });
    await feature.onActivate?.();

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();

    textarea.value = 'SELECT Id FROM ';
    textarea.selectionStart = 15;
    textarea.selectionEnd = 15;
    textarea.dispatchEvent(new Event('input'));
    
    await vi.waitFor(() => {
      const title = document.querySelector('.sfut-soql-autocomplete-box span') as HTMLSpanElement;
      expect(title.textContent).toContain('Objects suggestions:');
    });

    const buttons = document.querySelectorAll('.sfut-soql-autocomplete-box button');
    const suggestionButtons = Array.from(buttons).filter(b => b.textContent && !b.textContent.includes('Expand') && !b.textContent.includes('Collapse'));
    expect(suggestionButtons.length).toBe(2);
    expect(suggestionButtons[0]!.textContent).toContain('Account');

    const accountBtn = suggestionButtons[0]! as HTMLButtonElement;
    accountBtn.click();

    expect(textarea.value).toBe('SELECT Id FROM Account ');
  });

  it('decorates cell text matching ID and shows options menu', async () => {
    setSalesforceUrl();
    const api = fakeApi({
      query: vi.fn(async () => ({
        totalSize: 1,
        done: true,
        records: [
          { Id: '001800000000001AAA', Name: 'Acme' },
        ],
      })) as unknown as SalesforceApiClient['query'],
    });
    const feature = createSoqlRunnerFeature({ api });
    await feature.onActivate?.();

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = 'SELECT Id, Name FROM Account LIMIT 1';
    const runBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === '▶ Run',
    );
    runBtn?.click();

    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const link = document.querySelector('tbody tr td a') as HTMLAnchorElement;
    expect(link).toBeTruthy();
    expect(link.textContent).toBe('001800000000001AAA');

    link.click();

    const menu = document.querySelector('.sfut-soql-cell-menu');
    expect(menu).toBeTruthy();

    const menuItems = menu?.querySelectorAll('div');
    expect(menuItems?.length).toBe(3);

    const queryRecordItem = Array.from(menuItems ?? []).find(el => el.textContent?.includes('Query Record'));
    expect(queryRecordItem).toBeTruthy();
    queryRecordItem?.click();

    expect(textarea.value).toContain("WHERE Id = '001800000000001AAA'");
    expect(document.querySelector('.sfut-soql-cell-menu')).toBeNull();
  });
});

describe('soql-runner — DescribeCache', () => {
  it('should call apiGet to fetch global sobjects and cache the result', async () => {
    const apiGetMock = vi.fn().mockResolvedValue({
      sobjects: [{ name: 'Account', label: 'Account', keyPrefix: '001' }]
    });
    const updateMock = vi.fn();
    const client = fakeApi({ apiGet: apiGetMock });
    const cache = new DescribeCache(client, updateMock);

    const first = cache.getGlobal('rest');
    expect(first.status).toBe('loading');

    await new Promise((r) => setTimeout(r, 0));

    expect(updateMock).toHaveBeenCalled();
    const second = cache.getGlobal('rest');
    expect(second.status).toBe('ready');
    expect(second.data?.sobjects[0]?.name).toBe('Account');
    expect(apiGetMock).toHaveBeenCalledTimes(1);
  });

  it('should call apiGet to fetch sobject describe and cache it', async () => {
    const apiGetMock = vi.fn().mockResolvedValue({
      name: 'Account',
      fields: [{ name: 'Name', label: 'Name', type: 'string' }]
    });
    const updateMock = vi.fn();
    const client = fakeApi({ apiGet: apiGetMock });
    const cache = new DescribeCache(client, updateMock);

    const first = cache.getSObject('rest', 'Account');
    expect(first.status).toBe('loading');

    await new Promise((r) => setTimeout(r, 0));

    expect(updateMock).toHaveBeenCalled();
    const second = cache.getSObject('rest', 'Account');
    expect(second.status).toBe('ready');
    expect(second.data?.name).toBe('Account');
    expect(apiGetMock).toHaveBeenCalledTimes(1);
  });
});

describe('soql-runner — runQuery', () => {
  it('should execute SOSL queries and return records', async () => {
    const apiGetMock = vi.fn().mockResolvedValue([
      { Id: '001', Name: 'SOSL Account' }
    ]);
    const client = fakeApi({ apiGet: apiGetMock });
    const result = await runQuery(client, 'FIND {Acme} IN ALL FIELDS', 'rest');
    
    expect(apiGetMock).toHaveBeenCalledWith(
      expect.stringContaining('/search'),
      { q: 'FIND {Acme} IN ALL FIELDS' }
    );
    expect(result.records).toEqual([{ Id: '001', Name: 'SOSL Account' }]);
  });

  it('should execute GraphQL queries and tabularize nested records', async () => {
    const apiRequestMock = vi.fn().mockResolvedValue({
      data: {
        uiapi: {
          query: {
            Account: {
              edges: [
                { node: { Id: '001', Name: 'GraphQL Account 1' } },
                { node: { Id: '002', Name: 'GraphQL Account 2' } }
              ]
            }
          }
        }
      }
    });
    const client = fakeApi({ apiRequest: apiRequestMock });
    const result = await runQuery(
      client,
      `query { uiapi { query { Account { edges { node { Id Name } } } } } }`,
      'rest'
    );

    expect(apiRequestMock).toHaveBeenCalledWith(
      'POST',
      expect.stringContaining('/graphql'),
      expect.objectContaining({
        query: expect.stringContaining('query {')
      })
    );
    expect(result.records).toEqual([
      { Id: '001', Name: 'GraphQL Account 1' },
      { Id: '002', Name: 'GraphQL Account 2' }
    ]);
  });

  it('should throw GraphQL errors even when the endpoint returns HTTP 200', async () => {
    const apiRequestMock = vi.fn().mockResolvedValue({
      data: null,
      errors: [
        { message: "Cannot query field 'Bogus' on type 'Account'" },
        { message: 'Validation error of type FieldUndefined' }
      ]
    });
    const client = fakeApi({ apiRequest: apiRequestMock });

    await expect(
      runQuery(client, `query { uiapi { query { Account { edges { node { Bogus } } } } } }`, 'rest')
    ).rejects.toThrow("Cannot query field 'Bogus' on type 'Account'");
  });
});

describe('soql-runner — Saved Queries storage', () => {
  beforeEach(async () => {
    await writeSavedQueries([]);
  });

  it('should read, write, and push saved queries', async () => {
    const initial = await readSavedQueries();
    expect(initial).toEqual([]);

    const query1 = { name: 'Query One', q: 'SELECT Id FROM Account', api: 'rest' as const };
    await pushSavedQuery(query1);

    const afterPush = await readSavedQueries();
    expect(afterPush).toEqual([query1]);

    const query2 = { name: 'Query One', q: 'SELECT Name FROM Account', api: 'tooling' as const };
    await pushSavedQuery(query2);

    const afterDedupe = await readSavedQueries();
    expect(afterDedupe).toEqual([query2]);
  });

  it('should delete a saved query by name', async () => {
    const q1 = { name: 'Q1', q: 'SELECT Id FROM Contact', api: 'rest' as const };
    const q2 = { name: 'Q2', q: 'SELECT Id FROM Opportunity', api: 'rest' as const };
    await writeSavedQueries([q1, q2]);

    await deleteSavedQuery('Q1');
    const back = await readSavedQueries();
    expect(back).toEqual([q2]);
  });
});
