// C-P4-2 — bulk delete from the SOQL runner's result set.
//
// THE GUARD RAILS ARE THE FEATURE. Deleting N records by Id is four lines of
// HTTP; everything that matters here is what has to be true before those four
// lines are allowed to run. So the delete is not a function the UI can call —
// it is the tail of ONE exported orchestrator, `runBulkDelete()`, which owns
// all three gates and reaches `deps.deleteRecord` only after every one of them
// has passed in order:
//
//   1. ELIGIBILITY — the rows must resolve to a single, well-formed sObject and
//      at least one syntactically valid record Id. `planBulkDelete()` decides;
//      a rejection returns `ineligible` and nothing else runs.
//   2. BACKUP — `deps.backup(plan)` must resolve exactly `true`. A `false`, an
//      `undefined`, or a throw all return `backup-failed`, and the confirm is
//      never even shown. This is the AC-1 "automatic backup CSV download of the
//      affected rows" made structural: there is no code path from an unbacked
//      plan to a delete.
//   3. TYPED CONFIRM — `deps.confirm(plan, phrase)` must resolve exactly
//      `true`, where `phrase` is `confirmPhrase(plan)` (`DELETE 12 Account`).
//      Anything else returns `not-confirmed`.
//
// Every gate is `=== true`, never truthy: a callback that accidentally returns
// a non-empty string, a Promise, or a row count must not read as consent.
//
// The UI half of this lives in features/soql-runner.ts (the result toolbar's
// "Delete rows" button, the backup download, the confirm dialog and the report
// panel). This module is DOM-free and I/O-free by design so the guard rails can
// be tested for what they REFUSE to do, which is the only property worth
// testing here — see test/soql-bulk-delete.ts's "no delete path without backup
// + confirm" suite.
//
// Off by default: the manifest declares `enabledByDefault: false`, which
// lib/feature-defaults.ts seeds from the checked-in feature-manifests.json and
// lib/settings.ts's isFeatureEnabled() honours. Nothing about this feature is
// reachable until the user ticks its box on the options page.

import { CONTEXTS } from '../lib/context-detector.js';
import { exportFilename } from '../lib/download.js';
import type { Feature } from '../lib/feature-registry.js';
import { sfApiErrorKind, type SfApiErrorKind } from '../lib/salesforce-api.js';
import { isRecordId } from '../lib/salesforce-id.js';

/** Settings / kill-switch id — the feature-registry key. */
export const SOQL_BULK_DELETE_ID = 'soql-bulk-delete';

/**
 * Records deleted per round trip wave.
 *
 * 25 is the same order as the debug-log viewer's chunked delete (10) rather
 * than an unbounded `Promise.all`: a 2,000-row result set fired at once is
 * 2,000 simultaneous worker messages, which either trips the org's concurrent
 * request limit or serialises into a multi-minute hang with no progress. Waves
 * also give `onProgress` something to report and `signal` somewhere to be
 * checked. Overridable per call so tests can pin the batching with three rows.
 */
export const DEFAULT_BATCH_SIZE = 25;

/** Salesforce API names — also the only thing allowed into the endpoint path. */
const SOBJECT_NAME_RE = /^[A-Za-z0-9_]+$/;

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

export interface BulkDeletePlan {
  /** The single sObject every affected row belongs to. */
  sobject: string;
  /** Deduped, syntactically valid record Ids, in first-seen order. */
  ids: readonly string[];
  /**
   * The rows those Ids came from, in the same order — this is what the backup
   * CSV serialises. Rows whose Id was missing or unusable are NOT here, so the
   * backup describes exactly what is about to be destroyed and nothing else.
   */
  rows: ReadonlyArray<Record<string, unknown>>;
}

export type BulkDeleteRejection =
  /** Empty result set. */
  | 'no-rows'
  /** No `Id` column at all — AC-1's "only offered when the result set includes Id". */
  | 'no-id-column'
  /** An Id column, but nothing in it that looks like a record Id. */
  | 'no-valid-ids'
  /** Rows carry no `attributes.type` and the caller named no object. */
  | 'unknown-object'
  /** Rows span more than one sObject (a SOSL result handed over ungrouped). */
  | 'mixed-objects';

export type BulkDeletePlanResult =
  | { ok: true; plan: BulkDeletePlan }
  | { ok: false; reason: BulkDeleteRejection };

/** Human copy for a rejection. One place, so the toast and the tests agree. */
export const REJECTION_MESSAGES: Readonly<Record<BulkDeleteRejection, string>> = {
  'no-rows': 'Nothing to delete — run a query first.',
  'no-id-column': 'Bulk delete needs an Id column. Add Id to the SELECT list and re-run.',
  'no-valid-ids': 'No usable record Ids in these rows.',
  'unknown-object':
    'Cannot tell which object these rows belong to, so there is nothing safe to delete.',
  'mixed-objects': 'These rows span more than one object. Delete one object at a time.',
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The row's Id value, whatever case the column came back in.
 *
 * SOQL returns `Id`, but a Tooling query, an aliased sub-select, or a hand-typed
 * `select id from …` can produce `id`. Returns `undefined` when the row has no
 * Id-shaped column at all — which is a different answer from "has one, but its
 * value is junk", and the two reject with different reasons.
 */
function idColumnValue(row: Record<string, unknown>): { present: boolean; value: unknown } {
  for (const key of Object.keys(row)) {
    if (/^id$/i.test(key)) return { present: true, value: row[key] };
  }
  return { present: false, value: undefined };
}

/**
 * The row's record Id, or null when it has no usable one.
 *
 * Exported so the UI can drop deleted rows from a rendered result set using the
 * SAME notion of "which row is this" that the delete plan used. Two different
 * answers to that question is how a table ends up dropping the wrong row.
 */
export function rowRecordId(row: Record<string, unknown>): string | null {
  const { value } = idColumnValue(row);
  return typeof value === 'string' && isRecordId(value) ? value : null;
}

/** The row's own sObject name, from the Salesforce `attributes` envelope. */
function attributesType(row: Record<string, unknown>): string | null {
  const attributes = row.attributes;
  if (!isPlainRecord(attributes)) return null;
  const type = attributes.type;
  return typeof type === 'string' && type.length > 0 ? type : null;
}

/**
 * Decide whether a result set can be bulk deleted, and reduce it to exactly the
 * rows that would be.
 *
 * `opts.sobject` is for callers that already know the object and whose rows do
 * not carry it — the SOSL result groups, which strip `attributes` when they are
 * built. When both are available the explicit name wins, and rows that disagree
 * with it are dropped rather than silently deleted against the wrong object.
 *
 * Total over its argument types: a malformed row, a null, a number in the Id
 * column — none of them throw, they just fail to qualify. The one thing this
 * function must never do is return a plan it is not certain about.
 */
export function planBulkDelete(
  records: ReadonlyArray<Record<string, unknown>> | null | undefined,
  opts: { sobject?: string } = {},
): BulkDeletePlanResult {
  const rows = (records ?? []).filter(isPlainRecord);
  if (rows.length === 0) return { ok: false, reason: 'no-rows' };

  const declared = opts.sobject?.trim();
  if (declared !== undefined && declared.length > 0 && !SOBJECT_NAME_RE.test(declared)) {
    // An object name reaches the REST path; anything that is not an API name is
    // refused here rather than being escaped downstream.
    return { ok: false, reason: 'unknown-object' };
  }

  let sawIdColumn = false;
  const seen = new Set<string>();
  const ids: string[] = [];
  const affected: Array<Record<string, unknown>> = [];
  const objects = new Set<string>();

  for (const row of rows) {
    const { present, value } = idColumnValue(row);
    if (present) sawIdColumn = true;
    if (typeof value !== 'string' || !isRecordId(value)) continue;
    if (seen.has(value)) continue;

    const rowObject = declared && declared.length > 0 ? declared : attributesType(row);
    if (!rowObject) {
      // Keep looking: another row may carry the envelope. If none does we end
      // with no objects and report 'unknown-object' below.
      continue;
    }
    if (!SOBJECT_NAME_RE.test(rowObject)) continue;

    seen.add(value);
    ids.push(value);
    affected.push(row);
    objects.add(rowObject);
  }

  if (!sawIdColumn) return { ok: false, reason: 'no-id-column' };
  if (objects.size > 1) return { ok: false, reason: 'mixed-objects' };
  if (ids.length === 0) {
    // An Id column existed. Either every value in it was unusable, or the rows
    // never said which object they are — tell the user which.
    const anyValidId = rows.some((row) => isRecordId(idColumnValue(row).value));
    return { ok: false, reason: anyValidId ? 'unknown-object' : 'no-valid-ids' };
  }

  return {
    ok: true,
    plan: { sobject: [...objects][0]!, ids, rows: affected },
  };
}

/**
 * The exact string the user has to type. AC-1: `DELETE <n> <Object>`.
 *
 * The count is in the phrase on purpose — muscle memory can retype "DELETE",
 * but not a number the user has not read. A stale phrase (the result set
 * changed while the dialog was open) therefore cannot be confirmed by habit.
 */
export function confirmPhrase(plan: BulkDeletePlan): string {
  return `DELETE ${plan.ids.length} ${plan.sobject}`;
}

/** `12 Account records` — the preview count, shared by the button and the dialog. */
export function describePlan(plan: BulkDeletePlan): string {
  const n = plan.ids.length;
  return `${n} ${plan.sobject} record${n === 1 ? '' : 's'}`;
}

/**
 * The backup file's name — `sfdt-delete-backup-Account-2026-08-05.csv`.
 *
 * Named here rather than at the download call site because the CONFIRM DIALOG
 * has to show it. The extension cannot observe whether a download reached the
 * user's disk (that needs the `downloads` permission, which it deliberately
 * does not have), so the only entity that can confirm the backup exists is the
 * user — and they can only check a file they have been told the name of. That
 * turns an unverifiable claim into a checkable one.
 */
export function backupFilename(plan: BulkDeletePlan, now = new Date()): string {
  return exportFilename(`sfdt-delete-backup-${plan.sobject}`, 'csv', now);
}

/**
 * Does this CSV actually back up this plan?
 *
 * Checking that the download call did not throw says nothing about WHAT was
 * downloaded. This checks the payload: every Id the delete is about to destroy
 * has to appear in the text, or the file is not a backup of this operation and
 * the gate must fail. Catches an empty serialisation, a column set that dropped
 * Id, and a plan/rows mismatch — all of which would otherwise produce a
 * cheerful "backup saved" and an unrecoverable delete.
 *
 * Substring rather than a CSV parse on purpose: a record Id is an 18-character
 * opaque token that cannot occur by accident, so `includes` cannot pass a file
 * that lacks the row, and a parser here would be a second CSV implementation —
 * the exact thing this feature is not allowed to grow.
 */
export function backupCsvCoversPlan(csv: string, plan: BulkDeletePlan): boolean {
  if (typeof csv !== 'string' || csv.length === 0) return false;
  return plan.ids.every((id) => csv.includes(id));
}

/** REST (or Tooling) single-record DELETE path. */
export function buildDeleteEndpoint(
  apiVersion: string,
  sobject: string,
  id: string,
  mode: 'rest' | 'tooling' = 'rest',
): string {
  if (!SOBJECT_NAME_RE.test(sobject)) {
    throw new Error(`Refusing to build a delete endpoint for object name: ${sobject}`);
  }
  if (!isRecordId(id)) {
    throw new Error(`Refusing to build a delete endpoint for id: ${id}`);
  }
  const base = mode === 'tooling' ? `/tooling/sobjects` : `/sobjects`;
  return `/services/data/${apiVersion}${base}/${sobject}/${id}`;
}

/** Split a list into fixed-size waves, preserving order. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const step = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += step) out.push(items.slice(i, i + step));
  return out;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * One row that did not delete.
 *
 * `kind` is `sfApiErrorKind()`'s discriminant, not a substring of the message —
 * the whole reason C-FIX-1 put a stable tag on these errors. `'unknown'` covers
 * an error the client did not raise (a caller bug, a JSON parse failure).
 */
export interface BulkDeleteFailure {
  id: string;
  kind: SfApiErrorKind | 'unknown';
  message: string;
}

export interface BulkDeleteProgress {
  deleted: number;
  failed: number;
  total: number;
}

export interface BulkDeleteDeps {
  /**
   * Explicit object name for rows that do not carry `attributes.type` (the SOSL
   * groups). Passed straight to planBulkDelete.
   */
  sobject?: string;
  /**
   * GATE 2. Write the backup CSV of `plan.rows` and resolve `true` once it has
   * been handed to the browser. Resolve `false` (or throw) and NOTHING is
   * deleted — see the module header.
   */
  backup: (plan: BulkDeletePlan) => boolean | Promise<boolean>;
  /**
   * GATE 3. Show the typed confirmation and resolve `true` only when the user
   * typed `phrase` exactly. `phrase` is passed in rather than recomputed by the
   * caller so the dialog and the gate cannot disagree about what to type.
   */
  confirm: (plan: BulkDeletePlan, phrase: string) => boolean | Promise<boolean>;
  /** Delete ONE record. Must reject on failure — a resolve counts as deleted. */
  deleteRecord: (id: string, plan: BulkDeletePlan) => Promise<unknown>;
  /**
   * Fires once, after BOTH gates have passed and before the first delete.
   *
   * Exists because "the destructive phase has begun" is a different moment from
   * "the button was clicked", and the UI needs the first one. The runner
   * disables its trigger here rather than at click time: a disabled element
   * cannot receive focus, so disabling it before the confirm dialog opens sends
   * the dialog's focus-restore to `<body>` instead of back to the button the
   * user came from (see ui/confirm-dialog.ts's caller contract).
   *
   * Not a gate — its return value is ignored and a throw is not caught here, so
   * it must not be used to do anything that can fail.
   */
  onConfirmed?: (plan: BulkDeletePlan) => void;
  onProgress?: (progress: BulkDeleteProgress) => void;
  batchSize?: number;
  /** Checked between waves; an in-flight wave is always allowed to finish. */
  signal?: { aborted: boolean };
}

export type BulkDeleteOutcome =
  | { status: 'ineligible'; reason: BulkDeleteRejection }
  | { status: 'backup-failed'; message: string }
  | { status: 'not-confirmed' }
  | {
      status: 'done';
      sobject: string;
      total: number;
      deleted: number;
      /**
       * The Ids the org confirmed gone, in delete order.
       *
       * `deleted` is the count; this is the identity. The UI needs the identity
       * to drop exactly those rows from the table on screen — a result set that
       * still lists records the org no longer has is not merely cosmetic, it
       * offers a Delete button that would re-issue DELETEs against Ids that no
       * longer exist. Deliberately excludes timed-out rows: their outcome is
       * unknown, so they stay on screen to be re-checked.
       */
      deletedIds: string[];
      failures: BulkDeleteFailure[];
      canceled: boolean;
    };

export const BACKUP_REQUIRED_MESSAGE =
  'The backup CSV could not be saved, so nothing was deleted.';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toFailure(id: string, err: unknown): BulkDeleteFailure {
  return { id, kind: sfApiErrorKind(err) ?? 'unknown', message: errorMessage(err) };
}

/**
 * The ONLY path to a delete.
 *
 * Takes raw records rather than a `BulkDeletePlan` on purpose: if it accepted a
 * plan, eligibility would be the caller's promise and a hand-built plan could
 * walk straight past it. Planning here means the caller cannot skip gate 1 even
 * by accident, and the preview count the UI shows comes from calling
 * `planBulkDelete()` itself — the same function, so the two cannot disagree.
 *
 * Never throws: every outcome, including a backup or confirm callback that blew
 * up, comes back as a value. A destructive operation that reports failure by
 * unwinding the stack is one `catch` away from being ignored.
 */
export async function runBulkDelete(
  records: ReadonlyArray<Record<string, unknown>> | null | undefined,
  deps: BulkDeleteDeps,
): Promise<BulkDeleteOutcome> {
  // ---- GATE 1: eligibility -------------------------------------------------
  const planned = planBulkDelete(records, { sobject: deps.sobject });
  if (!planned.ok) return { status: 'ineligible', reason: planned.reason };
  const plan = planned.plan;

  // ---- GATE 2: backup ------------------------------------------------------
  let backedUp: unknown;
  try {
    backedUp = await deps.backup(plan);
  } catch (err) {
    return { status: 'backup-failed', message: errorMessage(err) };
  }
  // `=== true`, not truthy: only an explicit success counts as a backup.
  if (backedUp !== true) return { status: 'backup-failed', message: BACKUP_REQUIRED_MESSAGE };

  // ---- GATE 3: typed confirmation -----------------------------------------
  let confirmed: unknown;
  try {
    confirmed = await deps.confirm(plan, confirmPhrase(plan));
  } catch {
    // A dialog that failed to render is a refusal, never a consent.
    confirmed = false;
  }
  if (confirmed !== true) return { status: 'not-confirmed' };

  // ---- Deletes -------------------------------------------------------------
  // Past every gate: from here on the operation is destructive.
  deps.onConfirmed?.(plan);

  const total = plan.ids.length;
  const failures: BulkDeleteFailure[] = [];
  const deletedIds: string[] = [];
  let canceled = false;

  deps.onProgress?.({ deleted: 0, failed: 0, total });

  for (const wave of chunk(plan.ids, deps.batchSize ?? DEFAULT_BATCH_SIZE)) {
    if (deps.signal?.aborted) {
      canceled = true;
      break;
    }
    const settled = await Promise.allSettled(wave.map((id) => deps.deleteRecord(id, plan)));
    settled.forEach((result, index) => {
      const id = wave[index]!;
      if (result.status === 'fulfilled') deletedIds.push(id);
      else failures.push(toFailure(id, result.reason));
    });
    deps.onProgress?.({ deleted: deletedIds.length, failed: failures.length, total });
  }

  return {
    status: 'done',
    sobject: plan.sobject,
    total,
    deleted: deletedIds.length,
    deletedIds,
    failures,
    canceled,
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** How many rows failed for each reason. Order is stable for rendering/tests. */
export function summariseFailures(
  failures: readonly BulkDeleteFailure[],
): Array<{ kind: BulkDeleteFailure['kind']; count: number }> {
  const order: Array<BulkDeleteFailure['kind']> = ['timeout', 'no-session', 'http-error', 'unknown'];
  const counts = new Map<BulkDeleteFailure['kind'], number>();
  for (const failure of failures) counts.set(failure.kind, (counts.get(failure.kind) ?? 0) + 1);
  return order
    .filter((kind) => counts.has(kind))
    .map((kind) => ({ kind, count: counts.get(kind)! }));
}

const KIND_LABELS: Readonly<Record<BulkDeleteFailure['kind'], string>> = {
  timeout: 'timed out',
  'no-session': 'no Salesforce session',
  'http-error': 'rejected by Salesforce',
  unknown: 'failed',
};

/**
 * The per-row failure report, as text.
 *
 * Text rather than DOM so it can be asserted exactly, and so the UI renders it
 * through the shared `errorPanel()` (whose `.sfdt-console` keeps newlines)
 * instead of hand-rolling a table. One line per failed row: the report's job is
 * to let the user re-run the delete against the rows that did not go, so every
 * Id has to be readable and copyable.
 *
 * The timeout paragraph is the important one. A timed-out write is the one
 * failure whose outcome is genuinely UNKNOWN — the worker never answered, so
 * the record may or may not be gone. Reporting it as "failed" and inviting a
 * blind retry is how a user ends up deleting something twice, or believing a
 * record survived when it did not.
 */
export function formatBulkDeleteReport(outcome: BulkDeleteOutcome): string {
  if (outcome.status !== 'done') return '';
  const { sobject, total, deleted, failures, canceled } = outcome;
  const lines: string[] = [];

  lines.push(`Deleted ${deleted} of ${total} ${sobject} record${total === 1 ? '' : 's'}.`);
  if (canceled) {
    lines.push(`Canceled before the remaining rows were attempted.`);
  }
  if (failures.length === 0) {
    return lines.join('\n');
  }

  const summary = summariseFailures(failures)
    .map(({ kind, count }) => `${count} ${KIND_LABELS[kind]}`)
    .join(', ');
  lines.push(`${failures.length} failed — ${summary}.`);
  lines.push('');
  for (const failure of failures) {
    lines.push(`${failure.id} — ${failure.message}`);
  }

  const uncertain = failures.filter((f) => f.kind === 'timeout').length;
  if (uncertain > 0) {
    lines.push('');
    lines.push(
      `${uncertain} row${uncertain === 1 ? '' : 's'} timed out. A timed-out delete may still ` +
        `have committed in Salesforce — re-run the query to see what is actually left before ` +
        `retrying.`,
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Registry feature
// ---------------------------------------------------------------------------

/**
 * Metadata-only registry feature — the kill-switch id and the options-page
 * toggle for every bulk delete the SOQL runner offers. It injects nothing: the
 * runner reads `isFeatureEnabled(settings, SOQL_BULK_DELETE_ID)` when it builds
 * a result toolbar, exactly the way entrypoints/background.ts gates
 * context-menu-inspect.
 *
 * WHY ITS OWN ID rather than a `soql-runner` sub-flag: a kill switch has to be
 * able to take the destructive half away without taking the tool away. A flag
 * under `featureSettings['soql-runner']` would be invisible to the remote kill
 * switch and to the options page's feature list, and disabling it would mean
 * disabling the query runner. It is also NOT folded into a single shared
 * `record-delete` switch covering P4-1's single-record delete: deleting the one
 * record you are looking at and deleting every row a query returned are
 * different sizes of mistake, and one checkbox would force a user who wants the
 * first to accept the second.
 *
 * `contexts` mirrors soql-runner's, because that is where a result toolbar can
 * appear. `permissions` is deliberately absent — a record DELETE goes through
 * the same worker-proxied `sfApiFetch` route every other write uses, so this
 * adds no manifest permission.
 */
export function createSoqlBulkDeleteFeature(): Feature {
  return {
    manifest: {
      id: SOQL_BULK_DELETE_ID,
      name: 'Bulk delete from SOQL results',
      contexts: [
        CONTEXTS.SETUP_FLOWS,
        CONTEXTS.SETUP_OTHER,
        CONTEXTS.FLOW_BUILDER,
        CONTEXTS.FLOW_TRIGGER_EXPLORER,
      ],
      // Ships OFF. The one feature in the extension that does.
      enabledByDefault: false,
    },
  };
}
