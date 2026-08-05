// C-P4-2 — bulk delete, as WIRED INTO the SOQL runner.
//
// features/soql-bulk-delete.ts owns the gates and test/soql-bulk-delete.test.ts
// pins them in isolation. This file pins the call site, because a guard rail
// that is correct in the model and bypassed by the UI is not a guard rail:
//
//   - the control is not built at all unless the user opted in (AC-2);
//   - clicking it writes the backup CSV — through the P1-3 `recordsToCsv`, not
//     a second serialiser — BEFORE the confirm dialog appears (AC-1);
//   - Confirm stays disabled until the exact phrase is typed, and Cancel or
//     Escape leave the org untouched;
//   - only after all of that does a DELETE reach the worker proxy.
//
// Separate from test/soql-runner.test.ts (2,200 lines already) so the
// destructive path has one file a reviewer can read end to end.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createSoqlRunnerFeature,
  downloadDeleteBackup,
  recordsToCsv,
} from '../features/soql-runner.js';
import {
  _resetSettingsShapesForTests,
  _clearSettingsCacheForTests,
  patchSettings,
} from '../lib/settings.js';
import { _resetDescribeCachesForTests } from '../lib/describe-cache.js';
import type { SalesforceApiClient, QueryEnvelope } from '../lib/salesforce-api.js';

function fakeApi(overrides: Partial<SalesforceApiClient> = {}): SalesforceApiClient {
  return {
    apiVersion: 'v62.0',
    query: vi.fn(
      async () => ({ totalSize: 0, done: true, records: [] }) as QueryEnvelope<Record<string, unknown>>,
    ),
    toolingQuery: vi.fn(async () => ({ size: 0, done: true, records: [] })),
    queryMore: vi.fn(
      async () => ({ totalSize: 0, done: true, records: [] }) as QueryEnvelope<Record<string, unknown>>,
    ),
    apiGet: vi.fn(async () => ({})),
    apiRequest: vi.fn(async () => null),
    ...overrides,
  } as unknown as SalesforceApiClient;
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const btn = (text: string): HTMLButtonElement | undefined =>
  Array.from(document.querySelectorAll('button')).find((b) => b.textContent === text);
const deleteBtn = (): HTMLButtonElement | undefined =>
  Array.from(document.querySelectorAll('button')).find((b) =>
    /^Delete \d+ rows?$/.test(b.textContent ?? ''),
  );
const overlay = (): HTMLElement | null =>
  document.querySelector('.sfdt-confirm-overlay') as HTMLElement | null;

const ROWS = [
  { attributes: { type: 'Account' }, Id: '001000000000001AAA', Name: 'Acme' },
  { attributes: { type: 'Account' }, Id: '001000000000002AAA', Name: 'Universal' },
];

const BLOB_STUB_URL = 'https://x.lightning.force.com/blob-stub';

let downloads: Blob[] = [];
let origCreate: typeof URL.createObjectURL;
let origRevoke: typeof URL.revokeObjectURL;

beforeEach(() => {
  _resetSettingsShapesForTests();
  _clearSettingsCacheForTests();
  _resetDescribeCachesForTests();
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
  downloads = [];
  origCreate = URL.createObjectURL;
  origRevoke = URL.revokeObjectURL;
  // A same-origin stub rather than a real `blob:` URL: happy-dom follows the
  // hidden <a download>'s click and navigates the document, and a blob: URL
  // leaves it on an opaque origin where the next test's history.replaceState
  // throws. Same trick as test/metadata-retrieve.test.ts.
  URL.createObjectURL = ((part: Blob) => {
    downloads.push(part);
    return BLOB_STUB_URL;
  }) as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => {}) as unknown as typeof URL.revokeObjectURL;
  window.history.replaceState({}, '', 'https://x.lightning.force.com/lightning/setup/Flows/home');
});

afterEach(() => {
  URL.createObjectURL = origCreate;
  URL.revokeObjectURL = origRevoke;
});

async function openWithRows(
  rows: Array<Record<string, unknown>>,
  opts: { enabled?: boolean; apiOverrides?: Partial<SalesforceApiClient> } = {},
): Promise<SalesforceApiClient> {
  if (opts.enabled !== false) {
    await patchSettings({ features: { 'soql-bulk-delete': true } });
  }
  const api = fakeApi({
    query: vi.fn(async () => ({
      totalSize: rows.length,
      done: true,
      records: rows,
    })) as unknown as SalesforceApiClient['query'],
    ...opts.apiOverrides,
  });
  const feature = createSoqlRunnerFeature({ api });
  await feature.onActivate?.();
  (document.querySelector('textarea') as HTMLTextAreaElement).value = 'SELECT Id, Name FROM Account';
  btn('Run')!.click();
  await tick();
  await tick();
  return api;
}

/** Type the phrase into the open dialog and press its confirm button. */
async function confirmWith(phrase: string, confirmLabel: string): Promise<void> {
  const card = overlay()!;
  const input = card.querySelector('input') as HTMLInputElement;
  input.value = phrase;
  input.dispatchEvent(new Event('input'));
  Array.from(card.querySelectorAll('button'))
    .find((b) => b.textContent === confirmLabel)!
    .click();
  await tick();
  await tick();
  await tick();
}

describe('bulk delete is not reachable without the opt-in (AC-2)', () => {
  it('does not build the control at all for a user who has not opted in', async () => {
    await openWithRows(ROWS, { enabled: false });
    // Absent, not hidden: a hidden destructive button is one style write away
    // from being clickable.
    expect(deleteBtn()).toBeUndefined();
    expect(
      Array.from(document.querySelectorAll('button')).some((b) =>
        (b.getAttribute('aria-label') ?? '').startsWith('Delete '),
      ),
    ).toBe(false);
  });

  it('offers it, labelled with the row count, once the user opts in', async () => {
    await openWithRows(ROWS);
    const del = deleteBtn()!;
    expect(del.textContent).toBe('Delete 2 rows');
    expect(del.getAttribute('aria-label')).toBe('Delete 2 Account records');
    // The preview count is on the button before anything is clicked, and the
    // title says exactly what will be asked for.
    expect(del.title).toContain('DELETE 2 Account');
    expect(del.className).toContain('sfdt-danger');
  });

  it('stays absent when the result set has no Id column, even when opted in (AC-1)', async () => {
    await openWithRows([{ attributes: { type: 'Account' }, Name: 'Acme' }]);
    expect(deleteBtn()).toBeUndefined();
  });
});

describe('the backup runs before the question is asked (AC-1)', () => {
  it('downloads the affected rows as CSV — via recordsToCsv — and only then opens the dialog', async () => {
    await openWithRows(ROWS);
    expect(overlay()).toBeNull();

    deleteBtn()!.click();
    await tick();

    expect(downloads).toHaveLength(1);
    const csv = await downloads[0]!.text();
    // Byte-identical to what Export CSV produces for the same rows: ONE
    // serialiser, so the backup quotes exactly the way the export the user
    // already trusts does.
    expect(csv).toBe(recordsToCsv(ROWS));
    expect(csv).toContain('001000000000001AAA');
    expect(overlay()).not.toBeNull();
  });
});

describe('the typed confirm gate (AC-1)', () => {
  it('is a labelled modal dialog with the phrase spelled out', async () => {
    await openWithRows(ROWS);
    deleteBtn()!.click();
    await tick();
    const card = overlay()!.querySelector('[role="dialog"]') as HTMLElement;
    expect(card.getAttribute('aria-modal')).toBe('true');
    expect(card.getAttribute('aria-labelledby')).toBeTruthy();
    const input = overlay()!.querySelector('input') as HTMLInputElement;
    expect(input.getAttribute('aria-label')).toBe('Type DELETE 2 Account to confirm');
    // Focus lands on the safe control, never the destructive one.
    expect(document.activeElement).toBe(input);
  });

  it('keeps Confirm disabled until the exact phrase is typed, and a near miss deletes nothing', async () => {
    const api = await openWithRows(ROWS);
    deleteBtn()!.click();
    await tick();

    const card = overlay()!;
    const input = card.querySelector('input') as HTMLInputElement;
    const confirm = Array.from(card.querySelectorAll('button')).find(
      (b) => b.textContent === 'Delete 2 Account records',
    )!;
    expect(confirm.disabled).toBe(true);

    input.value = 'DELETE 2 Accounts'; // plural — wrong
    input.dispatchEvent(new Event('input'));
    expect(confirm.disabled).toBe(true);
    confirm.click();
    await tick();
    expect(api.apiRequest).not.toHaveBeenCalled();

    input.value = 'DELETE 2 Account';
    input.dispatchEvent(new Event('input'));
    expect(confirm.disabled).toBe(false);
  });

  it('deletes nothing when the dialog is cancelled', async () => {
    const api = await openWithRows(ROWS);
    deleteBtn()!.click();
    await tick();
    Array.from(overlay()!.querySelectorAll('button'))
      .find((b) => b.textContent === 'Cancel')!
      .click();
    await tick();
    await tick();
    expect(api.apiRequest).not.toHaveBeenCalled();
    // The backup still went out. A CSV of rows you did NOT delete is harmless;
    // the reverse is not.
    expect(downloads).toHaveLength(1);
  });

  it('deletes nothing when the dialog is dismissed with Escape', async () => {
    const api = await openWithRows(ROWS);
    deleteBtn()!.click();
    await tick();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick();
    await tick();
    expect(overlay()).toBeNull();
    expect(api.apiRequest).not.toHaveBeenCalled();
  });
});

describe('the delete itself', () => {
  it('issues one DELETE per row through the worker proxy once confirmed', async () => {
    const api = await openWithRows(ROWS);
    deleteBtn()!.click();
    await tick();
    await confirmWith('DELETE 2 Account', 'Delete 2 Account records');

    expect(api.apiRequest).toHaveBeenCalledTimes(2);
    expect(api.apiRequest).toHaveBeenNthCalledWith(
      1,
      'DELETE',
      '/services/data/v62.0/sobjects/Account/001000000000001AAA',
    );
    expect(api.apiRequest).toHaveBeenNthCalledWith(
      2,
      'DELETE',
      '/services/data/v62.0/sobjects/Account/001000000000002AAA',
    );
    const status = document.querySelector('[role="status"]') as HTMLElement;
    expect(status.textContent).toContain('Deleted 2 of 2');
    // The table on screen is now stale, and the status line says so rather than
    // leaving the user to guess.
    expect(status.textContent).toContain('re-run the query');
  });

  it('routes a Tooling result set to the Tooling delete path', async () => {
    await patchSettings({ features: { 'soql-bulk-delete': true } });
    const api = fakeApi({
      toolingQuery: vi.fn(async () => ({
        size: 1,
        done: true,
        records: [{ attributes: { type: 'TraceFlag' }, Id: '7tf000000000001AAA' }],
      })) as unknown as SalesforceApiClient['toolingQuery'],
    });
    const feature = createSoqlRunnerFeature({ api });
    await feature.onActivate?.();
    btn('Tooling')!.click();
    (document.querySelector('textarea') as HTMLTextAreaElement).value = 'SELECT Id FROM TraceFlag';
    btn('Run')!.click();
    await tick();
    await tick();

    deleteBtn()!.click();
    await tick();
    await confirmWith('DELETE 1 TraceFlag', 'Delete 1 TraceFlag record');

    expect(api.apiRequest).toHaveBeenCalledWith(
      'DELETE',
      '/services/data/v62.0/tooling/sobjects/TraceFlag/7tf000000000001AAA',
    );
  });

  it('renders the per-row failure report through ui/panels.ts when some rows fail', async () => {
    const apiRequest = vi.fn(async (_method: string, endpoint: string) => {
      if (endpoint.endsWith('002AAA')) {
        const err = new Error('ENTITY_IS_DELETED') as Error & { sfdtKind: string };
        err.sfdtKind = 'http-error';
        throw err;
      }
      return null;
    });
    await openWithRows(ROWS, {
      apiOverrides: { apiRequest: apiRequest as unknown as SalesforceApiClient['apiRequest'] },
    });
    deleteBtn()!.click();
    await tick();
    await confirmWith('DELETE 2 Account', 'Delete 2 Account records');

    const report = Array.from(document.querySelectorAll('[role="alert"]')).find((el) =>
      (el.textContent ?? '').includes('001000000000002AAA'),
    );
    expect(report).toBeDefined();
    expect(report!.textContent).toContain('Deleted 1 of 2 Account records.');
    expect(report!.textContent).toContain('ENTITY_IS_DELETED');
    // errorPanel() from ui/panels.ts, not a fourth hand-rolled console div.
    expect(report!.className).toBe('sfdt-console sfdt-error');
  });

  it('clears a previous delete report when a new query runs', async () => {
    const apiRequest = vi.fn(async () => {
      throw new Error('nope');
    });
    await openWithRows(ROWS, {
      apiOverrides: { apiRequest: apiRequest as unknown as SalesforceApiClient['apiRequest'] },
    });
    deleteBtn()!.click();
    await tick();
    await confirmWith('DELETE 2 Account', 'Delete 2 Account records');
    expect(document.body.textContent).toContain('nope');

    btn('Run')!.click();
    await tick();
    await tick();
    // A stale report next to fresh rows reads as if the NEW rows failed.
    expect(document.body.textContent).not.toContain('001000000000002AAA — nope');
  });
});

describe('downloadDeleteBackup()', () => {
  it('writes the affected rows with recordsToCsv, through lib/download.ts', async () => {
    const revoked: string[] = [];
    URL.revokeObjectURL = ((url: string) => {
      revoked.push(url);
    }) as unknown as typeof URL.revokeObjectURL;

    const rows = [{ Id: '001000000000001AAA', Name: 'Comma, Inc "quoted"' }];
    downloadDeleteBackup(
      document,
      { sobject: 'Account', ids: ['001000000000001AAA'], rows },
      new Date('2026-08-05T10:00:00Z'),
    );

    expect(downloads).toHaveLength(1);
    const csv = await downloads[0]!.text();
    expect(csv).toBe(recordsToCsv(rows));
    // The quoting the shared serialiser already does — not re-implemented here.
    expect(csv).toContain('"Comma, Inc ""quoted"""');
    // lib/download.ts's revoke, which is half the reason the backup goes
    // through it rather than hand-rolling the blob dance a sixth time.
    expect(revoked).toEqual([BLOB_STUB_URL]);
  });
});
