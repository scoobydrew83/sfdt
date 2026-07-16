import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  _debugLogViewerTestApi,
  createDebugLogViewerFeature,
  type ApexLogRow,
} from '../features/debug-log-viewer.js';
import type { SalesforceApiClient } from '../lib/salesforce-api.js';

const { buildApexLogQuery, formatBytes, buildLogDeleteEndpoint, AUTO_REFRESH_INTERVAL_MS } =
  _debugLogViewerTestApi();

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
    apiRequest: vi.fn(async () => null),
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

describe('debug-log-viewer — buildLogDeleteEndpoint', () => {
  it('targets the Tooling ApexLog sobject by id', () => {
    const ep = buildLogDeleteEndpoint('07L000000000001');
    expect(ep).toContain('/tooling/sobjects/ApexLog/07L000000000001');
  });
});

describe('debug-log-viewer — auto-refresh timer lifecycle', () => {
  beforeEach(() => {
    clearBody();
    setSetupUrl();
  });

  function autoToggle(): HTMLInputElement {
    return Array.from(document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).find(
      (c) => c.parentElement?.textContent?.includes('Auto-refresh'),
    )!;
  }

  it('is OFF by default (no interval until toggled)', async () => {
    const setSpy = vi.spyOn(globalThis, 'setInterval');
    const feature = createDebugLogViewerFeature({ api: fakeApi() });
    await feature.onActivate?.();
    await flush();
    expect(autoToggle().checked).toBe(false);
    expect(setSpy).not.toHaveBeenCalled();
    await feature.teardown?.();
    setSpy.mockRestore();
  });

  it('toggling on starts an interval that re-runs the query, and teardown clears it', async () => {
    const setSpy = vi.spyOn(globalThis, 'setInterval');
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const toolingQuery = vi.fn(async () => ({ records: [logRow()], size: 1, done: true }));
    const feature = createDebugLogViewerFeature({
      api: fakeApi({ toolingQuery: toolingQuery as unknown as SalesforceApiClient['toolingQuery'] }),
    });
    await feature.onActivate?.();
    await flush();
    expect(toolingQuery).toHaveBeenCalledTimes(1);

    const toggle = autoToggle();
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(setSpy.mock.calls[0]![1]).toBe(AUTO_REFRESH_INTERVAL_MS);
    const handle = setSpy.mock.results[0]!.value;

    // The interval callback re-runs load().
    const cb = setSpy.mock.calls[0]![0] as () => void;
    cb();
    await flush();
    expect(toolingQuery).toHaveBeenCalledTimes(2);

    // Teardown must clear the exact interval — no orphan timer.
    await feature.teardown?.();
    expect(clearSpy).toHaveBeenCalledWith(handle);

    setSpy.mockRestore();
    clearSpy.mockRestore();
  });

  it('toggling off clears the interval without tearing down the view', async () => {
    const setSpy = vi.spyOn(globalThis, 'setInterval');
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const feature = createDebugLogViewerFeature({ api: fakeApi() });
    await feature.onActivate?.();
    await flush();
    const toggle = autoToggle();
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    const handle = setSpy.mock.results[0]!.value;
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    expect(clearSpy).toHaveBeenCalledWith(handle);
    expect(document.querySelector('.sfdt-view-overlay')).not.toBeNull();
    await feature.teardown?.();
    setSpy.mockRestore();
    clearSpy.mockRestore();
  });
});

describe('debug-log-viewer — bulk delete', () => {
  beforeEach(() => {
    clearBody();
    setSetupUrl();
  });

  function deleteButton(): HTMLButtonElement {
    return Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
      b.textContent?.includes('Delete all logs'),
    )!;
  }

  it('deletes each loaded ApexLog after count-confirm, then refreshes', async () => {
    const rows = [logRow(), logRow({ Id: '07L000000000002' })];
    const toolingQuery = vi.fn(async () => ({ records: rows, size: rows.length, done: true }));
    const apiRequest = vi.fn(async () => null);
    const feature = createDebugLogViewerFeature({
      api: fakeApi({
        toolingQuery: toolingQuery as unknown as SalesforceApiClient['toolingQuery'],
        apiRequest: apiRequest as unknown as SalesforceApiClient['apiRequest'],
      }),
    });
    await feature.onActivate?.();
    await flush();
    expect(toolingQuery).toHaveBeenCalledTimes(1);

    deleteButton().click();
    await flush();

    // Count-confirm dialog appears with the exact count.
    const dialog = document.querySelector<HTMLElement>('.sfdt-confirm-overlay [role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.textContent).toContain('Delete 2 logs?');

    // Confirm.
    const confirm = Array.from(dialog.querySelectorAll('button')).find(
      (b) => b.textContent === 'Delete',
    )!;
    confirm.click();
    await flush();

    // One DELETE per loaded row, to the Tooling ApexLog endpoint.
    expect(apiRequest).toHaveBeenCalledTimes(2);
    expect(apiRequest).toHaveBeenCalledWith('DELETE', buildLogDeleteEndpoint(rows[0]!.Id));
    expect(apiRequest).toHaveBeenCalledWith('DELETE', buildLogDeleteEndpoint(rows[1]!.Id));
    // Dialog is dismissed and the list re-queried.
    expect(document.querySelector('.sfdt-confirm-overlay')).toBeNull();
    expect(toolingQuery).toHaveBeenCalledTimes(2);
  });

  it('cancelling the confirm dialog issues no deletes', async () => {
    const apiRequest = vi.fn(async () => null);
    const feature = createDebugLogViewerFeature({
      api: fakeApi({
        toolingQuery: vi.fn(async () => ({
          records: [logRow()],
          size: 1,
          done: true,
        })) as unknown as SalesforceApiClient['toolingQuery'],
        apiRequest: apiRequest as unknown as SalesforceApiClient['apiRequest'],
      }),
    });
    await feature.onActivate?.();
    await flush();
    deleteButton().click();
    await flush();
    const dialog = document.querySelector<HTMLElement>('.sfdt-confirm-overlay [role="dialog"]')!;
    const cancel = Array.from(dialog.querySelectorAll('button')).find(
      (b) => b.textContent === 'Cancel',
    )!;
    cancel.click();
    await flush();
    expect(apiRequest).not.toHaveBeenCalled();
    expect(document.querySelector('.sfdt-confirm-overlay')).toBeNull();
  });

  it('does nothing (no dialog, no delete) when there are no logs', async () => {
    const apiRequest = vi.fn(async () => null);
    const feature = createDebugLogViewerFeature({
      api: fakeApi({ apiRequest: apiRequest as unknown as SalesforceApiClient['apiRequest'] }),
    });
    await feature.onActivate?.();
    await flush();
    deleteButton().click();
    await flush();
    expect(document.querySelector('.sfdt-confirm-overlay')).toBeNull();
    expect(apiRequest).not.toHaveBeenCalled();
  });
});
