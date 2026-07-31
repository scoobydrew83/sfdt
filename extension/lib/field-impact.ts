// Field Impact Analysis (P4-4) — "What writes this field?".
//
// PURE viewmodel: it takes org data the feature already fetched and turns it
// into a labelled row list. No DOM, no chrome.*, no network — every org call
// lives in features/field-impact.ts and goes through the worker-proxied API.
//
// The Flow half is NOT parsed here. `@sfdt/flow-core`'s `extractFieldWrites` is
// the single Flow engine (shared with the CLI/GUI); this module only decides how
// its output is presented.
//
// ---------------------------------------------------------------------------
// Inferred vs confirmed
// ---------------------------------------------------------------------------
// Same vocabulary as the dependency `--gaps` report (`src/lib/source-dependencies.js`,
// `GET /api/dependencies/gaps`, the GUI Gaps panel and its "— confirmed ┄ inferred"
// legend):
//
//   confirmed — the metadata itself states the write. A Flow assignment or
//               inputAssignment parsed out of `Flow.Metadata`; a workflow field
//               update whose `Metadata.field` names this field.
//   inferred  — our best effort found a signal, but nothing states the write.
//               Apex is a Tooling TEXT search (a hit may read the field, mention
//               it in a comment, or share a name); a Flow whose metadata we did
//               not analyse; a Flow write whose object could not be bound.
//
// An inferred row is NEVER presented as confirmed. Rows keep their own status,
// the counts are reported separately, and the renderer badges each row.

import {
  extractFieldWrites,
  filterFieldWrites,
  FIELD_WRITE_KIND_LABELS,
  type FlowFieldWrite,
} from '@sfdt/flow-core';

export type FieldImpactStatus = 'confirmed' | 'inferred';

export type FieldImpactSourceType = 'Flow' | 'WorkflowFieldUpdate' | 'ApexTrigger' | 'ApexClass';

/** Display label + ordering weight per source type. */
const SOURCE_TYPES: Record<FieldImpactSourceType, { label: string; order: number }> = {
  Flow: { label: 'Flow', order: 0 },
  WorkflowFieldUpdate: { label: 'Workflow Field Update', order: 1 },
  ApexTrigger: { label: 'Apex Trigger', order: 2 },
  ApexClass: { label: 'Apex Class', order: 3 },
};

/** Human sentence explaining each status — rendered verbatim in the legend. */
export const STATUS_LEGEND: Record<FieldImpactStatus, string> = {
  confirmed: 'the metadata states this write',
  inferred: 'a best-effort signal — not proof of a write',
};

export interface FlowCandidate {
  /** Tooling `Flow.Id` (the version) — what Flow Builder opens. */
  versionId: string;
  /** Flow API name (`Definition.DeveloperName`). */
  apiName: string;
  /** Display label (`MasterLabel`); falls back to the API name. */
  label?: string | null;
  /** Active / Obsolete / Draft — shown so an obsolete hit is obvious. */
  status?: string | null;
  /**
   * Tooling `Flow.Metadata`. `null` means the flow was NOT analysed — over the
   * scan cap, the metadata fetch threw, or the row came back with no `Metadata`.
   * Such a flow can never be a `confirmed` row; whether it is an `inferred` row
   * or no row at all depends on `discovery` (see below).
   */
  metadata: Parameters<typeof extractFieldWrites>[0];
  /**
   * HOW this candidate was found, which decides how much benefit of the doubt a
   * write gets:
   *
   * - `dependency` (default) — `MetadataComponentDependency` says this flow
   *   references the field. A write we cannot bind to an object is still a real
   *   lead, so it is kept and labelled `inferred`; so is a flow whose metadata
   *   could not be read, because the reference itself is established.
   * - `broad-scan` — the flow came from an untargeted sweep (no dependency edge
   *   exists, e.g. for a standard field). There is NO evidence this flow touches
   *   the field at all, so an unbindable write would be a pure NAME collision:
   *   a flow assigning `Status` into an untyped wrapper would be reported as
   *   writing your object's `Status`. Those writes are dropped, not downgraded —
   *   only writes bound to the queried object in the flow's own metadata count.
   *   For the same reason a flow whose metadata could not be read produces NO
   *   row: with neither an edge nor metadata there is nothing to report, and a
   *   row would assert a reference that was never established. Both drops are
   *   disclosed as scope notes by the feature, never silent.
   */
  discovery?: 'dependency' | 'broad-scan';
}

export interface WorkflowFieldUpdateCandidate {
  id: string;
  /** Developer name. */
  name: string;
  label?: string | null;
  /** Target object, taken from the `Object.UpdateName` prefix of `FullName`. */
  object?: string | null;
  /** Target field from its `Metadata.field`; `null` when unread. */
  field: string | null;
  /** Metadata could not be read for this update (skipped or failed). */
  unresolved?: boolean;
}

export interface ApexSearchHit {
  id: string;
  name: string;
  type: 'ApexClass' | 'ApexTrigger';
}

export interface FieldImpactInput {
  object: string;
  field: string;
  /** Lightning origin used to build open links, e.g. `https://acme.lightning.force.com`. */
  origin: string;
  flows?: readonly FlowCandidate[];
  workflowFieldUpdates?: readonly WorkflowFieldUpdateCandidate[];
  apexHits?: readonly ApexSearchHit[];
  /** Scope caveats to surface as a notice (what was not scanned, and why). */
  notes?: readonly string[];
}

export interface FieldImpactRow {
  sourceType: FieldImpactSourceType;
  /** Display label for the source type ("Flow", "Apex Class", …). */
  typeLabel: string;
  /** API name of the component. */
  name: string;
  /** Display label (falls back to the API name). */
  label: string;
  status: FieldImpactStatus;
  /** Why the row is here — the evidence, or what the inference rests on. */
  detail: string;
  /** Open link, or `null` when one cannot be built. */
  url: string | null;
}

export interface FieldImpactVM {
  object: string;
  field: string;
  rows: FieldImpactRow[];
  counts: { confirmed: number; inferred: number; total: number };
  notes: string[];
}

function trimOrigin(origin: string): string {
  return origin.replace(/\/+$/, '');
}

/** Flow Builder URL for a flow VERSION id (same shape flow-trigger-explorer uses). */
export function flowBuilderUrl(origin: string, versionId: string): string | null {
  if (!versionId) return null;
  return `${trimOrigin(origin)}/builder_platform_interaction/flowBuilder.app?flowId=${encodeURIComponent(versionId)}`;
}

/** Setup deep link for a component id under a Setup node (`address=/<id>`). */
export function setupRecordUrl(origin: string, node: string, id: string): string | null {
  if (!id) return null;
  return `${trimOrigin(origin)}/lightning/setup/${node}/page?address=${encodeURIComponent(`/${id}`)}`;
}

const eq = (a: string | null | undefined, b: string | null | undefined): boolean =>
  (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();

/** Summarise one flow's matching writes into a single row detail string. */
function describeFlowWrites(writes: readonly FlowFieldWrite[]): string {
  return writes
    .map((w) => {
      const kind = FIELD_WRITE_KIND_LABELS[w.kind];
      const where = w.elementLabel || w.elementName || '(unnamed element)';
      const scope = w.object ? '' : ' (object could not be bound)';
      return `${kind} "${where}"${scope}`;
    })
    .join(', ');
}

function flowRow(
  candidate: FlowCandidate,
  input: FieldImpactInput,
): FieldImpactRow | null {
  const label = (candidate.label ?? '').trim() || candidate.apiName;
  const url = flowBuilderUrl(input.origin, candidate.versionId);
  const statusSuffix = candidate.status ? ` · ${candidate.status}` : '';

  // Not analysed. What that is worth depends ENTIRELY on how the candidate was
  // found, because the evidence string below asserts a reference:
  //
  // - `dependency` — the flow is in the set precisely BECAUSE an edge links it
  //   to this field. "References this field" is established, the metadata just
  //   wasn't readable, so an `inferred` lead is honest.
  // - `broad-scan` — the flow is in the set only for being recently modified.
  //   Nothing links it to the field. With no metadata there is no evidence of
  //   anything, so a row here would assert a relationship that was never
  //   established, contradict the note promising that a broad-scan flow is
  //   reported only when its metadata binds the write, and inflate the count so
  //   the empty-result hedge never fires. Dropped instead — the same call the
  //   unbindable-write rule already makes on this path. The feature counts these
  //   and discloses them as a scope note, so the drop is never silent.
  if (candidate.metadata == null) {
    if (candidate.discovery === 'broad-scan') return null;
    return {
      sourceType: 'Flow',
      typeLabel: SOURCE_TYPES.Flow.label,
      name: candidate.apiName,
      label,
      status: 'inferred',
      detail: `References this field, but its metadata was not analysed${statusSuffix}`,
      url,
    };
  }

  // A broad-scan candidate has no evidence it touches this field, so an
  // unbindable write there is a name collision, not a lead. flow-core drops
  // those under `requireResolvedObject`; the dependency-narrowed path keeps its
  // lenient behaviour, where an unbindable write IS a real lead.
  const broadScan = candidate.discovery === 'broad-scan';
  const matches = filterFieldWrites(extractFieldWrites(candidate.metadata), {
    field: input.field,
    object: input.object,
    requireResolvedObject: broadScan,
  });
  // Analysed and writes nothing → it only READS the field (or, on a broad scan,
  // merely shares a field name). Not a row: this is exactly what flow-core buys
  // us over a raw dependency query.
  if (matches.length === 0) return null;

  const confirmed = matches.some((w) => w.status === 'confirmed');
  return {
    sourceType: 'Flow',
    typeLabel: SOURCE_TYPES.Flow.label,
    name: candidate.apiName,
    label,
    status: confirmed ? 'confirmed' : 'inferred',
    detail: `${describeFlowWrites(matches)}${statusSuffix}`,
    url,
  };
}

function workflowRow(
  candidate: WorkflowFieldUpdateCandidate,
  input: FieldImpactInput,
): FieldImpactRow | null {
  if (candidate.object && !eq(candidate.object, input.object)) return null;
  const label = (candidate.label ?? '').trim() || candidate.name;
  const url = setupRecordUrl(input.origin, 'WorkflowFieldUpdates', candidate.id);

  if (candidate.field && eq(candidate.field, input.field)) {
    return {
      sourceType: 'WorkflowFieldUpdate',
      typeLabel: SOURCE_TYPES.WorkflowFieldUpdate.label,
      name: candidate.name,
      label,
      status: 'confirmed',
      detail: `Field update targets ${input.object}.${input.field}`,
      url,
    };
  }
  if (candidate.unresolved) {
    return {
      sourceType: 'WorkflowFieldUpdate',
      typeLabel: SOURCE_TYPES.WorkflowFieldUpdate.label,
      name: candidate.name,
      label,
      status: 'inferred',
      detail: `Field update on ${input.object} whose target field could not be read`,
      url,
    };
  }
  return null;
}

function apexRow(hit: ApexSearchHit, input: FieldImpactInput): FieldImpactRow {
  const node = hit.type === 'ApexTrigger' ? 'ApexTriggers' : 'ApexClasses';
  return {
    sourceType: hit.type,
    typeLabel: SOURCE_TYPES[hit.type].label,
    name: hit.name,
    label: hit.name,
    // ALWAYS inferred: a Tooling text search cannot distinguish a write from a
    // read, a comment, or an unrelated identifier that happens to match.
    status: 'inferred',
    detail: `Tooling text search matched "${input.field}" in the source — may read it, not write it`,
    url: setupRecordUrl(input.origin, node, hit.id),
  };
}

// Confirmed before inferred, then by source type, then by name.
function compareRows(a: FieldImpactRow, b: FieldImpactRow): number {
  if (a.status !== b.status) return a.status === 'confirmed' ? -1 : 1;
  const order = SOURCE_TYPES[a.sourceType].order - SOURCE_TYPES[b.sourceType].order;
  if (order !== 0) return order;
  return a.label.localeCompare(b.label) || a.name.localeCompare(b.name);
}

/**
 * Build the "what writes this field" viewmodel from already-fetched org data.
 * Deterministic and side-effect free — the feature's tests drive it directly.
 */
export function buildFieldImpactVM(input: FieldImpactInput): FieldImpactVM {
  const rows: FieldImpactRow[] = [];

  for (const flow of input.flows ?? []) {
    const row = flowRow(flow, input);
    if (row) rows.push(row);
  }
  for (const update of input.workflowFieldUpdates ?? []) {
    const row = workflowRow(update, input);
    if (row) rows.push(row);
  }
  for (const hit of input.apexHits ?? []) {
    rows.push(apexRow(hit, input));
  }

  rows.sort(compareRows);
  const confirmed = rows.filter((r) => r.status === 'confirmed').length;

  return {
    object: input.object,
    field: input.field,
    rows,
    counts: { confirmed, inferred: rows.length - confirmed, total: rows.length },
    notes: [...(input.notes ?? [])],
  };
}
