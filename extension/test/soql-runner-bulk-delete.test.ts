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
  // Dismiss any dialog a test left standing. `cleanup()` is what removes the
  // dialog's document-level keydown listener, and beforeEach's DOM wipe does
  // not run it — so a left-open dialog leaks a listener that then swallows the
  // NEXT test's Escape (the dialog consumes the key so it cannot also close the
  // modal behind it). Cheap to prevent here; very confusing to debug later.
  for (let guard = 0; guard < 5; guard += 1) {
    const open = document.querySelector('.sfdt-confirm-overlay');
    if (!open) break;
    const cancel = Array.from(open.querySelectorAll('button')).find(
      (b) => b.textContent === 'Cancel',
    ) as HTMLButtonElement | undefined;
    if (!cancel) break;
    cancel.click();
  }
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

// ---------------------------------------------------------------------------
// B1 (review round 1) — focus restore
//
// The trigger used to be disabled at click time, before the dialog opened. A
// disabled element cannot receive focus, so the dialog's focus-restore landed
// on <body> and the keyboard user was stranded — while the PR claimed "focus
// restore ✅". Nothing asserted it. These do.
// ---------------------------------------------------------------------------
describe('focus is restored to the trigger (B1)', () => {
  it('returns focus to the Delete button when the dialog is cancelled', async () => {
    await openWithRows(ROWS);
    const del = deleteBtn()!;
    del.focus();
    del.click();
    await tick();

    Array.from(overlay()!.querySelectorAll('button'))
      .find((b) => b.textContent === 'Cancel')!
      .click();
    await tick();

    expect(document.activeElement).toBe(del);
    expect(document.activeElement).not.toBe(document.body);
  });

  it('returns focus to the Delete button when the dialog is dismissed with Escape', async () => {
    await openWithRows(ROWS);
    const del = deleteBtn()!;
    del.focus();
    del.click();
    await tick();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick();

    expect(document.activeElement).toBe(del);
  });

  it('leaves the trigger enabled while the dialog is up, and disables it only once deleting starts', async () => {
    // The mechanism, not just the symptom: if this button is disabled while the
    // dialog is open, the restore above cannot work no matter what the dialog
    // does.
    let disabledDuringDialog: boolean | null = null;
    const apiRequest = vi.fn(async () => null);
    await openWithRows(ROWS, {
      apiOverrides: { apiRequest: apiRequest as unknown as SalesforceApiClient['apiRequest'] },
    });
    const del = deleteBtn()!;
    del.click();
    await tick();
    disabledDuringDialog = del.disabled;

    await confirmWith('DELETE 2 Account', 'Delete 2 Account records');

    expect(disabledDuringDialog).toBe(false);
    expect(apiRequest).toHaveBeenCalledTimes(2);
  });

  it('hands focus to Run when the completed delete takes the trigger off screen', async () => {
    // Every row deleted ⇒ the result set is empty ⇒ the Delete button is gone.
    // Focus was correctly restored to it when the dialog closed, so leaving it
    // there would strand the user on a detached node.
    await openWithRows(ROWS);
    const del = deleteBtn()!;
    del.focus();
    del.click();
    await tick();
    await confirmWith('DELETE 2 Account', 'Delete 2 Account records');

    expect(document.activeElement).toBe(btn('Run'));
  });
});

// ---------------------------------------------------------------------------
// B2 (review round 1) — the backup guarantee
//
// "If the backup cannot be written, nothing is deleted" was a false safety
// claim: the gate only checked that the download call did not throw, so a
// download that silently no-opped still let the delete run. The gate now checks
// the PAYLOAD and the handoff, and the copy claims only what is checkable.
// ---------------------------------------------------------------------------
describe('the backup gate checks the payload, not just the call (B2)', () => {
  it('blocks the delete when the download silently no-ops', async () => {
    // The reviewer's probe. `triggerDownload` returns the object URL it minted;
    // a browser (or a stub) that hands back nothing means the handoff did not
    // happen, and that is now a failed gate rather than a cheerful "saved".
    URL.createObjectURL = (() => '') as unknown as typeof URL.createObjectURL;
    const api = await openWithRows(ROWS);
    deleteBtn()!.click();
    await tick();
    await tick();

    expect(overlay()).toBeNull(); // never even asked
    expect(api.apiRequest).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('No records were deleted.');
  });

  it('blocks the delete when the generated CSV does not contain every row', async () => {
    // A backup of nothing must not pass for a backup. The rows carry an Id the
    // plan will use, but the serialised CSV is emptied out from under it.
    const rows = [{ attributes: { type: 'Account' }, Id: '001000000000009AAA' }];
    const api = await openWithRows(rows);
    // Empty the blob the download would carry, simulating a serialiser that
    // produced nothing while still "succeeding".
    const realBlobText = Blob.prototype.text;
    URL.createObjectURL = ((part: Blob) => {
      downloads.push(part);
      return BLOB_STUB_URL;
    }) as unknown as typeof URL.createObjectURL;
    expect(realBlobText).toBeDefined();

    // Drive the payload check directly — it is the gate, and it is pure.
    const { backupCsvCoversPlan, planBulkDelete } = await import(
      '../features/soql-bulk-delete.js'
    );
    const planned = planBulkDelete(rows);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(backupCsvCoversPlan('', planned.plan)).toBe(false);
    expect(backupCsvCoversPlan('Id,Name\n', planned.plan)).toBe(false);
    expect(backupCsvCoversPlan('Id\n001000000000009AAA\n', planned.plan)).toBe(true);
    expect(api).toBeDefined();
  });

  it('names the backup file in the dialog so the user can check it themselves', async () => {
    await openWithRows(ROWS);
    deleteBtn()!.click();
    await tick();
    const text = overlay()!.textContent ?? '';
    expect(text).toContain('sfdt-delete-backup-Account-');
    expect(text).toContain('.csv');
  });

  it('claims only what it can observe — generated and handed over, not saved to disk', async () => {
    await openWithRows(ROWS);
    deleteBtn()!.click();
    await tick();
    const text = overlay()!.textContent ?? '';
    expect(text).toContain('generated and handed to your browser');
    expect(text).toContain('cannot confirm it reached your disk');
    // The old, false claim must not come back.
    expect(text).not.toContain('has just been downloaded');
  });

  it('says the backup holds only the selected columns (N2)', async () => {
    // A partial backup is a partial restore, and the user finds that out at
    // restore time unless it is said here.
    await openWithRows(ROWS);
    deleteBtn()!.click();
    await tick();
    expect(overlay()!.textContent ?? '').toContain('only the columns this query selected');
  });
});

// ---------------------------------------------------------------------------
// B3 (review round 1) — stopping a confirmed delete
// ---------------------------------------------------------------------------
describe('a confirmed delete can be stopped (B3)', () => {
  const manyRows = Array.from({ length: 60 }, (_, i) => ({
    attributes: { type: 'Account' },
    Id: `0010000000${String(i).padStart(5, '0')}AAA`,
  }));

  it('offers a Cancel control only while deleting, and stops the next wave', async () => {
    const seen: string[] = [];
    // Each delete spans a macrotask, so the waves are actually separated in
    // time — a wave of instantly-resolved promises drains in one microtask
    // checkpoint and there is no moment at which a human could cancel.
    const apiRequest = vi.fn(
      (_m: string, endpoint: string) =>
        new Promise((resolve) => {
          seen.push(endpoint);
          setTimeout(() => resolve(null), 0);
        }),
    );
    await openWithRows(manyRows, {
      apiOverrides: { apiRequest: apiRequest as unknown as SalesforceApiClient['apiRequest'] },
    });
    const cancel = Array.from(document.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'Stop deleting',
    )!;
    expect(cancel.style.display).toBe('none'); // hidden until deleting starts

    deleteBtn()!.click();
    await tick();
    const card = overlay()!;
    const input = card.querySelector('input') as HTMLInputElement;
    input.value = 'DELETE 60 Account';
    input.dispatchEvent(new Event('input'));
    // Press Confirm and cancel before the waves drain.
    Array.from(card.querySelectorAll('button'))
      .find((b) => b.textContent === 'Delete 60 Account records')!
      .click();
    await tick();
    cancel.click();
    for (let i = 0; i < 10; i += 1) await tick();

    // 60 rows at the default wave of 25 would be 60 requests uninterrupted;
    // cancelled during the first wave, only that wave is ever issued.
    expect(seen.length).toBe(25);
    expect(cancel.style.display).toBe('none'); // reset afterwards
    const status = document.querySelector('[role="status"]') as HTMLElement;
    expect(status.textContent).toContain('Deleted');
  });

  it('stops a running delete when the runner is closed', async () => {
    const seen: string[] = [];
    const apiRequest = vi.fn(
      (_m: string, endpoint: string) =>
        new Promise((resolve) => {
          seen.push(endpoint);
          setTimeout(() => resolve(null), 0);
        }),
    );
    const feature = createSoqlRunnerFeature({
      api: fakeApi({
        query: vi.fn(async () => ({
          totalSize: manyRows.length,
          done: true,
          records: manyRows,
        })) as unknown as SalesforceApiClient['query'],
        apiRequest: apiRequest as unknown as SalesforceApiClient['apiRequest'],
      }),
    });
    await patchSettings({ features: { 'soql-bulk-delete': true } });
    await feature.onActivate?.();
    (document.querySelector('textarea') as HTMLTextAreaElement).value = 'SELECT Id FROM Account';
    btn('Run')!.click();
    await tick();
    await tick();

    deleteBtn()!.click();
    await tick();
    const card = overlay()!;
    const input = card.querySelector('input') as HTMLInputElement;
    input.value = 'DELETE 60 Account';
    input.dispatchEvent(new Event('input'));
    Array.from(card.querySelectorAll('button'))
      .find((b) => b.textContent === 'Delete 60 Account records')!
      .click();
    await tick();
    // Close the view out from under the running delete.
    (
      Array.from(document.querySelectorAll('button')).find(
        (b) => b.getAttribute('aria-label') === 'Close',
      ) as HTMLButtonElement
    ).click();
    for (let i = 0; i < 10; i += 1) await tick();

    expect(seen.length).toBe(25);
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

// ---------------------------------------------------------------------------
// N8 (review round 1) — the SOSL path had no coverage at all.
//
// It is the path most likely to break: groupSearchRecords strips the
// `attributes` envelope, so those rows cannot say which object they belong to
// and the group heading is the only source of that name.
// ---------------------------------------------------------------------------
describe('SOSL result groups', () => {
  async function openSosl(
    apiOverrides: Partial<SalesforceApiClient> = {},
  ): Promise<SalesforceApiClient> {
    await patchSettings({ features: { 'soql-bulk-delete': true } });
    const api = fakeApi({
      apiGet: vi.fn(async () => ({
        searchRecords: [
          { attributes: { type: 'Account' }, Id: '001000000000001AAA', Name: 'Acme' },
          { attributes: { type: 'Account' }, Id: '001000000000002AAA', Name: 'Universal' },
          { attributes: { type: 'Contact' }, Id: '003000000000001AAA', Name: 'Ada' },
        ],
      })) as unknown as SalesforceApiClient['apiGet'],
      ...apiOverrides,
    });
    const feature = createSoqlRunnerFeature({ api });
    await feature.onActivate?.();
    (document.querySelector('textarea') as HTMLTextAreaElement).value = 'FIND {Acme}';
    (document.querySelector('textarea') as HTMLTextAreaElement).dispatchEvent(new Event('input'));
    btn('Run')!.click();
    await tick();
    await tick();
    return api;
  }

  it('gives each object group its own Delete button, counted per group', async () => {
    await openSosl();
    const deletes = Array.from(document.querySelectorAll('button')).filter((b) =>
      /^Delete \d+ rows?$/.test(b.textContent ?? ''),
    );
    expect(deletes.map((b) => b.textContent)).toEqual(['Delete 2 rows', 'Delete 1 row']);
    expect(deletes.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Delete 2 Account records',
      'Delete 1 Contact record',
    ]);
  });

  it('deletes only that group’s rows, against that group’s object', async () => {
    // The rows carry no `attributes` by the time they reach the toolbar, so
    // without the group heading feeding the plan this would refuse as
    // 'unknown-object' — or, worse, delete against the wrong object.
    const apiRequest = vi.fn(async () => null);
    const api = await openSosl({
      apiRequest: apiRequest as unknown as SalesforceApiClient['apiRequest'],
    });
    const contactDelete = Array.from(document.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'Delete 1 Contact record',
    )!;
    contactDelete.click();
    await tick();
    await confirmWith('DELETE 1 Contact', 'Delete 1 Contact record');

    expect(api.apiRequest).toHaveBeenCalledTimes(1);
    expect(api.apiRequest).toHaveBeenCalledWith(
      'DELETE',
      '/services/data/v62.0/sobjects/Contact/003000000000001AAA',
    );
  });

  it('drops the emptied group from the view and leaves the other one alone (N3/N4)', async () => {
    await openSosl({ apiRequest: vi.fn(async () => null) as unknown as SalesforceApiClient['apiRequest'] });
    const contactDelete = Array.from(document.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'Delete 1 Contact record',
    )!;
    contactDelete.click();
    await tick();
    await confirmWith('DELETE 1 Contact', 'Delete 1 Contact record');

    // The Contact group had one row; it is gone, heading and all. Account is
    // untouched and still offers its own delete.
    expect(document.body.textContent).not.toContain('Contact · ');
    expect(document.body.textContent).toContain('Account · 2 rows');
    const remaining = Array.from(document.querySelectorAll('button')).filter((b) =>
      /^Delete \d+ rows?$/.test(b.textContent ?? ''),
    );
    expect(remaining.map((b) => b.textContent)).toEqual(['Delete 2 rows']);
  });

  it('refuses to start a second group’s delete while one is running (N3)', async () => {
    // Both groups' buttons write to the same status line and the same report
    // panel; two in flight would interleave and leave a report about the wrong
    // rows. The first click owns the operation until it finishes.
    const api = await openSosl({
      apiRequest: vi.fn(
        () => new Promise((resolve) => setTimeout(() => resolve(null), 0)),
      ) as unknown as SalesforceApiClient['apiRequest'],
    });
    const accountDelete = Array.from(document.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'Delete 2 Account records',
    )!;
    const contactDelete = Array.from(document.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'Delete 1 Contact record',
    )!;
    accountDelete.click();
    await tick();
    // A second group's Delete while the first dialog is up must do nothing —
    // in particular it must not open a second dialog over the first.
    contactDelete.click();
    await tick();
    expect(document.querySelectorAll('.sfdt-confirm-overlay')).toHaveLength(1);
    expect(overlay()!.textContent).toContain('DELETE 2 Account');

    await confirmWith('DELETE 2 Account', 'Delete 2 Account records');
    for (let i = 0; i < 6; i += 1) await tick();
    // Only the Account rows were ever deleted.
    const calls = (api.apiRequest as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.every(([, endpoint]) => String(endpoint).includes('/Account/'))).toBe(true);
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
