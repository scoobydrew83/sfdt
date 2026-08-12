// C-P4-2 — bulk delete from the SOQL runner.
//
// The suite that matters here is "the guard rails" below. Everything else in
// this file is ordinary coverage; that describe block is the feature. It asserts
// what `runBulkDelete` REFUSES to do — that there is no reachable path from an
// ineligible result set, a failed backup, or an unconfirmed dialog to a single
// `deleteRecord` call. A happy-path delete test proves nothing about a guard
// rail, so the negative cases are pinned first and pinned hardest.

import { describe, it, expect, vi } from 'vitest';
import {
  BACKUP_REQUIRED_MESSAGE,
  DEFAULT_BATCH_SIZE,
  REJECTION_MESSAGES,
  SOQL_BULK_DELETE_ID,
  backupCsvCoversPlan,
  backupFilename,
  buildDeleteEndpoint,
  chunk,
  confirmPhrase,
  createSoqlBulkDeleteFeature,
  describePlan,
  formatBulkDeleteReport,
  planBulkDelete,
  rowRecordId,
  runBulkDelete,
  summariseFailures,
  type BulkDeleteDeps,
  type BulkDeleteOutcome,
} from '../features/soql-bulk-delete.js';
import { isFeatureEnabled, SettingsSchema, type Settings } from '../lib/settings.js';

const ACCOUNT_ROWS = [
  { attributes: { type: 'Account' }, Id: '001000000000001AAA', Name: 'Acme' },
  { attributes: { type: 'Account' }, Id: '001000000000002AAA', Name: 'Universal' },
  { attributes: { type: 'Account' }, Id: '001000000000003AAA', Name: 'Initech' },
];

/**
 * Deps whose every gate PASSES, with spies on all three. Each guard-rail test
 * breaks exactly one of them and asserts `deleteRecord` was never reached — so
 * a test can only pass by the gate it names, not by some unrelated failure.
 */
function passingDeps(overrides: Partial<BulkDeleteDeps> = {}): {
  deps: BulkDeleteDeps;
  backup: ReturnType<typeof vi.fn>;
  confirm: ReturnType<typeof vi.fn>;
  deleteRecord: ReturnType<typeof vi.fn>;
} {
  const backup = vi.fn(() => true);
  const confirm = vi.fn(() => true);
  const deleteRecord = vi.fn(async () => null);
  return {
    backup,
    confirm,
    deleteRecord,
    deps: { backup, confirm, deleteRecord, ...overrides } as BulkDeleteDeps,
  };
}

// ---------------------------------------------------------------------------
// THE GUARD RAILS — no delete path without eligibility + backup + confirm
// ---------------------------------------------------------------------------

describe('the guard rails — there is no delete path without a backup and a typed confirm', () => {
  it('never deletes when the result set has no Id column (AC-1: only offered when Id is present)', async () => {
    const { deps, backup, confirm, deleteRecord } = passingDeps();
    const outcome = await runBulkDelete(
      [{ attributes: { type: 'Account' }, Name: 'Acme' }],
      deps,
    );
    expect(outcome).toEqual({ status: 'ineligible', reason: 'no-id-column' });
    // Not merely "no delete" — the user is never even asked, and no file is written.
    expect(deleteRecord).not.toHaveBeenCalled();
    expect(backup).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('never deletes when the Id column holds nothing that is a record Id', async () => {
    const { deps, backup, confirm, deleteRecord } = passingDeps();
    const outcome = await runBulkDelete(
      [{ attributes: { type: 'Account' }, Id: 'not-an-id' }],
      deps,
    );
    expect(outcome).toEqual({ status: 'ineligible', reason: 'no-valid-ids' });
    expect(deleteRecord).not.toHaveBeenCalled();
    expect(backup).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('never deletes when the rows span more than one object', async () => {
    const { deps, deleteRecord } = passingDeps();
    const outcome = await runBulkDelete(
      [
        { attributes: { type: 'Account' }, Id: '001000000000001AAA' },
        { attributes: { type: 'Contact' }, Id: '003000000000001AAA' },
      ],
      deps,
    );
    expect(outcome).toEqual({ status: 'ineligible', reason: 'mixed-objects' });
    expect(deleteRecord).not.toHaveBeenCalled();
  });

  it('never deletes when the backup returns false — and never even shows the confirm', async () => {
    const { deps, confirm, deleteRecord } = passingDeps({ backup: () => false });
    const outcome = await runBulkDelete(ACCOUNT_ROWS, deps);
    expect(outcome).toEqual({ status: 'backup-failed', message: BACKUP_REQUIRED_MESSAGE });
    expect(confirm).not.toHaveBeenCalled();
    expect(deleteRecord).not.toHaveBeenCalled();
  });

  it('never deletes when the backup throws', async () => {
    const { deps, confirm, deleteRecord } = passingDeps({
      backup: () => {
        throw new Error('URL.createObjectURL is not a function');
      },
    });
    const outcome = await runBulkDelete(ACCOUNT_ROWS, deps);
    expect(outcome).toEqual({
      status: 'backup-failed',
      message: 'URL.createObjectURL is not a function',
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(deleteRecord).not.toHaveBeenCalled();
  });

  it('never deletes when the backup resolves anything other than exactly true', async () => {
    // A callback that forgets to return, or returns a row count, must not read
    // as consent. `=== true` is the contract; truthiness is not.
    for (const value of [undefined, null, 0, '', 'ok', 1, {}] as unknown[]) {
      const { deps, confirm, deleteRecord } = passingDeps({
        backup: (() => value) as unknown as BulkDeleteDeps['backup'],
      });
      const outcome = await runBulkDelete(ACCOUNT_ROWS, deps);
      expect(outcome.status).toBe('backup-failed');
      expect(confirm).not.toHaveBeenCalled();
      expect(deleteRecord).not.toHaveBeenCalled();
    }
  });

  it('never deletes when the typed confirm is declined', async () => {
    const { deps, backup, deleteRecord } = passingDeps({ confirm: () => false });
    const outcome = await runBulkDelete(ACCOUNT_ROWS, deps);
    expect(outcome).toEqual({ status: 'not-confirmed' });
    expect(backup).toHaveBeenCalledTimes(1); // the backup DID run — order is backup, then ask
    expect(deleteRecord).not.toHaveBeenCalled();
  });

  it('never deletes when the confirm dialog itself throws', async () => {
    const { deps, deleteRecord } = passingDeps({
      confirm: () => {
        throw new Error('dialog failed to mount');
      },
    });
    const outcome = await runBulkDelete(ACCOUNT_ROWS, deps);
    // A dialog that could not be shown is a refusal, never a consent.
    expect(outcome).toEqual({ status: 'not-confirmed' });
    expect(deleteRecord).not.toHaveBeenCalled();
  });

  it('never deletes when the confirm resolves anything other than exactly true', async () => {
    for (const value of [undefined, null, 0, '', 'yes', 1] as unknown[]) {
      const { deps, deleteRecord } = passingDeps({
        confirm: (() => value) as unknown as BulkDeleteDeps['confirm'],
      });
      const outcome = await runBulkDelete(ACCOUNT_ROWS, deps);
      expect(outcome).toEqual({ status: 'not-confirmed' });
      expect(deleteRecord).not.toHaveBeenCalled();
    }
  });

  it('runs the gates in order: backup completes BEFORE the confirm is shown', async () => {
    // The AC's ordering is load-bearing — a confirm shown before the backup
    // exists would let a user consent to a delete with no recovery file.
    const calls: string[] = [];
    const outcome = await runBulkDelete(ACCOUNT_ROWS, {
      backup: () => {
        calls.push('backup');
        return true;
      },
      confirm: () => {
        calls.push('confirm');
        return true;
      },
      deleteRecord: async (id) => {
        calls.push(`delete:${id}`);
        return null;
      },
    });
    expect(outcome.status).toBe('done');
    expect(calls.slice(0, 2)).toEqual(['backup', 'confirm']);
    expect(calls.slice(2)).toEqual(ACCOUNT_ROWS.map((r) => `delete:${r.Id}`));
  });

  it('hands the confirm gate the exact phrase the user has to type, and backs up exactly the affected rows', async () => {
    const { deps, backup, confirm } = passingDeps();
    await runBulkDelete(ACCOUNT_ROWS, deps);

    const [plan, phrase] = confirm.mock.calls[0]!;
    expect(phrase).toBe('DELETE 3 Account');
    expect(phrase).toBe(confirmPhrase(plan));
    // The backup sees the same plan — the rows it writes are the rows the
    // phrase counted, not the whole result set.
    expect(backup.mock.calls[0]![0]).toBe(plan);
    expect(plan.rows).toEqual(ACCOUNT_ROWS);
  });

  it('backs up only the rows it is about to delete, never the unaffected ones', async () => {
    const { deps, backup, deleteRecord } = passingDeps();
    await runBulkDelete(
      [
        ACCOUNT_ROWS[0]!,
        { attributes: { type: 'Account' }, Id: null, Name: 'no id here' },
        ACCOUNT_ROWS[1]!,
      ],
      deps,
    );
    const plan = backup.mock.calls[0]![0];
    expect(plan.rows).toEqual([ACCOUNT_ROWS[0], ACCOUNT_ROWS[1]]);
    expect(deleteRecord).toHaveBeenCalledTimes(2);
  });

  it('never signals the destructive phase when a gate refuses', async () => {
    // `onConfirmed` is what the UI hangs "the point of no return" on (it is
    // where the runner disables its trigger). Firing it on a refused operation
    // would leave the UI in a deleting state for a delete that never ran.
    const onConfirmed = vi.fn();
    const noBackup = passingDeps({ backup: () => false, onConfirmed });
    await runBulkDelete(ACCOUNT_ROWS, { ...noBackup.deps, onConfirmed });
    expect(onConfirmed).not.toHaveBeenCalled();

    const noConfirm = passingDeps({ confirm: () => false, onConfirmed });
    await runBulkDelete(ACCOUNT_ROWS, { ...noConfirm.deps, onConfirmed });
    expect(onConfirmed).not.toHaveBeenCalled();

    const ineligible = passingDeps({ onConfirmed });
    await runBulkDelete([{ Name: 'no id' }], { ...ineligible.deps, onConfirmed });
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  it('signals the destructive phase exactly once, after both gates, before any delete', async () => {
    const calls: string[] = [];
    await runBulkDelete(ACCOUNT_ROWS, {
      backup: () => {
        calls.push('backup');
        return true;
      },
      confirm: () => {
        calls.push('confirm');
        return true;
      },
      onConfirmed: () => calls.push('onConfirmed'),
      deleteRecord: async () => {
        calls.push('delete');
        return null;
      },
    });
    expect(calls.slice(0, 3)).toEqual(['backup', 'confirm', 'onConfirmed']);
    expect(calls.filter((c) => c === 'onConfirmed')).toHaveLength(1);
  });

  it('is the only exported way to reach a delete — the module exposes no unguarded deleter', () => {
    // A structural check, not a behavioural one: if a future change adds a
    // second exported function that issues deletes, the guard rails above stop
    // being a guarantee about the module and become a guarantee about one
    // function. Keep the delete on runBulkDelete.
    const moduleExports = Object.keys({
      BACKUP_REQUIRED_MESSAGE,
      DEFAULT_BATCH_SIZE,
      REJECTION_MESSAGES,
      SOQL_BULK_DELETE_ID,
      backupCsvCoversPlan,
      backupFilename,
      buildDeleteEndpoint,
      chunk,
      confirmPhrase,
      createSoqlBulkDeleteFeature,
      describePlan,
      formatBulkDeleteReport,
      planBulkDelete,
      rowRecordId,
      runBulkDelete,
      summariseFailures,
    });
    // buildDeleteEndpoint only builds a string; everything else is pure.
    expect(moduleExports.filter((name) => /^run|^delete|^execute/i.test(name))).toEqual([
      'runBulkDelete',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Opt-in (AC-2)
// ---------------------------------------------------------------------------

describe('opt-in — the feature ships off', () => {
  it('declares enabledByDefault: false on its manifest', () => {
    const feature = createSoqlBulkDeleteFeature();
    expect(feature.manifest.id).toBe('soql-bulk-delete');
    expect(feature.manifest.enabledByDefault).toBe(false);
    // Metadata only: no injected UI of its own, so nothing to init or activate.
    expect(feature.init).toBeUndefined();
    expect(feature.onActivate).toBeUndefined();
  });

  it('declares no manifest permissions — a record DELETE rides the existing worker proxy', () => {
    expect(createSoqlBulkDeleteFeature().manifest.permissions).toBeUndefined();
  });

  it('resolves to DISABLED for a user who has never touched the toggle', () => {
    const fresh = SettingsSchema.parse({}) as Settings;
    expect(isFeatureEnabled(fresh, SOQL_BULK_DELETE_ID)).toBe(false);
  });

  it('resolves to enabled once the user opts in, and off again when they opt back out', () => {
    const on = SettingsSchema.parse({ features: { [SOQL_BULK_DELETE_ID]: true } }) as Settings;
    expect(isFeatureEnabled(on, SOQL_BULK_DELETE_ID)).toBe(true);
    const off = SettingsSchema.parse({ features: { [SOQL_BULK_DELETE_ID]: false } }) as Settings;
    expect(isFeatureEnabled(off, SOQL_BULK_DELETE_ID)).toBe(false);
  });

  it('mirrors the SOQL runner’s contexts — it can only appear where a result toolbar can', () => {
    expect(createSoqlBulkDeleteFeature().manifest.contexts).toEqual([
      'setup_flows',
      'setup_other',
      'flow_builder',
      'flow_trigger_explorer',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

describe('planBulkDelete', () => {
  it('reduces a result set to its object, its Ids and the rows they came from', () => {
    const result = planBulkDelete(ACCOUNT_ROWS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.sobject).toBe('Account');
    expect(result.plan.ids).toEqual([
      '001000000000001AAA',
      '001000000000002AAA',
      '001000000000003AAA',
    ]);
    expect(result.plan.rows).toHaveLength(3);
  });

  it('rejects an empty result set', () => {
    expect(planBulkDelete([])).toEqual({ ok: false, reason: 'no-rows' });
    expect(planBulkDelete(null)).toEqual({ ok: false, reason: 'no-rows' });
    expect(planBulkDelete(undefined)).toEqual({ ok: false, reason: 'no-rows' });
  });

  it('accepts a lowercase id column', () => {
    const result = planBulkDelete([{ attributes: { type: 'Account' }, id: '001000000000001AAA' }]);
    expect(result.ok).toBe(true);
  });

  it('dedupes repeated Ids so a row cannot be deleted twice', () => {
    const result = planBulkDelete([ACCOUNT_ROWS[0]!, ACCOUNT_ROWS[0]!, ACCOUNT_ROWS[1]!]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.ids).toEqual(['001000000000001AAA', '001000000000002AAA']);
    expect(result.plan.rows).toHaveLength(2);
  });

  it('takes an explicit object name for rows with no attributes envelope (the SOSL groups)', () => {
    const soslRows = [{ Id: '001000000000001AAA', Name: 'Acme' }];
    expect(planBulkDelete(soslRows)).toEqual({ ok: false, reason: 'unknown-object' });
    const result = planBulkDelete(soslRows, { sobject: 'Account' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.sobject).toBe('Account');
  });

  it('drops a row whose own envelope disagrees with the explicit object name', () => {
    // The doc contract: "When both are available the explicit name wins, and rows
    // that disagree with it are dropped rather than silently deleted against the
    // wrong object." Every Id here is valid, so reaching 'unknown-object' means
    // the rows were dropped by the disagreement — not by an unusable Id.
    const contactRows = [
      { attributes: { type: 'Contact' }, Id: '003000000000001AAA' },
      { attributes: { type: 'Contact' }, Id: '003000000000002AAA' },
    ];
    expect(planBulkDelete(contactRows, { sobject: 'Account' })).toEqual({
      ok: false,
      reason: 'unknown-object',
    });
  });

  it('keeps the agreeing rows and drops only the disagreeing one', () => {
    // Guards the other half: the check must not be so blunt that one foreign row
    // takes the whole plan down, and must not widen the plan to the foreign row.
    const mixed = [
      ACCOUNT_ROWS[0]!,
      { attributes: { type: 'Contact' }, Id: '003000000000009AAA' },
      ACCOUNT_ROWS[1]!,
    ];
    const result = planBulkDelete(mixed, { sobject: 'Account' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.sobject).toBe('Account');
    expect(result.plan.ids).toEqual(['001000000000001AAA', '001000000000002AAA']);
    expect(result.plan.ids).not.toContain('003000000000009AAA');
    expect(result.plan.rows).toHaveLength(2);
  });

  it('still takes the declared name for a row with no envelope, alongside an enveloped one', () => {
    // The declared name exists FOR the envelope-less SOSL rows — the disagreement
    // check must not start dropping them, which is the obvious way to break this.
    const result = planBulkDelete(
      [ACCOUNT_ROWS[0]!, { Id: '001000000000009AAA', Name: 'No envelope' }],
      { sobject: 'Account' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.ids).toEqual(['001000000000001AAA', '001000000000009AAA']);
  });

  it('refuses an object name that is not an API name, rather than escaping it into a URL', () => {
    expect(planBulkDelete(ACCOUNT_ROWS, { sobject: '../../limits' })).toEqual({
      ok: false,
      reason: 'unknown-object',
    });
  });

  it('ignores blank/000 keys and non-string Id values', () => {
    const result = planBulkDelete([
      { attributes: { type: 'Account' }, Id: '000000000000000AAA' },
      { attributes: { type: 'Account' }, Id: 12345 },
      { attributes: { type: 'Account' }, Id: '' },
    ]);
    expect(result).toEqual({ ok: false, reason: 'no-valid-ids' });
  });

  it('does not throw on malformed rows', () => {
    const rows = [null, 42, 'nope', [], ACCOUNT_ROWS[0]] as unknown as Array<
      Record<string, unknown>
    >;
    const result = planBulkDelete(rows);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.ids).toEqual(['001000000000001AAA']);
  });
});

describe('confirmPhrase / describePlan', () => {
  it('builds the AC-1 phrase: DELETE <n> <Object>', () => {
    const result = planBulkDelete(ACCOUNT_ROWS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(confirmPhrase(result.plan)).toBe('DELETE 3 Account');
    expect(describePlan(result.plan)).toBe('3 Account records');
  });

  it('singularises one row', () => {
    const result = planBulkDelete([ACCOUNT_ROWS[0]!]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(confirmPhrase(result.plan)).toBe('DELETE 1 Account');
    expect(describePlan(result.plan)).toBe('1 Account record');
  });
});

describe('the backup payload check (B2)', () => {
  const plan = () => {
    const result = planBulkDelete(ACCOUNT_ROWS);
    if (!result.ok) throw new Error('fixture should be eligible');
    return result.plan;
  };

  it('accepts a CSV that contains every Id in the plan', () => {
    const csv = `Id,Name\n${ACCOUNT_ROWS.map((r) => `${r.Id},${r.Name}`).join('\n')}\n`;
    expect(backupCsvCoversPlan(csv, plan())).toBe(true);
  });

  it('rejects an empty or missing payload — a backup of nothing is not a backup', () => {
    expect(backupCsvCoversPlan('', plan())).toBe(false);
    expect(backupCsvCoversPlan(undefined as unknown as string, plan())).toBe(false);
  });

  it('rejects a CSV that is missing even one of the rows about to be deleted', () => {
    const csv = `Id,Name\n${ACCOUNT_ROWS.slice(0, 2).map((r) => `${r.Id},${r.Name}`).join('\n')}\n`;
    expect(backupCsvCoversPlan(csv, plan())).toBe(false);
  });

  it('rejects a header-only CSV — the shape of a serialiser that dropped every row', () => {
    expect(backupCsvCoversPlan('Id,Name\n', plan())).toBe(false);
  });
});

describe('backupFilename', () => {
  it('names the object and the day, so the user can find it in their downloads', () => {
    const result = planBulkDelete(ACCOUNT_ROWS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(backupFilename(result.plan, new Date('2026-08-05T09:00:00Z'))).toBe(
      'sfdt-delete-backup-Account-2026-08-05.csv',
    );
  });
});

describe('rowRecordId', () => {
  it('answers with the same Id the plan used, so the UI drops the right row', () => {
    expect(rowRecordId({ Id: '001000000000001AAA' })).toBe('001000000000001AAA');
    expect(rowRecordId({ id: '001000000000001AAA' })).toBe('001000000000001AAA');
    expect(rowRecordId({ Id: 'not-an-id' })).toBeNull();
    expect(rowRecordId({ Name: 'Acme' })).toBeNull();
  });
});

describe('buildDeleteEndpoint', () => {
  it('builds the REST and Tooling single-record paths', () => {
    expect(buildDeleteEndpoint('v62.0', 'Account', '001000000000001AAA')).toBe(
      '/services/data/v62.0/sobjects/Account/001000000000001AAA',
    );
    expect(buildDeleteEndpoint('v62.0', 'TraceFlag', '7tf000000000001AAA', 'tooling')).toBe(
      '/services/data/v62.0/tooling/sobjects/TraceFlag/7tf000000000001AAA',
    );
  });

  it('throws rather than emit a path built from an unvalidated object or Id', () => {
    expect(() => buildDeleteEndpoint('v62.0', '../limits', '001000000000001AAA')).toThrow();
    expect(() => buildDeleteEndpoint('v62.0', 'Account', '../../limits')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Batching
// ---------------------------------------------------------------------------

describe('batching', () => {
  it('splits into fixed-size waves, preserving order', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
    // A nonsense size degrades to one-at-a-time rather than looping forever.
    expect(chunk([1, 2], 0)).toEqual([[1], [2]]);
  });

  it('deletes in waves of batchSize, not all at once', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      attributes: { type: 'Account' },
      Id: `00100000000000${i + 1}AAA`,
    }));
    // Each delete stays pending for a macrotask, so the peak concurrency is the
    // wave size — an unbatched `Promise.all` over all five would peak at 5.
    let inFlight = 0;
    let peak = 0;
    const outcome = await runBulkDelete(rows, {
      backup: () => true,
      confirm: () => true,
      batchSize: 2,
      deleteRecord: () =>
        new Promise<null>((resolve) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          setTimeout(() => {
            inFlight -= 1;
            resolve(null);
          }, 0);
        }),
    });

    expect(outcome.status).toBe('done');
    if (outcome.status !== 'done') return;
    expect(outcome.deleted).toBe(5);
    // 5 rows at batchSize 2 ⇒ waves of 2, 2, 1 — never 5 concurrent requests.
    expect(peak).toBe(2);
  });

  it('defaults to DEFAULT_BATCH_SIZE', () => {
    expect(DEFAULT_BATCH_SIZE).toBe(25);
  });

  it('reports progress after every wave, ending at the totals', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({
      attributes: { type: 'Account' },
      Id: `00100000000000${i + 1}AAA`,
    }));
    const progress: Array<{ deleted: number; failed: number; total: number }> = [];
    await runBulkDelete(rows, {
      backup: () => true,
      confirm: () => true,
      batchSize: 1,
      deleteRecord: async () => null,
      onProgress: (p) => progress.push({ ...p }),
    });
    // One initial 0-of-3 tick so the status line appears before the first
    // round-trip, then one per wave.
    expect(progress).toEqual([
      { deleted: 0, failed: 0, total: 3 },
      { deleted: 1, failed: 0, total: 3 },
      { deleted: 2, failed: 0, total: 3 },
      { deleted: 3, failed: 0, total: 3 },
    ]);
  });

  it('stops between waves when the signal aborts, and says it was canceled', async () => {
    const rows = Array.from({ length: 4 }, (_, i) => ({
      attributes: { type: 'Account' },
      Id: `00100000000000${i + 1}AAA`,
    }));
    const signal = { aborted: false };
    const deleteRecord = vi.fn(async () => {
      signal.aborted = true; // abort during the first wave
      return null;
    });
    const outcome = await runBulkDelete(rows, {
      backup: () => true,
      confirm: () => true,
      batchSize: 2,
      signal,
      deleteRecord,
    });
    expect(outcome.status).toBe('done');
    if (outcome.status !== 'done') return;
    expect(outcome.canceled).toBe(true);
    // The in-flight wave finished; the next one never started.
    expect(deleteRecord).toHaveBeenCalledTimes(2);
    expect(outcome.deleted).toBe(2);
    expect(outcome.total).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Failure aggregation
// ---------------------------------------------------------------------------

function taggedError(message: string, kind: string): Error {
  const err = new Error(message);
  (err as Error & { sfdtKind: string }).sfdtKind = kind;
  return err;
}

describe('failure aggregation', () => {
  it('keeps going after a failed row and reports every failure with its Id', async () => {
    const rows = Array.from({ length: 4 }, (_, i) => ({
      attributes: { type: 'Account' },
      Id: `00100000000000${i + 1}AAA`,
    }));
    const outcome = await runBulkDelete(rows, {
      backup: () => true,
      confirm: () => true,
      batchSize: 2,
      deleteRecord: async (id) => {
        if (id.endsWith('2AAA')) throw taggedError('ENTITY_IS_DELETED', 'http-error');
        if (id.endsWith('3AAA')) throw taggedError('worker did not respond', 'timeout');
        return null;
      },
    });
    expect(outcome.status).toBe('done');
    if (outcome.status !== 'done') return;
    expect(outcome.deleted).toBe(2);
    expect(outcome.total).toBe(4);
    expect(outcome.failures).toEqual([
      { id: '001000000000002AAA', kind: 'http-error', message: 'ENTITY_IS_DELETED' },
      { id: '001000000000003AAA', kind: 'timeout', message: 'worker did not respond' },
    ]);
    // N7: a run that hit failures but was never aborted is NOT canceled. Without
    // this, an implementation that gave up after the first failure and reported
    // `canceled: true` would satisfy every other assertion here.
    expect(outcome.canceled).toBe(false);
    // Every id is accounted for exactly once, as either deleted or failed.
    expect([...outcome.deletedIds, ...outcome.failures.map((f) => f.id)].sort()).toEqual(
      rows.map((r) => r.Id).sort(),
    );
  });

  it('names the rows the org confirmed gone, and never a timed-out one', async () => {
    // `deletedIds` drives which rows the UI removes from the table, so a
    // timed-out row — outcome unknown — must not be in it. Dropping it from the
    // view would tell the user it is gone when nobody knows that.
    const rows = Array.from({ length: 3 }, (_, i) => ({
      attributes: { type: 'Account' },
      Id: `00100000000000${i + 1}AAA`,
    }));
    const outcome = await runBulkDelete(rows, {
      backup: () => true,
      confirm: () => true,
      deleteRecord: async (id) => {
        if (id.endsWith('2AAA')) throw taggedError('no answer', 'timeout');
        return null;
      },
    });
    expect(outcome.status).toBe('done');
    if (outcome.status !== 'done') return;
    expect(outcome.deletedIds).toEqual(['001000000000001AAA', '001000000000003AAA']);
    expect(outcome.deleted).toBe(outcome.deletedIds.length);
  });

  it('classifies each failure by sfApiErrorKind, not by matching the message text', async () => {
    // The point of C-FIX-1's discriminant. An error whose MESSAGE says
    // "timeout" but whose tag says http-error is an http-error.
    const outcome = await runBulkDelete([ACCOUNT_ROWS[0]!], {
      backup: () => true,
      confirm: () => true,
      deleteRecord: async () => {
        throw taggedError('Request timeout while contacting Salesforce', 'http-error');
      },
    });
    expect(outcome.status).toBe('done');
    if (outcome.status !== 'done') return;
    expect(outcome.failures[0]!.kind).toBe('http-error');
  });

  it('records an untagged rejection as unknown rather than guessing', async () => {
    const outcome = await runBulkDelete([ACCOUNT_ROWS[0]!], {
      backup: () => true,
      confirm: () => true,
      deleteRecord: async () => {
        throw new Error('boom');
      },
    });
    expect(outcome.status).toBe('done');
    if (outcome.status !== 'done') return;
    expect(outcome.failures[0]).toEqual({
      id: '001000000000001AAA',
      kind: 'unknown',
      message: 'boom',
    });
  });

  it('summarises failures by kind in a stable order', () => {
    expect(
      summariseFailures([
        { id: 'a', kind: 'http-error', message: '' },
        { id: 'b', kind: 'timeout', message: '' },
        { id: 'c', kind: 'http-error', message: '' },
        { id: 'd', kind: 'unknown', message: '' },
      ]),
    ).toEqual([
      { kind: 'timeout', count: 1 },
      { kind: 'http-error', count: 2 },
      { kind: 'unknown', count: 1 },
    ]);
  });
});

describe('formatBulkDeleteReport', () => {
  const done = (over: Partial<Extract<BulkDeleteOutcome, { status: 'done' }>> = {}) =>
    ({
      status: 'done',
      sobject: 'Account',
      total: 3,
      deleted: 3,
      failures: [],
      canceled: false,
      ...over,
    }) as BulkDeleteOutcome;

  it('reports a clean run in one line', () => {
    expect(formatBulkDeleteReport(done())).toBe('Deleted 3 of 3 Account records.');
  });

  it('lists every failed row so the user can retry exactly those', () => {
    const report = formatBulkDeleteReport(
      done({
        deleted: 1,
        failures: [
          { id: '001000000000002AAA', kind: 'http-error', message: 'ENTITY_IS_DELETED' },
          { id: '001000000000003AAA', kind: 'no-session', message: 'No Salesforce session' },
        ],
      }),
    );
    expect(report).toContain('Deleted 1 of 3 Account records.');
    expect(report).toContain('2 failed — 1 no Salesforce session, 1 rejected by Salesforce.');
    expect(report).toContain('001000000000002AAA — ENTITY_IS_DELETED');
    expect(report).toContain('001000000000003AAA — No Salesforce session');
  });

  it('says a timed-out delete may still have committed', () => {
    // The failure whose outcome is genuinely unknown. Calling it "failed" and
    // inviting a retry is how a record gets deleted twice, or believed alive.
    const report = formatBulkDeleteReport(
      done({
        deleted: 2,
        failures: [{ id: '001000000000003AAA', kind: 'timeout', message: 'no answer' }],
      }),
    );
    expect(report).toContain('1 row timed out');
    expect(report).toContain('may still have committed');
  });

  it('does not summarise an unclassified failure as "failed" twice (C-FIX-5)', () => {
    // The summary reads `${count} ${label}` under a lead-in that already gives
    // the count, and `unknown`'s label was the word "failed" — so a single
    // unrecognised error printed `1 failed — 1 failed.`, which told the reader
    // nothing and read like a bug. Pre-existing from round 1.
    const report = formatBulkDeleteReport(
      done({
        deleted: 2,
        failures: [{ id: '001000000000003AAA', kind: 'unknown', message: 'boom' }],
      }),
    );
    expect(report).not.toContain('1 failed — 1 failed');
    expect(report).toContain('1 failed.');
    expect(report).toContain('001000000000003AAA — boom');
    // …and alongside a kind that DOES have something to say, the breakdown is
    // still there and still names the unclassified one.
    const mixed = formatBulkDeleteReport(
      done({
        deleted: 1,
        failures: [
          { id: '001000000000002AAA', kind: 'timeout', message: 'no answer' },
          { id: '001000000000003AAA', kind: 'unknown', message: 'boom' },
        ],
      }),
    );
    expect(mixed).toContain('2 failed — 1 timed out, 1 unclassified.');
  });

  it('notes a cancellation', () => {
    expect(formatBulkDeleteReport(done({ deleted: 2, canceled: true }))).toContain(
      'Canceled before the remaining rows were attempted',
    );
  });

  it('has nothing to report for an outcome that never reached the deletes', () => {
    expect(formatBulkDeleteReport({ status: 'not-confirmed' })).toBe('');
    expect(formatBulkDeleteReport({ status: 'ineligible', reason: 'no-rows' })).toBe('');
  });
});

describe('rejection copy', () => {
  it('has a message for every rejection reason', () => {
    const reasons = [
      'no-rows',
      'no-id-column',
      'no-valid-ids',
      'unknown-object',
      'mixed-objects',
    ] as const;
    for (const reason of reasons) {
      expect(REJECTION_MESSAGES[reason]).toBeTruthy();
    }
  });

  it('tells the user how to make a result set eligible', () => {
    expect(REJECTION_MESSAGES['no-id-column']).toContain('Id');
  });
});
