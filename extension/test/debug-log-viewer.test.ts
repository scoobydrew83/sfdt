import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  _debugLogViewerTestApi,
  createDebugLogViewerFeature,
  type ApexLogRow,
} from '../features/debug-log-viewer.js';
import type { SalesforceApiClient } from '../lib/salesforce-api.js';

const { buildApexLogQuery, formatBytes } = _debugLogViewerTestApi();

function clearBody(): void {
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
}

function setSetupUrl(): void {
  window.history.replaceState({}, '', 'https://x.lightning.force.com/lightning/setup/SetupOneHome/home');
}

function setNonSalesforceUrl(): void {
  // Same-origin (cross-origin replaceState is blocked) but matches no context →
  // detectContext returns NONE.
  window.history.replaceState({}, '', 'https://x.lightning.force.com/lightning/page/home');
}

function fakeApi(overrides: Partial<SalesforceApiClient> = {}): SalesforceApiClient {
  return {
    toolingQuery: vi.fn(async () => ({ records: [], size: 0, done: true })),
    apiGetText: vi.fn(async () => 'LOG BODY'),
    ...overrides,
  } as unknown as SalesforceApiClient;
}

function logRow(overrides: Partial<ApexLogRow> = {}): ApexLogRow {
  return {
    Id: '07L000000000001',
    Operation: '/apex/run',
    Application: 'Unknown',
    Status: 'Success',
    LogLength: 2048,
    DurationMilliseconds: 120,
    StartTime: '2026-06-22T12:00:00.000Z',
    LogUser: { Name: 'Ada Lovelace' },
    ...overrides,
  };
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe('debug-log-viewer — buildApexLogQuery', () => {
  it('queries ApexLog ordered by StartTime desc with the given limit', () => {
    const q = buildApexLogQuery(25);
    expect(q).toContain('FROM ApexLog');
    expect(q).toContain('ORDER BY StartTime DESC');
    expect(q).toContain('LIMIT 25');
    expect(q).toContain('LogUser.Name');
  });

  it('clamps the limit into a sane range', () => {
    expect(buildApexLogQuery(0)).toContain('LIMIT 1');
    expect(buildApexLogQuery(9999)).toContain('LIMIT 200');
    expect(buildApexLogQuery(10.7)).toContain('LIMIT 10');
  });
});

describe('debug-log-viewer — formatBytes', () => {
  it('formats bytes, KB and MB', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});

describe('debug-log-viewer — onActivate context gate', () => {
  beforeEach(() => clearBody());

  it('warns and does not open outside a Salesforce page', async () => {
    setNonSalesforceUrl();
    const api = fakeApi();
    const feature = createDebugLogViewerFeature({ api });
    await feature.onActivate?.();
    await flush();
    expect(document.querySelector('.sfdt-view-overlay')).toBeNull();
    expect(api.toolingQuery).not.toHaveBeenCalled();
    // A warning toast is shown instead.
    expect(document.querySelector('.sfdt-toast')?.textContent).toContain('debug logs');
  });
});

describe('debug-log-viewer — log table', () => {
  beforeEach(() => {
    clearBody();
    setSetupUrl();
  });

  it('renders one row per ApexLog with formatted fields', async () => {
    const api = fakeApi({
      toolingQuery: vi.fn(async () => ({
        records: [logRow(), logRow({ Id: '07L000000000002', Operation: '/apex/two', LogLength: 1024 })],
        size: 2,
        done: true,
      })) as unknown as SalesforceApiClient['toolingQuery'],
    });
    const feature = createDebugLogViewerFeature({ api });
    await feature.onActivate?.();
    await flush();
    const table = document.querySelector('.sfdt-view-overlay')!;
    const body = table.textContent ?? '';
    expect(body).toContain('2 logs');
    expect(body).toContain('Ada Lovelace');
    expect(body).toContain('/apex/run');
    expect(body).toContain('2.0 KB');
    expect(body).toContain('1.0 KB');
  });

  it('shows the empty state when there are no logs', async () => {
    const api = fakeApi();
    const feature = createDebugLogViewerFeature({ api });
    await feature.onActivate?.();
    await flush();
    expect(document.querySelector('.sfdt-view-overlay')?.textContent).toContain('No debug logs');
    expect(document.querySelector('.sfdt-view-overlay')?.textContent).toContain('0 logs');
  });

  it('renders an error panel when the query throws', async () => {
    const api = fakeApi({
      toolingQuery: vi.fn(async () => {
        throw new Error('INVALID_SESSION');
      }) as unknown as SalesforceApiClient['toolingQuery'],
    });
    const feature = createDebugLogViewerFeature({ api });
    await feature.onActivate?.();
    await flush();
    expect(document.querySelector('.sfdt-view-overlay')?.textContent).toContain('INVALID_SESSION');
  });

  it('clicking a row fetches and shows the log body', async () => {
    const apiGetText = vi.fn(async () => 'EXECUTION_STARTED\nUSER_DEBUG|hi');
    const api = fakeApi({
      toolingQuery: vi.fn(async () => ({ records: [logRow()], size: 1, done: true })) as unknown as SalesforceApiClient['toolingQuery'],
      apiGetText: apiGetText as unknown as SalesforceApiClient['apiGetText'],
    });
    const feature = createDebugLogViewerFeature({ api });
    await feature.onActivate?.();
    await flush();
    // The clickable row is inside the table; click the one containing the operation.
    const rows = Array.from(document.querySelectorAll<HTMLElement>('.sfdt-view-overlay div')).filter(
      (d) => d.textContent?.includes('/apex/run') && d.style.cursor === 'pointer',
    );
    expect(rows.length).toBeGreaterThan(0);
    rows[0]!.click();
    await flush();
    expect(apiGetText).toHaveBeenCalledWith(expect.stringContaining('/ApexLog/07L000000000001/Body'));
    const pre = document.querySelector('.sfdt-view-overlay pre')!;
    expect(pre.textContent).toContain('USER_DEBUG|hi');
  });

  it('shows the error text in the log pane when the body fetch fails', async () => {
    const api = fakeApi({
      toolingQuery: vi.fn(async () => ({ records: [logRow()], size: 1, done: true })) as unknown as SalesforceApiClient['toolingQuery'],
      apiGetText: vi.fn(async () => {
        throw new Error('body gone');
      }) as unknown as SalesforceApiClient['apiGetText'],
    });
    const feature = createDebugLogViewerFeature({ api });
    await feature.onActivate?.();
    await flush();
    const row = Array.from(document.querySelectorAll<HTMLElement>('.sfdt-view-overlay div')).find(
      (d) => d.style.cursor === 'pointer',
    )!;
    row.click();
    await flush();
    expect(document.querySelector('.sfdt-view-overlay pre')?.textContent).toBe('body gone');
  });

  it('the refresh button re-runs the query', async () => {
    const toolingQuery = vi.fn(async () => ({ records: [logRow()], size: 1, done: true }));
    const api = fakeApi({ toolingQuery: toolingQuery as unknown as SalesforceApiClient['toolingQuery'] });
    const feature = createDebugLogViewerFeature({ api });
    await feature.onActivate?.();
    await flush();
    expect(toolingQuery).toHaveBeenCalledTimes(1);
    const refresh = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === '↻ Refresh')!;
    refresh.click();
    await flush();
    expect(toolingQuery).toHaveBeenCalledTimes(2);
  });

  it('clicking the overlay backdrop closes the modal', async () => {
    const feature = createDebugLogViewerFeature({ api: fakeApi() });
    await feature.onActivate?.();
    await flush();
    const overlay = document.querySelector<HTMLElement>('.sfdt-view-overlay')!;
    overlay.click();
    expect(document.querySelector('.sfdt-view-overlay')).toBeNull();
  });
});
