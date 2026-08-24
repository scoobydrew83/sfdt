// Object-wide field usage — "which of this object's fields has nothing pointing
// at it?"
//
// The sibling of field-impact.ts. That module answers a deep question about ONE
// field; this one answers a shallow question about ALL of them, which is the
// shape you actually want before a cleanup.
//
// ---------------------------------------------------------------------------
// Why this is batched, and what that buys
// ---------------------------------------------------------------------------
// The naive implementation asks `MetadataComponentDependency` once per field.
// On an object with 300 custom fields that is 300 round trips, which is slow
// enough that nobody runs it, and slow enough that the honest bounds get
// dropped to make it bearable. Instead the field ids are chunked into
// `RefMetadataComponentId IN (…)` batches, so 300 fields cost
// `ceil(300 / DEPENDENCY_CHUNK)` queries. The row cap per query still applies,
// so a chunk that comes back AT the cap is reported as truncated rather than
// read as a complete picture of those fields.
//
// ---------------------------------------------------------------------------
// The word this module will not use
// ---------------------------------------------------------------------------
// It never says a field is "unused". It says `unreferenced` — no reference was
// found by the sources scanned — and it carries the sources with it. Three
// separate things make "unused" a lie here:
//
//   1. `MetadataComponentDependency` is incomplete. Salesforce does not record
//      an edge for every reference, and the gaps are not documented.
//   2. A STANDARD field has no `CustomField` row, so there is no id for a
//      dependency edge to point at. Such a field is `scannable: false` and its
//      `unreferenced` is `null` — unknown, not clean. Reporting standard fields
//      as unreferenced would flag half of every object.
//   3. Metadata references say nothing about DATA. A field with no reference
//      can still hold millions of values.
//
// `safeToRemove` (below) is the only flag that means anything actionable, and it
// requires the caller to have measured (3) as well.

import { escapeSoql, groupByType, type DependencyGroup } from './dependencies.js';

/** Field ids per `IN (…)` batch. 200 × ~21 chars stays far inside SOQL length limits. */
export const DEPENDENCY_CHUNK = 200;
/** Custom fields resolved for one object. Beyond this the sweep reports truncation. */
export const FIELD_ID_CAP = 1000;
/** Rows one dependency batch may return before it is treated as truncated. */
export const DEPENDENCY_ROW_CAP = 2000;

/** What the caller's describe supplies about one field. */
export interface FieldUsageFieldInput {
  name: string;
  label?: string | null;
  type?: string | null;
  custom?: boolean;
  /** `nillable === false` on a describe — a required field cannot simply be dropped. */
  required?: boolean;
  unique?: boolean;
}

export interface FieldUsageRow {
  name: string;
  label: string;
  type: string;
  custom: boolean;
  required: boolean;
  unique: boolean;
  /**
   * Could this field be looked up at all? False for a standard field (no
   * `CustomField` row) and for a custom field whose id we could not resolve.
   */
  scannable: boolean;
  /** Components that reference the field, grouped by metadata type. */
  references: DependencyGroup[];
  referenceCount: number;
  /**
   * `true` — nothing referenced it in the sources scanned.
   * `false` — something did.
   * `null` — NOT SCANNED. Never conflate this with `true`.
   */
  unreferenced: boolean | null;
  /**
   * Set only once a caller supplies population data (see `applyPopulation`).
   * Until then it is `null`: metadata alone cannot answer it.
   */
  safeToRemove: boolean | null;
  /** Non-null when `safeToRemove` is false — why the field is not a candidate. */
  keepReason: string | null;
  /** Records with a non-null value, when measured. */
  populated: number | null;
  /** Total records in the object, when measured. */
  totalRecords: number | null;
}

export interface FieldUsageVM {
  object: string;
  rows: FieldUsageRow[];
  counts: {
    total: number;
    scanned: number;
    unreferenced: number;
    /** Fields that could not be scanned — reported separately, never as clean. */
    unknown: number;
    safeToRemove: number;
  };
  notes: string[];
}

export interface FieldUsageQueries {
  /** Tooling SOQL. Rejections MUST throw, never resolve empty. */
  toolingQuery<T>(soql: string): Promise<{ records: T[] }>;
}

/** Split a list into fixed-size chunks. Exported because the batching is the point. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) throw new Error('chunk size must be positive');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Every custom field on one object, with the id `MetadataComponentDependency` keys on. */
export function customFieldsForObjectQuery(object: string): string {
  return (
    `SELECT Id, DeveloperName FROM CustomField` +
    ` WHERE EntityDefinition.QualifiedApiName = '${escapeSoql(object)}'` +
    ` ORDER BY DeveloperName LIMIT ${FIELD_ID_CAP}`
  );
}

/**
 * One batch of "what references any of these fields".
 *
 * `RefMetadataComponentId` is selected so each row can be attributed back to the
 * field it belongs to — without it the batch would be a bag of references with
 * no way to say which field each one is for, which is the whole reason the naive
 * version queries one field at a time.
 */
export function dependencyBatchQuery(fieldIds: readonly string[]): string {
  const list = fieldIds.map((id) => `'${escapeSoql(id)}'`).join(',');
  return (
    `SELECT RefMetadataComponentId, MetadataComponentName, MetadataComponentType` +
    ` FROM MetadataComponentDependency WHERE RefMetadataComponentId IN (${list})` +
    ` ORDER BY MetadataComponentType, MetadataComponentName LIMIT ${DEPENDENCY_ROW_CAP}`
  );
}

/** `Region__c` → `Region`, the `CustomField.DeveloperName` form. */
export function developerName(fieldApiName: string): string {
  return fieldApiName.replace(/__c$/i, '');
}

function emptyRow(f: FieldUsageFieldInput): FieldUsageRow {
  return {
    name: f.name,
    label: (f.label ?? '').trim() || f.name,
    type: f.type ?? 'unknown',
    custom: f.custom ?? /__c$/i.test(f.name),
    required: f.required ?? false,
    unique: f.unique ?? false,
    scannable: false,
    references: [],
    referenceCount: 0,
    unreferenced: null,
    safeToRemove: null,
    keepReason: null,
    populated: null,
    totalRecords: null,
  };
}

/**
 * Sweep one object's fields for references.
 *
 * Never throws for an org-side failure: a refused batch becomes a note naming
 * how many fields it left unscanned, and those fields keep `unreferenced: null`.
 * A partial sweep with the gap stated beats an exception that loses the batches
 * that did succeed.
 */
export async function analyzeFieldUsage(
  q: FieldUsageQueries,
  { object, fields }: { object: string; fields: readonly FieldUsageFieldInput[] },
): Promise<FieldUsageVM> {
  const notes: string[] = [];
  const rows = fields.map(emptyRow);
  const byName = new Map(rows.map((r) => [r.name.toLowerCase(), r]));

  // ---- resolve custom field ids -------------------------------------------
  let idRows: Array<{ Id?: string; DeveloperName?: string }> = [];
  try {
    const result = await q.toolingQuery<{ Id?: string; DeveloperName?: string }>(
      customFieldsForObjectQuery(object),
    );
    idRows = result.records;
  } catch (err) {
    // Not "this object has no custom fields". Every field stays unknown.
    notes.push(
      `The CustomField lookup for ${object} was refused (${message(err)}), so NO field could be ` +
        `checked for references. Every field below is reported as unknown — this is a failed ` +
        `query, not a finding about your org.`,
    );
    return finish(object, rows, notes);
  }

  if (idRows.length >= FIELD_ID_CAP) {
    notes.push(
      `The custom-field list hit its cap (${FIELD_ID_CAP}); fields beyond it were not resolved ` +
        `and are reported as unknown rather than unreferenced.`,
    );
  }

  /** CustomField Id → the row it belongs to. */
  const rowById = new Map<string, FieldUsageRow>();
  for (const r of idRows) {
    if (!r.Id || !r.DeveloperName) continue;
    // Describe gives `Region__c`; CustomField gives `Region`. Match on both so a
    // field whose API name is not simply DeveloperName + `__c` (a managed
    // package's namespaced field) still lines up.
    const row =
      byName.get(`${r.DeveloperName}__c`.toLowerCase()) ?? byName.get(r.DeveloperName.toLowerCase());
    if (!row) continue;
    row.scannable = true;
    rowById.set(r.Id, row);
  }

  const standardUnscannable = rows.filter((r) => !r.scannable && !r.custom).length;
  if (standardUnscannable > 0) {
    notes.push(
      `${standardUnscannable} standard field(s) have no CustomField record, so there is no ` +
        `dependency edge to look up. They are reported as unknown, NOT as unreferenced — a ` +
        `dependency sweep cannot say anything about a standard field.`,
    );
  }
  const customUnscannable = rows.filter((r) => !r.scannable && r.custom).length;
  if (customUnscannable > 0) {
    notes.push(
      `${customUnscannable} custom field(s) could not be matched to a CustomField record and are ` +
        `reported as unknown.`,
    );
  }

  // ---- batched dependency sweep -------------------------------------------
  const ids = [...rowById.keys()];
  const batches = chunk(ids, DEPENDENCY_CHUNK);
  let failedBatches = 0;
  let unscannedByFailure = 0;

  for (const batch of batches) {
    let depRows: Array<{
      RefMetadataComponentId?: string;
      MetadataComponentName?: string;
      MetadataComponentType?: string;
    }> = [];
    try {
      const result = await q.toolingQuery<(typeof depRows)[number]>(dependencyBatchQuery(batch));
      depRows = result.records;
    } catch {
      failedBatches++;
      unscannedByFailure += batch.length;
      // Leave these rows `scannable: true, unreferenced: null` — we know they
      // COULD be scanned, we just did not manage it. Marking them unreferenced
      // is the bug this whole module is shaped to avoid.
      for (const id of batch) {
        const row = rowById.get(id);
        if (row) row.scannable = false;
      }
      continue;
    }

    if (depRows.length >= DEPENDENCY_ROW_CAP) {
      notes.push(
        `A dependency batch returned the maximum ${DEPENDENCY_ROW_CAP} rows, so references beyond ` +
          `it were not read. Fields in that batch may show fewer references than they have — and a ` +
          `field shown as unreferenced there may simply have been cut off.`,
      );
    }

    const grouped = new Map<string, Array<Record<string, unknown>>>();
    for (const row of depRows) {
      const key = row.RefMetadataComponentId;
      if (!key) continue;
      const list = grouped.get(key) ?? [];
      list.push(row as unknown as Record<string, unknown>);
      grouped.set(key, list);
    }
    for (const id of batch) {
      const row = rowById.get(id);
      if (!row) continue;
      const hits = grouped.get(id) ?? [];
      row.references = groupByType(hits, 'MetadataComponentName', 'MetadataComponentType');
      row.referenceCount = hits.length;
      row.unreferenced = hits.length === 0;
    }
  }

  if (failedBatches > 0) {
    notes.push(
      `${failedBatches} dependency batch(es) failed, leaving ${unscannedByFailure} field(s) ` +
        `unscanned. They are reported as unknown.`,
    );
  }

  if (ids.length > 0) {
    // Said on EVERY sweep that scanned anything, including a clean one —
    // especially a clean one, since that is when it would otherwise be read as
    // proof.
    notes.push(
      `References come from the Tooling API's MetadataComponentDependency, which does not record ` +
        `an edge for every kind of reference. "Unreferenced" here means no edge was found — it is ` +
        `not proof the field is unused. Run \`sfdt field impact <Object.Field>\` for a deeper scan ` +
        `of a specific field.`,
    );
  }

  return finish(object, rows, notes);
}

function finish(object: string, rows: FieldUsageRow[], notes: string[]): FieldUsageVM {
  rows.sort((a, b) => {
    // Unreferenced first — that is what the user came for — then unknown, then
    // referenced; alphabetical within each band.
    const rank = (r: FieldUsageRow) => (r.unreferenced === true ? 0 : r.unreferenced === null ? 1 : 2);
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  });
  return {
    object,
    rows,
    counts: {
      total: rows.length,
      scanned: rows.filter((r) => r.unreferenced !== null).length,
      unreferenced: rows.filter((r) => r.unreferenced === true).length,
      unknown: rows.filter((r) => r.unreferenced === null).length,
      safeToRemove: rows.filter((r) => r.safeToRemove === true).length,
    },
    notes,
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --------------------------------------------------------------------------
// Population — the half that makes "safe to remove" mean anything
// --------------------------------------------------------------------------
//
// A metadata sweep alone will call a field with no dependency edge "unused"
// while it holds two million values. That is the failure mode of every
// reference-only field-usage tool, and it is the specific thing this module
// refuses to do: `safeToRemove` stays `null` until a caller has actually
// counted the data.
//
// Counting is opt-in because it is one `COUNT()` per field — cheap per query,
// but N queries. The caller decides; this function only adjudicates.

/** A measured non-null count for one field. `null` means the count failed. */
export interface FieldPopulation {
  field: string;
  populated: number | null;
}

/**
 * Fold population counts into a swept viewmodel and decide `safeToRemove`.
 *
 * A field is a removal candidate only when ALL of these hold:
 *
 *   - it is custom (a standard field is not yours to remove);
 *   - it was actually scanned, and nothing referenced it;
 *   - its population was actually measured, and is zero;
 *   - it is not required or unique — those carry behaviour beyond their values,
 *     and a required field cannot be dropped without a schema change anyway.
 *
 * Every rejection records `keepReason`, so the answer explains itself instead of
 * leaving the user to guess why a field they expected is missing from the list.
 */
export function applyPopulation(
  vm: FieldUsageVM,
  populations: readonly FieldPopulation[],
  { totalRecords = null }: { totalRecords?: number | null } = {},
): FieldUsageVM {
  const byName = new Map(populations.map((p) => [p.field.toLowerCase(), p.populated]));

  for (const row of vm.rows) {
    row.totalRecords = totalRecords;
    if (byName.has(row.name.toLowerCase())) {
      row.populated = byName.get(row.name.toLowerCase()) ?? null;
    }

    if (!row.custom) {
      row.safeToRemove = false;
      row.keepReason = 'standard field';
      continue;
    }
    if (row.unreferenced === null) {
      row.safeToRemove = false;
      row.keepReason = 'not scanned — reference status unknown';
      continue;
    }
    if (row.unreferenced === false) {
      row.safeToRemove = false;
      row.keepReason = `referenced by ${row.referenceCount} component(s)`;
      continue;
    }
    if (row.populated === null) {
      // Unreferenced but uncounted is NOT a candidate. This is the exact case a
      // metadata-only tool gets wrong.
      row.safeToRemove = false;
      row.keepReason = 'population not measured';
      continue;
    }
    if (row.populated > 0) {
      row.safeToRemove = false;
      row.keepReason = `holds ${row.populated} value(s)`;
      continue;
    }
    if (row.required) {
      row.safeToRemove = false;
      row.keepReason = 'required';
      continue;
    }
    if (row.unique) {
      row.safeToRemove = false;
      row.keepReason = 'unique — may back an external key';
      continue;
    }
    row.safeToRemove = true;
    row.keepReason = null;
  }

  vm.counts.safeToRemove = vm.rows.filter((r) => r.safeToRemove === true).length;
  return vm;
}
