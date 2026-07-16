import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createSoqlRunnerFeature,
  _soqlRunnerTestApi,
  readSoqlHistory,
  writeSoqlHistory,
  pushSoqlHistory,
  clearSoqlHistory,
  writePendingQuery,
  takePendingQuery,
} from '../features/soql-runner.js';
import { _resetSettingsShapesForTests, _clearSettingsCacheForTests } from '../lib/settings.js';
import type { SalesforceApiClient, QueryEnvelope } from '../lib/salesforce-api.js';

const {
  columnsFromRecords,
  formatCell,
  recordsToCsv,
  exportAllToCsv,
  recordsToJson,
  recordsToTsv,
  generateLangGraphNode,
  HISTORY_CAP,
  readSavedQueries,
  writeSavedQueries,
  pushSavedQuery,
  deleteSavedQuery,
  DescribeCache,
  runQuery,
  explainQuery,
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

  describe('exportAllToCsv', () => {
    // Builds a fake api whose queryMore walks a fixed list of pages.
    function pagedApi(pages: Array<Record<string, unknown>>[]): SalesforceApiClient {
      let idx = 0; // pages[0] is the "first" envelope; queryMore serves the rest
      const envelope = (i: number): QueryEnvelope<Record<string, unknown>> => ({
        records: pages[i]!,
        done: i >= pages.length - 1,
        nextRecordsUrl: i >= pages.length - 1 ? undefined : `/next/${i + 1}`,
        totalSize: pages.reduce((n, p) => n + p.length, 0),
      });
      return fakeApi({
        queryMore: vi.fn(async () => {
          idx += 1;
          return envelope(idx);
        }) as unknown as SalesforceApiClient['queryMore'],
      });
    }

    it('follows pagination across 3 pages into one CSV with every row exactly once', async () => {
      const pages = [
        [{ Id: '1', Name: 'A' }, { Id: '2', Name: 'B' }],
        [{ Id: '3', Name: 'C' }, { Id: '4', Name: 'D' }],
        [{ Id: '5', Name: 'E' }],
      ];
      const api = pagedApi(pages);
      const first: QueryEnvelope<Record<string, unknown>> = {
        records: pages[0]!,
        done: false,
        nextRecordsUrl: '/next/1',
        totalSize: 5,
      };

      const result = await exportAllToCsv(api, first);
      expect(result.canceled).toBe(false);
      expect(result.pages).toBe(3);
      expect(result.rows).toBe(5);
      expect(api.queryMore).toHaveBeenCalledTimes(2);

      const csv = result.parts.join('');
      // one header, five data rows, no dupes/missing
      expect(csv).toBe('Id,Name\n1,A\n2,B\n3,C\n4,D\n5,E\n');
      for (const id of ['1', '2', '3', '4', '5']) {
        expect(csv.split(`\n${id},`).length).toBe(2); // appears exactly once
      }
    });

    it('reports progress once per page', async () => {
      const pages = [[{ Id: '1' }], [{ Id: '2' }], [{ Id: '3' }]];
      const api = pagedApi(pages);
      const seen: number[] = [];
      await exportAllToCsv(
        api,
        { records: pages[0]!, done: false, nextRecordsUrl: '/next/1' },
        { onProgress: ({ pages: p }) => seen.push(p) },
      );
      expect(seen).toEqual([1, 2, 3]);
    });

    it('aborts the loop mid-export when the signal is already aborted', async () => {
      const pages = [[{ Id: '1' }], [{ Id: '2' }], [{ Id: '3' }]];
      const api = pagedApi(pages);
      const controller = new AbortController();
      controller.abort();
      const result = await exportAllToCsv(
        api,
        { records: pages[0]!, done: false, nextRecordsUrl: '/next/1' },
        { signal: controller.signal },
      );
      expect(result.canceled).toBe(true);
      expect(api.queryMore).not.toHaveBeenCalled(); // stopped before paging further
      expect(result.rows).toBe(1); // only the already-fetched first page
    });

    it('cancels a single-page (already-done) export instead of returning success', async () => {
      const api = pagedApi([[{ Id: '1' }]]);
      const controller = new AbortController();
      controller.abort();
      const result = await exportAllToCsv(
        api,
        { records: [{ Id: '1' }], done: true }, // no nextRecordsUrl → loop never runs
        { signal: controller.signal },
      );
      expect(result.canceled).toBe(true); // BUG2: must observe the abort even single-page
      expect(api.queryMore).not.toHaveBeenCalled();
    });

    it('stops without emitting a page when aborted mid-fetch', async () => {
      const controller = new AbortController();
      const seen: number[] = [];
      // queryMore aborts as it resolves page 2, so the abort lands after the
      // await but before the page is processed.
      const api = fakeApi({
        queryMore: vi.fn(async () => {
          controller.abort();
          return { records: [{ Id: '2' }], done: true } as QueryEnvelope<Record<string, unknown>>;
        }) as unknown as SalesforceApiClient['queryMore'],
      });
      const result = await exportAllToCsv(
        api,
        { records: [{ Id: '1' }], done: false, nextRecordsUrl: '/next/1' },
        { signal: controller.signal, onProgress: ({ pages }) => seen.push(pages) },
      );
      expect(result.canceled).toBe(true);
      expect(result.rows).toBe(1); // page 2 fetched but not appended
      expect(seen).toEqual([1]); // no trailing progress for the discarded page
    });
  });

  describe('recordsToJson', () => {
    it('returns an empty array for no records', () => {
      expect(recordsToJson([])).toBe('[]');
      expect(() => JSON.parse(recordsToJson([]))).not.toThrow();
    });

    it('pretty-prints the records array (2-space indent) and stays valid JSON', () => {
      const json = recordsToJson([
        { Id: '1', Name: 'Acme' },
        { Id: '2', Name: 'Universal' },
      ]);
      expect(json).toBe(
        '[\n  {\n    "Id": "1",\n    "Name": "Acme"\n  },\n  {\n    "Id": "2",\n    "Name": "Universal"\n  }\n]',
      );
      expect(JSON.parse(json)).toEqual([
        { Id: '1', Name: 'Acme' },
        { Id: '2', Name: 'Universal' },
      ]);
    });

    it('drops the Salesforce `attributes` envelope but keeps nested structure', () => {
      const json = recordsToJson([
        {
          attributes: { type: 'Account', url: '/x' },
          Name: 'Acme',
          Owner: { Name: 'Rep' },
        },
      ]);
      expect(JSON.parse(json)).toEqual([{ Name: 'Acme', Owner: { Name: 'Rep' } }]);
    });

    it('produces valid JSON when values contain quotes, tabs, and newlines', () => {
      const json = recordsToJson([
        { Notes: 'has "quotes"\tand a tab', Body: 'line1\nline2' },
      ]);
      // Round-trips losslessly — the delimiters do not corrupt the output.
      expect(JSON.parse(json)).toEqual([
        { Notes: 'has "quotes"\tand a tab', Body: 'line1\nline2' },
      ]);
    });
  });

  describe('recordsToTsv', () => {
    it('returns empty string for no records', () => {
      expect(recordsToTsv([])).toBe('');
    });

    it('produces a tab-delimited header row + data rows', () => {
      const tsv = recordsToTsv([
        { Id: '1', Name: 'Acme' },
        { Id: '2', Name: 'Universal' },
      ]);
      expect(tsv).toBe('Id\tName\n1\tAcme\n2\tUniversal');
    });

    it('quotes/escapes values containing tabs, newlines, and quotes so columns do not break', () => {
      const tsv = recordsToTsv([
        { Name: 'A\tB', Notes: 'has "quotes"', Body: 'line1\nline2' },
      ]);
      expect(tsv).toBe('Name\tNotes\tBody\n"A\tB"\t"has ""quotes"""\t"line1\nline2"');
    });

    it('leaves comma-containing values unquoted (TSV, not CSV)', () => {
      const tsv = recordsToTsv([{ Name: 'A, B' }]);
      expect(tsv).toBe('Name\nA, B');
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

  // Interaction between "Export all" and the sibling Run/Explain/Load-more
  // actions that share `status` and the result panels.
  describe('Export-all concurrency', () => {
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const btn = (t: string) =>
      Array.from(document.querySelectorAll('button')).find((b) => b.textContent === t);

    let origCreate: typeof URL.createObjectURL;
    let origRevoke: typeof URL.revokeObjectURL;
    let createObjectURL: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      origCreate = URL.createObjectURL;
      origRevoke = URL.revokeObjectURL;
      createObjectURL = vi.fn(() => 'blob:mock');
      URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
      URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
    });
    afterEach(() => {
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
    });

    // Runs one query (page 1, done:false) so the "Export all" button appears,
    // then starts an export that stalls awaiting queryMore.
    async function startStalledExport(release: { fn: (v: unknown) => void }) {
      setSalesforceUrl();
      const queryMore = vi.fn(
        () => new Promise((res) => { release.fn = res as (v: unknown) => void; }),
      );
      const api = fakeApi({
        query: vi.fn(async () => ({
          totalSize: 3, done: false, nextRecordsUrl: '/next/1', records: [{ Id: '1' }],
        })) as unknown as SalesforceApiClient['query'],
        queryMore: queryMore as unknown as SalesforceApiClient['queryMore'],
        apiGet: vi.fn(async () => ({ plans: [{ relativeCost: 0.5 }] })) as unknown as SalesforceApiClient['apiGet'],
      });
      const feature = createSoqlRunnerFeature({ api });
      await feature.onActivate?.();
      (document.querySelector('textarea') as HTMLTextAreaElement).value = 'SELECT Id FROM Account';
      btn('▶ Run')!.click();
      await tick(); await tick();
      btn('Export all as CSV')!.click();
      await tick(); await tick(); // page-1 resolves, onProgress fires, now stalled on queryMore
      return api;
    }

    it('Explain aborts an in-flight export, hides Cancel, and the late export result cannot overwrite the plan status', async () => {
      const release = { fn: (_: unknown) => {} };
      await startStalledExport(release);

      const cancelBtn = btn('Cancel')!;
      expect(cancelBtn.style.display).not.toBe('none'); // visible while exporting

      btn('🔎 Explain')!.click();
      await tick(); await tick();

      expect(cancelBtn.style.display).toBe('none'); // abortExport() hid it
      const status = document.querySelector('[role="status"]') as HTMLElement;
      expect(status.textContent).toContain('query plan');
      const planStatus = status.textContent;

      // Release the stalled export — it must stay silent (superseded).
      release.fn({ done: true, records: [{ Id: '2' }] });
      await tick(); await tick();
      expect(status.textContent).toBe(planStatus); // export did NOT stomp the plan
      expect(createObjectURL).not.toHaveBeenCalled(); // and produced no download
    });

    it('Cancel during a stalled page fetch produces no download', async () => {
      const release = { fn: (_: unknown) => {} };
      await startStalledExport(release);

      btn('Cancel')!.click(); // abort while queryMore is still pending
      await tick();
      // Page fetch completes AFTER cancel (worker fetch can't be network-aborted).
      release.fn({ done: true, records: [{ Id: '2' }] });
      await tick(); await tick();

      expect(createObjectURL).not.toHaveBeenCalled(); // canceled ⇒ no file
      expect(btn('Cancel')!.style.display).toBe('none'); // UI reset
    });
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
      const title = document.querySelector('.sfdt-soql-autocomplete-box span') as HTMLSpanElement;
      expect(title.textContent).toContain('Objects suggestions:');
    });

    const buttons = document.querySelectorAll('.sfdt-soql-autocomplete-box button');
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

    const menu = document.querySelector('.sfdt-soql-cell-menu');
    expect(menu).toBeTruthy();

    const menuItems = menu?.querySelectorAll('div');
    expect(menuItems?.length).toBe(3);

    const queryRecordItem = Array.from(menuItems ?? []).find(el => el.textContent?.includes('Query Record'));
    expect(queryRecordItem).toBeTruthy();
    queryRecordItem?.click();

    expect(textarea.value).toContain("WHERE Id = '001800000000001AAA'");
    expect(document.querySelector('.sfdt-soql-cell-menu')).toBeNull();
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

describe('soql-runner — pending query handoff', () => {
  it('round-trips a pending query and clears it on take', async () => {
    await writePendingQuery({ q: 'SELECT Id FROM Lead', api: 'rest' });
    const first = await takePendingQuery();
    expect(first).toEqual({ q: 'SELECT Id FROM Lead', api: 'rest' });
    // Second take returns null — the entry was consumed.
    expect(await takePendingQuery()).toBeNull();
  });

  it('returns null when no pending query is present', async () => {
    expect(await takePendingQuery()).toBeNull();
  });

  it('returns null for a malformed pending entry', async () => {
    await new Promise<void>((resolve) =>
      chrome.storage.local.set({ 'soqlRunner.pendingQuery': { api: 'rest' } }, () => resolve()),
    );
    expect(await takePendingQuery()).toBeNull();
  });
});

describe('soql-runner — DescribeCache extra branches', () => {
  it('targets the tooling endpoints in tooling mode', async () => {
    const apiGet = vi.fn().mockResolvedValue({ sobjects: [] });
    const cache = new DescribeCache(fakeApi({ apiGet }), vi.fn());
    cache.getGlobal('tooling');
    cache.getSObject('tooling', 'Account');
    expect(apiGet).toHaveBeenNthCalledWith(1, '/services/data/v62.0/tooling/sobjects/');
    expect(apiGet).toHaveBeenNthCalledWith(
      2,
      '/services/data/v62.0/tooling/sobjects/Account/describe',
    );
  });

  it('returns the cached entry without re-fetching', () => {
    const apiGet = vi.fn().mockResolvedValue({ sobjects: [] });
    const cache = new DescribeCache(fakeApi({ apiGet }), vi.fn());
    cache.getGlobal('rest');
    cache.getGlobal('rest'); // second synchronous call hits the loading cache
    cache.getSObject('rest', 'Account');
    cache.getSObject('rest', 'Account');
    expect(apiGet).toHaveBeenCalledTimes(2);
  });

  it('records an error status when the describe call rejects', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const apiGet = vi.fn().mockRejectedValue(new Error('boom'));
    const update = vi.fn();
    const cache = new DescribeCache(fakeApi({ apiGet }), update);
    cache.getGlobal('rest');
    cache.getSObject('rest', 'Account');
    await new Promise((r) => setTimeout(r, 0));
    expect(cache.getGlobal('rest').status).toBe('error');
    expect(cache.getSObject('rest', 'Account').status).toBe('error');
    err.mockRestore();
  });

  it('substitutes a safe shape when the payload lacks the expected arrays', async () => {
    const apiGet = vi.fn(async (endpoint: string) =>
      endpoint.includes('/describe') ? { name: 'Account' } : { foo: 'bar' },
    );
    const cache = new DescribeCache(
      fakeApi({ apiGet: apiGet as unknown as SalesforceApiClient['apiGet'] }),
      vi.fn(),
    );
    cache.getGlobal('rest');
    cache.getSObject('rest', 'Account');
    await new Promise((r) => setTimeout(r, 0));
    expect(cache.getGlobal('rest').data?.sobjects).toEqual([]);
    expect(cache.getSObject('rest', 'Account').data?.fields).toEqual([]);
  });

  it('clear() drops every cached describe', async () => {
    const apiGet = vi.fn().mockResolvedValue({ sobjects: [] });
    const cache = new DescribeCache(fakeApi({ apiGet }), vi.fn());
    cache.getGlobal('rest');
    await new Promise((r) => setTimeout(r, 0));
    cache.clear();
    cache.getGlobal('rest');
    expect(apiGet).toHaveBeenCalledTimes(2);
  });
});

describe('soql-runner — runQuery extra branches', () => {
  it('routes plain SOQL through toolingQuery in tooling mode', async () => {
    const toolingQuery = vi.fn().mockResolvedValue({ size: 1, done: true, records: [{ Id: 'x' }] });
    const client = fakeApi({ toolingQuery });
    const result = await runQuery(client, 'SELECT Id FROM FlowDefinition', 'tooling');
    expect(toolingQuery).toHaveBeenCalledWith('SELECT Id FROM FlowDefinition');
    expect(result.records).toEqual([{ Id: 'x' }]);
  });

  it('routes plain SOQL through query in rest mode', async () => {
    const query = vi.fn().mockResolvedValue({ totalSize: 0, done: true, records: [] });
    const client = fakeApi({ query });
    await runQuery(client, 'SELECT Id FROM Account', 'rest');
    expect(query).toHaveBeenCalledWith('SELECT Id FROM Account');
  });

  it('wraps a GraphQL response with no edges/nodes as a single record', async () => {
    const apiRequest = vi.fn().mockResolvedValue({ data: { uiapi: { somethingElse: 1 } } });
    const result = await runQuery(fakeApi({ apiRequest }), 'query { uiapi { x } }', 'rest');
    expect(result.records).toEqual([{ data: { uiapi: { somethingElse: 1 } } }]);
  });

  it('falls back to a generic GraphQL error when no messages are present', async () => {
    const apiRequest = vi.fn().mockResolvedValue({ data: null, errors: [{}, {}] });
    await expect(
      runQuery(fakeApi({ apiRequest }), 'query { uiapi { x } }', 'rest'),
    ).rejects.toThrow('GraphQL query failed.');
  });
});

describe('soql-runner — explainQuery request shape', () => {
  it('hits the REST query endpoint with the explain param in rest mode', async () => {
    const apiGet = vi.fn().mockResolvedValue({ plans: [] });
    await explainQuery(fakeApi({ apiGet }), 'SELECT Id FROM Account', 'rest');
    expect(apiGet).toHaveBeenCalledWith('/services/data/v62.0/query', {
      explain: 'SELECT Id FROM Account',
    });
  });

  it('hits the Tooling query endpoint with the explain param in tooling mode', async () => {
    const apiGet = vi.fn().mockResolvedValue({ plans: [] });
    await explainQuery(fakeApi({ apiGet }), 'SELECT Id FROM ApexClass', 'tooling');
    expect(apiGet).toHaveBeenCalledWith('/services/data/v62.0/tooling/query', {
      explain: 'SELECT Id FROM ApexClass',
    });
  });

  it('returns the plans array and tolerates a missing plans key', async () => {
    expect(
      await explainQuery(fakeApi({ apiGet: vi.fn().mockResolvedValue({ plans: [{ relativeCost: 1 }] }) }), 'q', 'rest'),
    ).toEqual([{ relativeCost: 1 }]);
    expect(
      await explainQuery(fakeApi({ apiGet: vi.fn().mockResolvedValue({}) }), 'q', 'rest'),
    ).toEqual([]);
  });
});

describe('soql-runner — Explain modal', () => {
  function setSalesforceUrl(): void {
    window.history.replaceState(
      {},
      '',
      'https://x.lightning.force.com/lightning/setup/Flows/home',
    );
  }
  async function flush(): Promise<void> {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  }
  function findButton(text: string): HTMLButtonElement | undefined {
    return Array.from(document.querySelectorAll('button')).find((b) => b.textContent === text);
  }

  it('renders the query plan from a canned explain response', async () => {
    setSalesforceUrl();
    const api = fakeApi({
      apiGet: vi.fn(async () => ({
        plans: [
          {
            cardinality: 1,
            sobjectCardinality: 42,
            leadingOperationType: 'TableScan',
            relativeCost: 2.8,
            sobjectType: 'Account',
            notes: [{ description: 'Not considering filter for optimization because unindexed' }],
          },
        ],
      })) as unknown as SalesforceApiClient['apiGet'],
    });
    const feature = createSoqlRunnerFeature({ api });
    await feature.onActivate?.();

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = 'SELECT Id FROM Account';
    findButton('🔎 Explain')?.click();
    await flush();

    expect(api.apiGet).toHaveBeenCalledWith('/services/data/v62.0/query', {
      explain: 'SELECT Id FROM Account',
    });
    const rowLabels = Array.from(document.querySelectorAll('th[scope="row"]')).map((th) => th.textContent);
    expect(rowLabels).toEqual([
      'Cardinality',
      'SObject cardinality',
      'Leading operation',
      'Relative cost',
      'Notes',
    ]);
    const bodyText = document.body.textContent ?? '';
    expect(bodyText).toContain('TableScan');
    expect(bodyText).toContain('2.8');
    expect(bodyText).toContain('unindexed');
    expect(bodyText).toContain('Account (chosen)');
  });

  it('surfaces a non-explainable query error inline via a role="alert" panel', async () => {
    setSalesforceUrl();
    const api = fakeApi({
      apiGet: vi.fn(async () => {
        throw new Error('Salesforce GET request failed (HTTP 400): explain not supported');
      }) as unknown as SalesforceApiClient['apiGet'],
    });
    const feature = createSoqlRunnerFeature({ api });
    await feature.onActivate?.();

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = 'FIND {Acme} IN ALL FIELDS';
    findButton('🔎 Explain')?.click();
    await flush();

    const alert = document.querySelector('[role="alert"]') as HTMLElement | null;
    expect(alert).toBeTruthy();
    expect(alert?.textContent).toContain('explain not supported');
    // The error is inline, not a thrown toast.
    expect(document.querySelector('.sfdt-toast')).toBeNull();
    expect(document.querySelectorAll('table')).toHaveLength(0);
  });

  it('shows an error when explaining an empty query', async () => {
    setSalesforceUrl();
    const api = fakeApi();
    const feature = createSoqlRunnerFeature({ api });
    await feature.onActivate?.();
    findButton('🔎 Explain')?.click();
    await flush();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'Enter a SOQL query to explain.',
    );
    expect(api.apiGet).not.toHaveBeenCalled();
  });

  it('hides the stale results table + footer actions when a plan renders', async () => {
    setSalesforceUrl();
    const api = fakeApi({
      query: vi.fn(async () => ({
        totalSize: 1,
        done: true,
        records: [{ Id: '001', Name: 'Acme' }],
      })) as unknown as SalesforceApiClient['query'],
      apiGet: vi.fn(async () => ({ plans: [{ relativeCost: 1 }] })) as unknown as SalesforceApiClient['apiGet'],
    });
    const feature = createSoqlRunnerFeature({ api });
    await feature.onActivate?.();

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = 'SELECT Id, Name FROM Account';
    findButton('▶ Run')?.click();
    await flush();
    // Results + footer actions are visible after a query.
    expect(findButton('Copy CSV')?.style.display).not.toBe('none');

    findButton('🔎 Explain')?.click();
    await flush();
    // The plan replaced the table; the table's footer actions are hidden so they
    // can't act on the now-hidden stale result set.
    const resultsTable = document.querySelector('table');
    expect(resultsTable).toBeTruthy(); // this is the plan table
    for (const label of ['Load more', 'Copy CSV', 'Export CSV', 'LangGraph Node']) {
      expect(findButton(label)?.style.display).toBe('none');
    }
  });

  it('disables both Run and Explain while a request is in flight, re-enabling both after', async () => {
    setSalesforceUrl();
    let resolveQuery!: (v: QueryEnvelope<Record<string, unknown>>) => void;
    const api = fakeApi({
      query: vi.fn(() => new Promise((res) => { resolveQuery = res; })) as unknown as SalesforceApiClient['query'],
    });
    const feature = createSoqlRunnerFeature({ api });
    await feature.onActivate?.();

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = 'SELECT Id FROM Account';
    const runBtn = findButton('▶ Run')!;
    const explainBtn = findButton('🔎 Explain')!;
    runBtn.click();
    await flush();

    // Run is pending — BOTH buttons are disabled (Explain can't race it).
    expect(runBtn.disabled).toBe(true);
    expect(explainBtn.disabled).toBe(true);
    // A guarded second call is a no-op while busy: apiGet (explain) never fires.
    explainBtn.click();
    await flush();
    expect(api.apiGet).not.toHaveBeenCalled();

    resolveQuery({ totalSize: 0, done: true, records: [] });
    await flush();
    expect(runBtn.disabled).toBe(false);
    expect(explainBtn.disabled).toBe(false);
  });
});

describe('soql-runner — modal menus & exports', () => {
  function setSalesforceUrl(): void {
    window.history.replaceState(
      {},
      '',
      'https://x.lightning.force.com/lightning/setup/Flows/home',
    );
  }
  async function flush(): Promise<void> {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  }
  function findButton(text: string): HTMLButtonElement | undefined {
    return Array.from(document.querySelectorAll('button')).find((b) => b.textContent === text);
  }
  function stubClipboard(): ReturnType<typeof vi.fn> {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    return writeText;
  }
  async function openWith(api: ReturnType<typeof fakeApi>): Promise<void> {
    setSalesforceUrl();
    const feature = createSoqlRunnerFeature({ api });
    await feature.onActivate?.();
    await flush();
  }
  async function runSomething(): Promise<void> {
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = 'SELECT Id, Name FROM Account';
    findButton('▶ Run')?.click();
    await flush();
  }

  it('warns when activated off a Salesforce page', async () => {
    // Pass a non-Salesforce location via the win option rather than mutating
    // the real (cross-origin) window history.
    const feature = createSoqlRunnerFeature({
      api: fakeApi(),
      win: { location: { href: 'https://example.com/' } } as never,
    });
    await feature.onActivate?.();
    expect(document.querySelector('.sfdt-view-overlay')).toBeNull();
    expect(document.querySelector('.sfdt-toast')?.textContent).toContain('Open a Salesforce page');
  });

  it('shows an error when running an empty query', async () => {
    await openWith(fakeApi());
    findButton('▶ Run')?.click();
    await flush();
    expect(document.body.textContent).toContain('Enter a SOQL query to run.');
  });

  it('renders the history menu, including a tooling badge, and fills on click', async () => {
    await pushSoqlHistory({ q: 'SELECT Id FROM Flow', api: 'tooling', ts: 1 });
    await openWith(fakeApi());
    findButton('▸ History ▾')?.click();
    await flush();
    const menuText = document.body.textContent ?? '';
    expect(menuText).toContain('TOOL');
    // Click the item row (the parent of the query-text span), not the menu
    // container which has the same textContent but no click handler.
    const textSpan = Array.from(document.querySelectorAll('span')).find(
      (s) => s.textContent === 'SELECT Id FROM Flow',
    );
    (textSpan?.parentElement as HTMLElement | undefined)?.click();
    expect((document.querySelector('textarea') as HTMLTextAreaElement).value).toBe(
      'SELECT Id FROM Flow',
    );
  });

  it('shows the empty-history placeholder', async () => {
    await clearSoqlHistory();
    await openWith(fakeApi());
    findButton('▸ History ▾')?.click();
    await flush();
    expect(document.body.textContent).toContain('No queries yet.');
  });

  it('clears history from the footer button', async () => {
    await pushSoqlHistory({ q: 'SELECT Id FROM Account', api: 'rest', ts: 1 });
    await openWith(fakeApi());
    findButton('Clear history')?.click();
    await flush();
    expect(await readSoqlHistory()).toEqual([]);
    expect(document.querySelector('.sfdt-toast')?.textContent).toBe('Query history cleared');
  });

  it('renders saved queries, fills on click, and deletes on confirm', async () => {
    await writeSavedQueries([
      { name: 'Mine', q: 'SELECT Id FROM Contact', api: 'rest' },
    ]);
    const originalConfirm = window.confirm;
    window.confirm = vi.fn(() => true);
    await openWith(fakeApi());
    findButton('★ Bookmarks ▾')?.click();
    await flush();
    expect(document.body.textContent).toContain('Mine:');
    // Two '×' buttons exist (modal close + bookmark delete); the delete is last.
    const closeButtons = Array.from(document.querySelectorAll('button')).filter(
      (b) => b.textContent === '×',
    );
    (closeButtons[closeButtons.length - 1] as HTMLButtonElement).click();
    await flush();
    expect(await readSavedQueries()).toEqual([]);
    window.confirm = originalConfirm;
  });

  it('shows the empty-bookmarks placeholder', async () => {
    await writeSavedQueries([]);
    await openWith(fakeApi());
    findButton('★ Bookmarks ▾')?.click();
    await flush();
    expect(document.body.textContent).toContain('No bookmarked queries yet.');
  });

  it('warns when saving a bookmark with an empty query', async () => {
    await openWith(fakeApi());
    findButton('★ Save')?.click();
    await flush();
    expect(document.querySelector('.sfdt-toast')?.textContent).toBe(
      'Enter a query to bookmark first',
    );
  });

  it('saves a bookmark when a name is supplied', async () => {
    await writeSavedQueries([]);
    const originalPrompt = window.prompt;
    window.prompt = vi.fn(() => 'Named');
    await openWith(fakeApi());
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = 'SELECT Id FROM Account';
    findButton('★ Save')?.click();
    await flush();
    expect(await readSavedQueries()).toEqual([
      { name: 'Named', q: 'SELECT Id FROM Account', api: 'rest' },
    ]);
    window.prompt = originalPrompt;
  });

  it('copies CSV / LangGraph to the clipboard and exports a CSV file', async () => {
    const writeText = stubClipboard();
    const createUrl = vi.fn(() => 'blob:fake');
    const revokeUrl = vi.fn();
    globalThis.URL.createObjectURL = createUrl as never;
    globalThis.URL.revokeObjectURL = revokeUrl as never;
    const api = fakeApi({
      query: vi.fn(async () => ({
        totalSize: 1,
        done: true,
        records: [{ Id: '001', Name: 'Acme' }],
      })) as never,
    });
    await openWith(api);
    await runSomething();

    findButton('Copy CSV')?.click();
    await flush();
    expect(writeText).toHaveBeenCalledWith('Id,Name\n001,Acme');

    findButton('LangGraph Node')?.click();
    await flush();
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('class SoqlResult(BaseModel):'));

    // The download anchor would otherwise navigate to the blob: URL and break
    // the page origin for later tests — cancel its default during this click.
    const stopNav = (e: Event): void => e.preventDefault();
    document.addEventListener('click', stopNav, true);
    findButton('Export CSV')?.click();
    document.removeEventListener('click', stopNav, true);
    expect(createUrl).toHaveBeenCalled();
    expect(revokeUrl).toHaveBeenCalled();
  });

  it('reports a clipboard failure when copy throws', async () => {
    Object.defineProperty(window.navigator, 'clipboard', {
      value: undefined,
      configurable: true,
    });
    const api = fakeApi({
      query: vi.fn(async () => ({
        totalSize: 1,
        done: true,
        records: [{ Id: '001' }],
      })) as never,
    });
    await openWith(api);
    await runSomething();
    findButton('Copy CSV')?.click();
    await flush();
    expect(document.querySelector('.sfdt-toast')?.textContent).toBe('Could not copy to clipboard');
  });

  it('closes the modal on Escape', async () => {
    await openWith(fakeApi());
    expect(document.querySelector('.sfdt-view-overlay')).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('.sfdt-view-overlay')).toBeNull();
  });

  it('runs the query on Ctrl+Enter', async () => {
    const query = vi.fn(async () => ({ totalSize: 0, done: true, records: [] }));
    const api = fakeApi({ query: query as never });
    await openWith(api);
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = 'SELECT Id FROM Account';
    textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }),
    );
    await flush();
    expect(query).toHaveBeenCalledWith('SELECT Id FROM Account');
  });

  it('pre-fills the editor from a pending query', async () => {
    await writePendingQuery({ q: 'SELECT Id FROM Pending__c', api: 'tooling' });
    await openWith(fakeApi());
    expect((document.querySelector('textarea') as HTMLTextAreaElement).value).toBe(
      'SELECT Id FROM Pending__c',
    );
  });
});

describe('soql-runner — autocomplete field paths', () => {
  function setSalesforceUrl(): void {
    window.history.replaceState(
      {},
      '',
      'https://x.lightning.force.com/lightning/setup/Flows/home',
    );
  }
  async function flush(): Promise<void> {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  }
  const sobjectDescribe = {
    name: 'Account',
    label: 'Account',
    fields: [
      {
        name: 'Id',
        label: 'Record ID',
        type: 'id',
        relationshipName: null,
        referenceTo: [],
        picklistValues: [],
        nillable: false,
        calculated: false,
      },
      {
        name: 'Name',
        label: 'Account Name',
        type: 'string',
        relationshipName: null,
        referenceTo: [],
        picklistValues: [],
        nillable: true,
        calculated: false,
      },
      {
        name: 'OwnerId',
        label: 'Owner ID',
        type: 'reference',
        relationshipName: 'Owner',
        referenceTo: ['User'],
        picklistValues: [],
        nillable: true,
        calculated: false,
      },
    ],
  };

  async function openRunner(apiGet: ReturnType<typeof vi.fn>): Promise<HTMLTextAreaElement> {
    setSalesforceUrl();
    const feature = createSoqlRunnerFeature({
      api: fakeApi({ apiGet: apiGet as unknown as SalesforceApiClient['apiGet'] }),
    });
    await feature.onActivate?.();
    await flush();
    return document.querySelector('textarea') as HTMLTextAreaElement;
  }

  it('renders field suggestions and fills one on click', async () => {
    const apiGet = vi.fn(async (endpoint: string) =>
      endpoint.includes('/describe')
        ? sobjectDescribe
        : { sobjects: [{ name: 'Account', label: 'Account', keyPrefix: '001' }] },
    );
    const textarea = await openRunner(apiGet);
    textarea.value = 'SELECT  FROM Account';
    textarea.selectionStart = 7;
    textarea.selectionEnd = 7;
    textarea.dispatchEvent(new Event('input'));

    await vi.waitFor(() => {
      const title = document.querySelector('.sfdt-soql-autocomplete-box span');
      expect(title?.textContent).toContain('fields suggestions:');
    });

    const fieldBtn = Array.from(
      document.querySelectorAll('.sfdt-soql-autocomplete-box button'),
    ).find((b) => b.textContent?.includes('Name'));
    (fieldBtn as HTMLButtonElement)?.click();
    expect(textarea.value).toContain('Name');
  });

  it('shows the "from keyword not found" hint when there is no FROM', async () => {
    const apiGet = vi.fn().mockResolvedValue({ sobjects: [] });
    const textarea = await openRunner(apiGet);
    textarea.value = 'SELECT Id';
    textarea.selectionStart = 9;
    textarea.selectionEnd = 9;
    textarea.dispatchEvent(new Event('input'));
    await flush();
    expect(document.querySelector('.sfdt-soql-autocomplete-box span')?.textContent).toContain(
      'keyword not found',
    );
  });

  it('offers a Retry chip when the global describe fails', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const apiGet = vi.fn().mockRejectedValue(new Error('describe failed'));
    const textarea = await openRunner(apiGet);
    textarea.value = 'SELECT Id FROM ';
    textarea.selectionStart = 15;
    textarea.selectionEnd = 15;
    textarea.dispatchEvent(new Event('input'));

    await vi.waitFor(() => {
      const retry = Array.from(
        document.querySelectorAll('.sfdt-soql-autocomplete-box button'),
      ).find((b) => b.textContent?.includes('Retry'));
      expect(retry).toBeTruthy();
    });
    const retryBtn = Array.from(
      document.querySelectorAll('.sfdt-soql-autocomplete-box button'),
    ).find((b) => b.textContent?.includes('Retry')) as HTMLButtonElement;
    // Clicking Retry runs the cache-clearing branch in onAutocompleteClick.
    expect(() => retryBtn.click()).not.toThrow();
    expect(document.querySelector('.sfdt-soql-autocomplete-box')).toBeTruthy();
    err.mockRestore();
  });

  it('expands all matching fields on Ctrl+Space', async () => {
    const apiGet = vi.fn(async (endpoint: string) =>
      endpoint.includes('/describe')
        ? sobjectDescribe
        : { sobjects: [{ name: 'Account', label: 'Account', keyPrefix: '001' }] },
    );
    const textarea = await openRunner(apiGet);
    // Warm the describe cache first.
    textarea.value = 'SELECT  FROM Account';
    textarea.selectionStart = 7;
    textarea.selectionEnd = 7;
    textarea.dispatchEvent(new Event('input'));
    await flush();

    textarea.selectionStart = 7;
    textarea.selectionEnd = 7;
    textarea.dispatchEvent(
      new KeyboardEvent('keydown', { key: ' ', ctrlKey: true, bubbles: true }),
    );
    await flush();
    expect(textarea.value).toContain('Name');
    expect(textarea.value).toContain('OwnerId');
  });
});
