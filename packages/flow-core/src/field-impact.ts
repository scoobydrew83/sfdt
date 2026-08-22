// Field Impact Analysis (P4-4) — "What writes this field?".
//
// PURE viewmodel: it takes org data a caller already fetched and turns it into a
// labelled row list. No DOM, no chrome.*, no network, no `sf` — fetching is the
// caller's job, so the browser (worker-proxied API) and the CLI (`sf data query
// --use-tooling-api`) reach identical conclusions from identical inputs.
//
// The Flow half is NOT parsed here. `field-writes.ts` is the single Flow engine
// (shared by the CLI, the GUI and the extension); this module only decides how
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
} from './field-writes.js';
import { escapeSoql } from './dependencies.js';

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

/**
 * Flow Builder URL for a flow VERSION id (same shape flow-trigger-explorer uses).
 *
 * An empty `origin` yields null rather than a root-relative path: a headless
 * caller (the CLI, an MCP tool) may not know the org's host, and `/builder_…`
 * printed in a terminal is a broken link wearing the shape of a real one.
 */
export function flowBuilderUrl(origin: string, versionId: string): string | null {
  if (!origin || !versionId) return null;
  return `${trimOrigin(origin)}/builder_platform_interaction/flowBuilder.app?flowId=${encodeURIComponent(versionId)}`;
}

/** Setup deep link for a component id under a Setup node (`address=/<id>`). Empty origin ⇒ null. */
export function setupRecordUrl(origin: string, node: string, id: string): string | null {
  if (!origin || !id) return null;
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

// --------------------------------------------------------------------------
// Scan bounds
// --------------------------------------------------------------------------
//
// Every one of these costs org round-trips, and an unbounded sweep of a big org
// would hang whichever surface is driving. They live here, beside the query
// builders that embed them, so the browser and the CLI scan to the SAME depth —
// a field reported clean by one and dirty by the other would be worse than
// either answer alone. Whatever a cap excludes is reported as a scope note,
// never silently dropped.

/** Flows narrowed by a dependency edge before any metadata is read. */
export const FLOW_CANDIDATE_CAP = 50;
/** Flows whose `Metadata` we fetch — Tooling returns Metadata one row at a time. */
export const FLOW_ANALYSE_CAP = 15;
/** Field updates listed in one query (Id + Name only — the cheap projection). */
export const WORKFLOW_LIST_CAP = 200;
/** Field updates whose `FullName`/`Metadata` we fetch — one row per query. */
export const WORKFLOW_METADATA_CAP = 50;
/** Concurrent per-row detail fetches. */
export const WORKFLOW_DETAIL_CONCURRENCY = 5;
/** Apex text-search hits kept, per returned sObject type and in total. */
export const APEX_HIT_CAP = 25;

// --------------------------------------------------------------------------
// Pure Tooling query builders
// --------------------------------------------------------------------------

/** Tooling SOQL resolving a CUSTOM field to its CustomField Id. */
export function customFieldIdQuery(object: string, field: string): string {
  const developerName = field.replace(/__c$/i, '');
  return (
    `SELECT Id FROM CustomField WHERE DeveloperName = '${escapeSoql(developerName)}'` +
    ` AND EntityDefinition.QualifiedApiName = '${escapeSoql(object)}' LIMIT 1`
  );
}

/** Flows that reference a component id at all (the candidate narrowing step). */
export function flowCandidateQuery(fieldId: string): string {
  return (
    `SELECT MetadataComponentId, MetadataComponentName FROM MetadataComponentDependency` +
    ` WHERE RefMetadataComponentId = '${escapeSoql(fieldId)}' AND MetadataComponentType = 'Flow'` +
    ` ORDER BY MetadataComponentName LIMIT ${FLOW_CANDIDATE_CAP}`
  );
}

/**
 * Fallback candidate set when no dependency edge exists (standard fields).
 *
 * Enumerated through `FlowDefinition.ActiveVersionId`, not `Flow WHERE Status =
 * 'Active'`. The two are not equivalent in practice: the `Flow` filter came back
 * empty against orgs that plainly have active flows, and the panel reported a
 * scan of "0 active flow(s)" as if that were a finding. `FlowDefinition` is the
 * enumeration every other flow feature here already uses (trigger-conflicts,
 * subflow-graph, scheduled-flow-explorer, the CLI's flow-analyzer), and it names
 * the active version id outright rather than inferring it from a status value.
 */
export function recentActiveFlowsQuery(): string {
  return (
    `SELECT Id, DeveloperName, ActiveVersionId FROM FlowDefinition WHERE ActiveVersionId != null` +
    ` ORDER BY LastModifiedDate DESC LIMIT ${FLOW_ANALYSE_CAP}`
  );
}

export function flowMetadataQuery(versionId: string): string {
  return (
    `SELECT Id, MasterLabel, Status, Definition.DeveloperName, Metadata FROM Flow` +
    ` WHERE Id = '${escapeSoql(versionId)}' LIMIT 1`
  );
}

/**
 * List every workflow field update — Id and Name only.
 *
 * The object filter CANNOT be pushed into this query. `TableEnumOrId` is a
 * column on `WorkflowRule`, not on `WorkflowFieldUpdate`; asking for it made
 * Salesforce reject the request outright ("No such column 'TableEnumOrId' on
 * entity 'WorkflowFieldUpdate'"), and because the previous per-row fallback
 * built its SOQL from the same builder it failed for the identical reason — so
 * workflow field updates were never covered on any org, while the panel claimed
 * it had read them individually.
 *
 * The target object lives in `FullName` (`Object.UpdateName`), and Tooling only
 * serves `FullName`/`Metadata` under a single-record filter. So the object is
 * resolved per row and matched client-side (`workflowRow` drops the rest).
 *
 * ponytail: org-wide list capped at WORKFLOW_LIST_CAP with an arbitrary (name)
 * ordering — on an org with more legacy field updates than the cap, which ones
 * get read is not relevance-driven. Both bounds are disclosed as scope notes. If
 * that truncation starts mattering, narrow first through
 * `WorkflowRule WHERE TableEnumOrId = '<object>'` and walk each rule's
 * `Metadata.actions[]` instead of listing the org.
 */
export function workflowFieldUpdateListQuery(): string {
  return `SELECT Id, Name FROM WorkflowFieldUpdate ORDER BY Name LIMIT ${WORKFLOW_LIST_CAP}`;
}

/** One field update's `FullName` (target object) and `Metadata` (target field). */
export function workflowFieldUpdateDetailQuery(id: string): string {
  return (
    `SELECT Id, FullName, Metadata FROM WorkflowFieldUpdate` +
    ` WHERE Id = '${escapeSoql(id)}' LIMIT 1`
  );
}

/** `Account.Set_Industry` → `Account`; anything without a prefix is unbindable. */
export function objectFromFullName(fullName: string | null | undefined): string | null {
  const dot = (fullName ?? '').indexOf('.');
  return dot > 0 ? fullName!.slice(0, dot) : null;
}

/**
 * SOSL for the Apex text search. Field API names are `[A-Za-z0-9_]` only, so an
 * unexpected character means we refuse to build a search rather than emit a
 * term with SOSL syntax in it.
 *
 * The cap is applied THREE ways on purpose, because a statement-trailing SOSL
 * `LIMIT` is not a reliable total: a per-object `LIMIT` inside each `RETURNING`
 * clause, the trailing `LIMIT`, and — the one that actually binds — a hard
 * client-side truncation by the caller. Relying on the trailing clause alone let
 * two returned sObject types yield `2 × APEX_HIT_CAP` rows while the constant
 * claimed one.
 */
export function apexSearchSosl(field: string): string | null {
  if (!/^[A-Za-z0-9_]+$/.test(field)) return null;
  return (
    `FIND {${field}} IN ALL FIELDS RETURNING ` +
    `ApexClass(Id, Name LIMIT ${APEX_HIT_CAP}), ApexTrigger(Id, Name LIMIT ${APEX_HIT_CAP})` +
    ` LIMIT ${APEX_HIT_CAP}`
  );
}

// --------------------------------------------------------------------------
// Orchestration
// --------------------------------------------------------------------------
//
// The scan itself — which queries run, in what order, what each failure means,
// and above all WHICH SCOPE NOTES the result carries.
//
// This lives here rather than in whichever surface is driving because the notes
// ARE the product. A second implementation would not merely duplicate query
// strings; it would re-adjudicate "refused" versus "not found", re-decide when a
// broad scan may assert a reference, and re-word the caveats — and two surfaces
// that hedge differently about the same org are worse than one surface that
// hedges badly, because a user has no way to tell which of them to believe.
//
// Everything I/O-shaped is injected through `FieldImpactQueries`, so the browser
// (worker-proxied Tooling API) and the CLI (`sf data query --use-tooling-api`)
// supply transport and nothing else.

/**
 * The org access this scan needs. Two calls, both read-only.
 *
 * Implementations must let a REFUSAL throw. Returning an empty result for a
 * rejected query would tell this module "your org has none of these", which is
 * the one lie the whole confirmed/inferred vocabulary exists to prevent.
 */
export interface FieldImpactQueries {
  /** Tooling SOQL. Rejections MUST throw, never resolve empty. */
  toolingQuery<T>(soql: string): Promise<{ records: T[] }>;
  /** Tooling SOSL. Rejections MUST throw, never resolve empty. */
  toolingSearch(
    sosl: string,
  ): Promise<Array<{ Id?: string; Name?: string; attributes?: { type?: string } }>>;
}

export interface FieldImpactRequest {
  object: string;
  field: string;
  /**
   * Base URL for Setup / Flow Builder deep links, e.g.
   * `https://acme.lightning.force.com`. Omit it and rows come back with
   * `url: null` — correct for a headless caller that has no host to link to.
   */
  origin?: string;
}

/**
 * Run the full "what writes this field?" scan and return the viewmodel.
 *
 * Never throws for an org-side failure: each scan converts its own errors into
 * scope notes, so a partial answer is returned WITH the gap stated rather than
 * an exception that loses the parts that did work.
 */
export async function analyzeFieldImpact(
  q: FieldImpactQueries,
  { object, field, origin = '' }: FieldImpactRequest,
): Promise<FieldImpactVM> {
  
  /**
   * Resolve a CUSTOM field to its `CustomField` Id — the key the dependency
   * query needs.
   *
   * A refusal is NOT "not found". Swallowing it would make a permissions or
   * licence failure indistinguishable from an org that genuinely has no
   * dependency edge, and that difference is load-bearing twice over: it decides
   * what the Scan-scope panel asserts about the org, AND it silently switches
   * flow adjudication to the strict rule. So the error is returned, not eaten.
   */
  async function resolveCustomFieldId(
    object: string,
    field: string,
  ): Promise<{ id: string | null; error: string | null }> {
    if (!/__c$/i.test(field)) return { id: null, error: null }; // no CustomField row exists
    try {
      const result = await q.toolingQuery<{ Id?: string }>(customFieldIdQuery(object, field));
      return { id: result.records[0]?.Id ?? null, error: null };
    } catch (err) {
      return { id: null, error: message(err) };
    }
  }

  interface FlowFetch {
    candidates: FlowCandidate[];
    notes: string[];
  }

  async function fetchFlowCandidates(object: string, field: string): Promise<FlowFetch> {
    const notes: string[] = [];
    const { id: fieldId, error: fieldIdError } = await resolveCustomFieldId(object, field);
    let versionIds: string[] = [];
    // Provenance decides how much benefit of the doubt each candidate's writes
    // get downstream (see FlowCandidate.discovery in lib/field-impact.ts).
    let discovery: FlowCandidate['discovery'] = 'dependency';
    // Did we actually establish that no dependency edge exists, or were we just
    // unable to look? The fallback note must not assert the former for the
    // latter — a refused query is not evidence about the user's org.
    let edgeLookupFailed = false;

    if (fieldIdError) {
      edgeLookupFailed = true;
      notes.push(
        `The CustomField lookup for ${object}.${field} was refused (${fieldIdError}), so its ` +
          `dependency edges could NOT be checked. Whether flows are linked to this field is ` +
          `unknown here — this is a failed query, not a finding about your org.`,
      );
    }

    if (fieldId) {
      try {
        const deps = await q.toolingQuery<{ MetadataComponentId?: string }>(
          flowCandidateQuery(fieldId),
        );
        versionIds = deps.records
          .map((r) => r.MetadataComponentId)
          .filter((id): id is string => typeof id === 'string' && id.length > 0);
      } catch (err) {
        edgeLookupFailed = true;
        notes.push(
          `Flow candidates could not be narrowed via MetadataComponentDependency (${message(err)}).`,
        );
      }
      if (versionIds.length > 0) {
        // Symmetry with the broad-scan precision note below. The two paths
        // adjudicate differently, so BOTH must say which rule they applied —
        // otherwise the user cannot tell that two answers aren't comparable.
        notes.push(
          `${versionIds.length} flow(s) are linked to ${object}.${field} by a dependency edge, so ` +
            `writes in them that cannot be bound to an object are listed as inferred leads rather ` +
            `than dropped. A field with no such edge is scanned under a stricter rule, and results ` +
            `from the two are not directly comparable.`,
        );
      }
    }

    if (!fieldId || versionIds.length === 0) {
      // No dependency edge (a standard field has no CustomField row; some orgs
      // record none; or the lookup above was refused) — fall back to a broad
      // sweep of the most recently modified ACTIVE flows. Because nothing ties
      // these flows to the field, they are adjudicated STRICTLY: only a write
      // bound to `object` in the flow's own metadata counts. Both the breadth
      // AND that precision rule are disclosed.
      discovery = 'broad-scan';
      // Say which of the four reasons actually applies. Only the last is a
      // MEASUREMENT — the dependency query ran and came back empty. The others
      // are a failure or a derivation (for a standard field the CustomField
      // query is short-circuited and never runs at all), and reporting them as
      // "no dependency edge" states more than the evidence supports.
      const cause = edgeLookupFailed
        ? `Because the lookup above failed, the scan for ${object}.${field} could not be narrowed`
        : !/__c$/i.test(field)
          ? `${object}.${field} is a standard field, so it has no CustomField record for a ` +
            `dependency edge to point at`
          : !fieldId
            ? `No CustomField record was found for ${object}.${field}, so no dependency edge ` +
              `could be looked up`
            : `No dependency edge was found for ${object}.${field}`;
      try {
        const flows = await q.toolingQuery<{ ActiveVersionId?: string }>(recentActiveFlowsQuery());
        versionIds = flows.records
          .map((r) => r.ActiveVersionId)
          .filter((id): id is string => typeof id === 'string' && id.length > 0);
        // An empty result is not "a scan that found nothing" — nothing was
        // scanned. Reported as its own sentence, because "a broad scan of the 0
        // most recently modified active flow(s)" reads like a cap bug and buries
        // the fact that Flow coverage here is ZERO.
        notes.push(
          versionIds.length === 0
            ? `${cause}, so Flow coverage fell back to a broad scan — but that query returned no ` +
                `active flow versions, so NO flow was examined. Flow coverage here is empty: this ` +
                `says nothing about whether a flow writes ${object}.${field}.`
            : `${cause}, so Flow coverage is a broad scan of the ` +
                `${versionIds.length} most recently modified active flow(s) — not every flow in the org.`,
        );
        if (versionIds.length > 0) {
          notes.push(
            `On that broad scan a flow is only reported when its metadata binds the write to ` +
              `${object} itself. A write into an untyped or Apex-defined variable is SKIPPED rather ` +
              `than guessed at, because matching on the field name alone would attribute any flow ` +
              `writing some other object's "${field}" to this one. Flows that do write ${object}.${field} ` +
              `through such an unbindable reference are therefore missing from these results.`,
          );
        }
      } catch (err) {
        notes.push(`Flows could not be listed (${message(err)}).`);
      }
    }

    const analysed = versionIds.slice(0, FLOW_ANALYSE_CAP);
    const skipped = versionIds.slice(FLOW_ANALYSE_CAP);
    if (skipped.length > 0) {
      notes.push(
        `${skipped.length} further candidate flow(s) reference this field but were not analysed ` +
          `(cap ${FLOW_ANALYSE_CAP}); they are listed as inferred.`,
      );
    }

    const candidates: FlowCandidate[] = [];
    /** Analysed candidates that came back with no usable `Metadata`. */
    let unreadable = 0;
    for (const versionId of analysed) {
      try {
        const result = await q.toolingQuery<{
          Id?: string;
          MasterLabel?: string;
          Status?: string;
          Definition?: { DeveloperName?: string };
          Metadata?: unknown;
        }>(flowMetadataQuery(versionId));
        const record = result.records[0];
        // A query can SUCCEED and still leave nothing to analyse, two ways: the
        // row comes back without `Metadata` (some orgs refuse the projection per
        // row rather than failing the request), or no row comes back at all (the
        // version was deleted between the candidate query and this one, or a
        // dependency edge is dangling). Downstream they are the same thing — a
        // candidate we could not analyse — so they are counted and pushed
        // together. `continue`-ing the no-row case instead would drop it without
        // counting it, leaving the note describing a candidate the result set
        // does not contain: on the dependency path the note would promise it was
        // "listed as an inferred lead rather than dropped" when it was dropped.
        // A drop the user cannot see is the failure this panel exists to avoid.
        if (record?.Metadata == null) unreadable++;
        candidates.push({
          versionId,
          apiName: record?.Definition?.DeveloperName ?? record?.MasterLabel ?? versionId,
          label: record?.MasterLabel ?? null,
          status: record?.Status ?? null,
          metadata: (record?.Metadata ?? null) as FlowCandidate['metadata'],
          discovery,
        });
      } catch {
        unreadable++;
        candidates.push({
          versionId,
          apiName: versionId,
          label: null,
          status: null,
          metadata: null,
          discovery,
        });
      }
    }
    // An ANALYSED candidate can still end up with no metadata — the fetch threw,
    // or the row came back without `Metadata`. That is a different case from the
    // cap overflow below, and it is the one that decides whether a row may
    // assert "references this field":
    //
    // - `dependency` — the edge already established the reference, so the row is
    //   an honest `inferred` lead and needs no note beyond its own evidence.
    // - `broad-scan` — nothing links the flow to the field, so `flowRow` drops
    //   it rather than assert a reference we never had. Disclosed here, because
    //   a drop the user cannot see is exactly the failure this panel exists to
    //   avoid (and because, unlike a row, a drop leaves no evidence of itself).
    if (unreadable > 0) {
      notes.push(
        discovery === 'broad-scan'
          ? `${unreadable} flow(s) in the scanned set could not be read (their metadata was ` +
              `unavailable) and are NOT listed. Nothing linked them to ${object}.${field} in the ` +
              `first place, so there is no reference to report — but any of them could write it.`
          : `${unreadable} flow(s) linked to ${object}.${field} could not be read (their metadata ` +
              `was unavailable); each is listed as an inferred lead rather than dropped.`,
      );
    }
    // Distinct from the above: these were never fetched at all. Only the
    // dependency path can overflow the cap (the broad scan queries at most
    // FLOW_ANALYSE_CAP rows), so a cap-skipped candidate always carries a real
    // dependency edge and is honestly an `inferred` lead.
    for (const versionId of skipped) {
      candidates.push({
        versionId,
        apiName: versionId,
        label: null,
        status: null,
        metadata: null,
        discovery,
      });
    }
    // The parser's OWN bound, distinct from either scan's bound. flow-core
    // models Create/Update Records inputAssignments and `<record>.<Field>`
    // Assignments; a flow writing the field only through a construct it does
    // not model produces no writes at all, so it is dropped with no row and no
    // other note — on BOTH the dependency and broad-scan paths. Stated whenever
    // any flow was actually parsed, so the Scan-scope panel is not read as an
    // exhaustive account of the gaps when it is missing this class entirely.
    if (candidates.some((c) => c.metadata != null)) {
      notes.push(
        `Flow analysis covers Create/Update Records field assignments and ` +
          `\`<record>.${field}\`-style Assignment elements. Transform elements, invocable and quick ` +
          `actions, and the bodies of called subflows are NOT parsed, so a flow that writes ` +
          `${object}.${field} only through one of those is missing from these results.`,
      );
    }
    return { candidates, notes };
  }

  interface WorkflowFetch {
    candidates: WorkflowFieldUpdateCandidate[];
    notes: string[];
  }

  /**
   * A field update whose `Metadata` came back unreadable becomes an `inferred`
   * row against WHATEVER field the user asked about — pure noise unless its
   * cause is stated. Neither path may return it silently.
   */
  function noteUnreadableFieldUpdates(
    candidates: readonly WorkflowFieldUpdateCandidate[],
    object: string,
    notes: string[],
  ): void {
    const unreadable = candidates.filter((c) => c.unresolved).length;
    if (unreadable === 0) return;
    notes.push(
      `${unreadable} workflow field update(s) on ${object} returned no readable Metadata, so the ` +
        `field each one targets is unknown. They are listed as inferred rows — that is a gap in ` +
        `what could be read, not evidence they write this field.`,
    );
  }

  async function fetchWorkflowFieldUpdates(object: string): Promise<WorkflowFetch> {
    const notes: string[] = [];

    let listed: Array<{ Id?: string; Name?: string }> = [];
    try {
      const list = await q.toolingQuery<{ Id?: string; Name?: string }>(
        workflowFieldUpdateListQuery(),
      );
      listed = list.records.filter((r) => typeof r.Id === 'string' && r.Id.length > 0);
    } catch (err) {
      notes.push(
        `Workflow field updates could not be listed (${message(err)}), so NONE were checked — ` +
          `that is a failed query, not a finding that nothing updates ${object}.`,
      );
      return { candidates: [], notes };
    }
    if (listed.length === 0) return { candidates: [], notes };

    // Which rows get read is not relevance-driven (see the query builder), so
    // both bounds are stated before any result is.
    const read = listed.slice(0, WORKFLOW_METADATA_CAP);
    const unread = listed.length - read.length;
    if (unread > 0 || listed.length >= WORKFLOW_LIST_CAP) {
      const listCap =
        listed.length >= WORKFLOW_LIST_CAP ? ` (list cap ${WORKFLOW_LIST_CAP} — there may be more)` : '';
      notes.push(
        `Workflow field updates cannot be filtered by object in a query, so all ${listed.length} in ` +
          `the org were listed${listCap} and the first ${read.length} read individually (cap ` +
          `${WORKFLOW_METADATA_CAP}). ${unread} were not read at all; any of them could target ${object}.`,
      );
    }

    const candidates: WorkflowFieldUpdateCandidate[] = [];
    /** Read, but `FullName` was unavailable — the target object stays unknown. */
    let unbound = 0;
    const queue = [...read];
    await Promise.all(
      Array.from({ length: Math.min(WORKFLOW_DETAIL_CONCURRENCY, queue.length) }, async () => {
        while (queue.length > 0) {
          const row = queue.shift();
          if (!row?.Id) continue;
          let detail: { FullName?: string; Metadata?: { field?: string } } | undefined;
          try {
            const result = await q.toolingQuery<{
              FullName?: string;
              Metadata?: { field?: string };
            }>(workflowFieldUpdateDetailQuery(row.Id));
            detail = result.records[0];
          } catch {
            detail = undefined;
          }
          const target = objectFromFullName(detail?.FullName);
          // No object → no row, the same call flowRow makes on the broad-scan
          // path. The list is ORG-WIDE now, so an unbound update is not "an
          // update on this object whose field we could not read" — it may belong
          // to any object at all, and listing it would drop every unreadable
          // field update in the org into THIS field's results. Counted and
          // disclosed below; never silently discarded.
          if (!target) {
            unbound++;
            continue;
          }
          candidates.push({
            id: row.Id,
            name: detail?.FullName ?? row.Name ?? row.Id,
            label: row.Name ?? null,
            object: target,
            field: detail?.Metadata?.field ?? null,
            unresolved: !detail?.Metadata?.field,
          });
        }
      }),
    );

    if (unbound > 0) {
      notes.push(
        `${unbound} workflow field update(s) were read but carried no FullName, so the object each ` +
          `one targets is unknown. They are NOT listed — nothing tied them to ${object} — but any ` +
          `of them could update it.`,
      );
    }
    // Only the ones that survive the object match reach the table, so only those
    // are what the "unreadable Metadata" note is accounting for.
    noteUnreadableFieldUpdates(
      candidates.filter((c) => (c.object ?? '').toLowerCase() === object.toLowerCase()),
      object,
      notes,
    );
    return { candidates, notes };
  }

  interface ApexFetch {
    hits: ApexSearchHit[];
    notes: string[];
  }

  async function fetchApexHits(field: string): Promise<ApexFetch> {
    const sosl = apexSearchSosl(field);
    if (!sosl) {
      return {
        hits: [],
        notes: [`Apex search skipped — "${field}" is not a plain API name.`],
      };
    }
    try {
        const searchRecords = await q.toolingSearch(sosl);
        const hits: ApexSearchHit[] = [];
        for (const record of searchRecords) {
        const type = record.attributes?.type;
        if (type !== 'ApexClass' && type !== 'ApexTrigger') continue;
        if (!record.Id || !record.Name) continue;
        hits.push({ id: record.Id, name: record.Name, type });
      }
      // The real bound. Sorted first so the truncation is deterministic rather
      // than "whatever order the search happened to return".
      hits.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
      if (hits.length > APEX_HIT_CAP) {
        const total = hits.length;
        hits.length = APEX_HIT_CAP;
        return {
          hits,
          notes: [
            // NOT a match count: `total` is measured after the server-side
            // per-object LIMITs in the SOSL, so it is itself capped and an org
            // with 300 matching classes reports the cap, not 300. Say what the
            // number actually is.
            `The Apex text search RETURNED ${total} classes/triggers — itself a capped result, ` +
              `not the true number of matches; the first ${APEX_HIT_CAP} (by type, then name) are ` +
              `listed. More may exist.`,
          ],
        };
      }
      return { hits, notes: [] };
    } catch (err) {
      return { hits: [], notes: [`Apex text search unavailable (${message(err)}).`] };
    }
  }

  function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

    /**
     * Fetch everything, then hand it to the pure viewmodel.
     *
     * The three scans are independent and run concurrently; each one converts its
     * own failures into notes rather than throwing, so a refused Apex search still
     * returns Flow and workflow results — with the gap stated — instead of losing
     * the whole answer.
     */
    const [flows, workflows, apex] = await Promise.all([
      fetchFlowCandidates(object, field),
      fetchWorkflowFieldUpdates(object),
      fetchApexHits(field),
    ]);
    return buildFieldImpactVM({
      object,
      field,
      origin,
      flows: flows.candidates,
      workflowFieldUpdates: workflows.candidates,
      apexHits: apex.hits,
      notes: [...flows.notes, ...workflows.notes, ...apex.notes],
    });
}
