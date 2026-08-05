// Field Impact Analysis (P4-4) — "What writes this field?".
//
// Launched from the Schema Browser's per-field actions and from the Show API
// Names panel (the two surfaces where a user already has a field in front of
// them); also usable standalone from the Workspace / ⚡ menu.
//
// Data sources, and why each lands where it does on the confirmed/inferred split
// (`lib/field-impact.ts` documents the vocabulary — it is the dependency
// `--gaps` convention):
//
//   Flows                  MetadataComponentDependency narrows the candidate set
//                          (which flows so much as MENTION the field), then
//                          @sfdt/flow-core's extractFieldWrites decides which of
//                          them actually WRITE it. A parsed write is confirmed.
//                          A candidate we could not analyse stays inferred.
//   Workflow field updates Tooling WorkflowFieldUpdate.Metadata names the target
//                          field outright → confirmed. Neither the object nor the
//                          field can be filtered on in the query (see
//                          workflowFieldUpdateListQuery), so this is an org-wide
//                          list plus bounded per-row reads, matched client-side.
//   Apex                   Tooling SOSL text search over class/trigger source.
//                          A text hit is not a write → always inferred.
//
// Every org call goes through the worker-proxied API client (`sfApiFetch`); the
// SID never reaches this module. Flow parsing is delegated to flow-core — there
// is deliberately no second Flow parser in the extension.

import { CONTEXTS, extractRecordContext } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import { getSalesforceApi, type SalesforceApiClient } from '../lib/salesforce-api.js';
import {
  buildFieldImpactVM,
  STATUS_LEGEND,
  type ApexSearchHit,
  type FieldImpactRow,
  type FieldImpactVM,
  type FlowCandidate,
  type WorkflowFieldUpdateCandidate,
} from '../lib/field-impact.js';
import { presentView, type ViewHandle } from '../ui/present-view.js';
import { renderSfError } from '../ui/panels.js';
import { escapeSoql } from '@sfdt/flow-core';
import { button, toolbar } from '../lib/ui-controls.js';

// Bounded scans: every one of these costs org round-trips, and an unbounded
// sweep of a big org would hang the panel. Whatever a cap excludes is reported
// as a scope note, never silently dropped.
const FLOW_CANDIDATE_CAP = 50;
/** Flows whose `Metadata` we fetch — Tooling returns Metadata one row at a time. */
const FLOW_ANALYSE_CAP = 15;
/** Field updates listed in one query (Id + Name only — the cheap projection). */
const WORKFLOW_LIST_CAP = 200;
/** Field updates whose `FullName`/`Metadata` we fetch — one row per query. */
const WORKFLOW_METADATA_CAP = 50;
/** Concurrent per-row detail fetches (same shape subflow-graph uses). */
const WORKFLOW_DETAIL_CONCURRENCY = 5;
const APEX_HIT_CAP = 25;

export interface FieldImpactOptions {
  doc?: Document;
  win?: Window;
  api?: SalesforceApiClient;
}

export type FieldImpactFeature = Feature & {
  /** Open the analysis for a specific object + field (Schema Browser / Show API Names entry). */
  openFor: (objectApiName: string, fieldApiName: string) => Promise<void>;
};

interface AnalysisResult {
  vm: FieldImpactVM;
}

// --------------------------------------------------------------------------
// Pure query builders (exported for tests — no DOM, no network)
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
 * client-side truncation in `fetchApexHits`. Relying on the trailing clause
 * alone let two returned sObject types yield `2 × APEX_HIT_CAP` rows while the
 * constant claimed one.
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
// Feature
// --------------------------------------------------------------------------

export function createFieldImpactFeature(options: FieldImpactOptions = {}): FieldImpactFeature {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  const api = options.api ?? getSalesforceApi();

  let view: ViewHandle | null = null;
  let previouslyFocused: Element | null = null;
  let runAnalysis: ((object: string, field: string) => Promise<void>) | null = null;

  function teardown(): void {
    runAnalysis = null;
  }

  /**
   * Sole owner of the focus-restore side effect (CONVENTIONS item 4). Both
   * teardown routes call it and `view.close()` re-enters through `onClose`, so
   * it is written to be idempotent rather than relying on call ordering.
   */
  function restoreFocus(): void {
    if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    previouslyFocused = null;
  }

  function close(): void {
    teardown(); // before view.close(), while `view` still owns the trap listener
    view?.close(); // re-enters via onClose; restoreFocus() tolerates that
    view = null;
    restoreFocus();
  }

  // ---- org fetching -------------------------------------------------------

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
      const result = await api.toolingQuery<{ Id?: string }>(customFieldIdQuery(object, field));
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
        const deps = await api.toolingQuery<{ MetadataComponentId?: string }>(
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
        const flows = await api.toolingQuery<{ ActiveVersionId?: string }>(recentActiveFlowsQuery());
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
        const result = await api.toolingQuery<{
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
      const list = await api.toolingQuery<{ Id?: string; Name?: string }>(
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
            const result = await api.toolingQuery<{
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
      const result = await api.apiGet<{
        searchRecords?: Array<{ Id?: string; Name?: string; attributes?: { type?: string } }>;
      }>(`/services/data/${api.apiVersion}/tooling/search/`, { q: sosl });
      const hits: ApexSearchHit[] = [];
      for (const record of result.searchRecords ?? []) {
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

  /** Fetch everything, then hand it to the pure viewmodel. */
  async function analyse(object: string, field: string): Promise<AnalysisResult> {
    const [flows, workflows, apex] = await Promise.all([
      fetchFlowCandidates(object, field),
      fetchWorkflowFieldUpdates(object),
      fetchApexHits(field),
    ]);
    return {
      vm: buildFieldImpactVM({
        object,
        field,
        origin: win.location.origin,
        flows: flows.candidates,
        workflowFieldUpdates: workflows.candidates,
        apexHits: apex.hits,
        notes: [...flows.notes, ...workflows.notes, ...apex.notes],
      }),
    };
  }

  // ---- rendering ----------------------------------------------------------

  const CELL = 'padding: 6px 8px; vertical-align: top; font-size: 12px;';

  function statusBadge(status: FieldImpactRow['status']): HTMLElement {
    const badge = doc.createElement('span');
    const confirmed = status === 'confirmed';
    badge.textContent = confirmed ? 'confirmed' : 'inferred';
    // The status is also the text, never colour alone (CONVENTIONS item 11).
    badge.style.cssText =
      'display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; white-space: nowrap;' +
      (confirmed
        ? ' background: var(--sfdt-color-success-bg); color: var(--sfdt-color-success-text); border: 1px solid var(--sfdt-color-success);'
        : ' background: var(--sfdt-color-warning-bg); color: var(--sfdt-color-warning-text); border: 1px dashed var(--sfdt-color-warning-border);');
    return badge;
  }

  function buildLegend(): HTMLElement {
    const legend = doc.createElement('p');
    legend.classList.add('sfdt-row', 'sfdt-wrap');
    for (const status of ['confirmed', 'inferred'] as const) {
      const item = doc.createElement('span');
      item.classList.add('sfdt-row', 'sfdt-snug');
      item.appendChild(statusBadge(status));
      const text = doc.createElement('span');
      text.textContent = STATUS_LEGEND[status];
      item.appendChild(text);
      legend.appendChild(item);
    }
    return legend;
  }

  function buildNotes(notes: readonly string[]): HTMLElement | null {
    if (notes.length === 0) return null;
    const wrap = doc.createElement('div');
    wrap.setAttribute('role', 'note');
    wrap.setAttribute('aria-label', 'Scan scope');
    wrap.style.cssText =
      'margin: 10px 0; padding: 8px 12px; border: 1px solid var(--sfdt-color-warning-border); background: var(--sfdt-color-warning-bg); border-radius: 4px; font-size: 12px; color: var(--sfdt-color-warning-text-2);';
    const heading = doc.createElement('div');
    heading.textContent = 'Scan scope';
    heading.classList.add('sfdt-subhead');
    wrap.appendChild(heading);
    const list = doc.createElement('ul');
    list.classList.add('sfdt-list', 'sfdt-flush-x');
    for (const note of notes) {
      const li = doc.createElement('li');
      li.textContent = note;
      list.appendChild(li);
    }
    wrap.appendChild(list);
    return wrap;
  }

  function buildTable(vm: FieldImpactVM): HTMLElement {
    const table = doc.createElement('table');
    table.setAttribute('aria-label', `Components that write ${vm.object}.${vm.field}`);
    table.style.cssText = 'width: 100%; border-collapse: collapse; text-align: left; margin-top: 10px;';

    const thead = doc.createElement('thead');
    const headRow = doc.createElement('tr');
    // The last column holds the Open link and shows no visible heading. An empty
    // `scope="col"` header is an UNNAMED column header, so it carries an
    // accessible name instead (CONVENTIONS item 10).
    const columns: ReadonlyArray<readonly [text: string, accessibleName: string]> = [
      ['Status', 'Status'],
      ['Type', 'Type'],
      ['Component', 'Component'],
      ['Evidence', 'Evidence'],
      ['', 'Actions'],
    ];
    for (const [heading, accessibleName] of columns) {
      const th = doc.createElement('th');
      th.textContent = heading;
      th.setAttribute('scope', 'col');
      if (!heading) th.setAttribute('aria-label', accessibleName);
      th.style.cssText =
        CELL +
        ' background: var(--sfdt-color-surface-alt); border-bottom: 1px solid var(--sfdt-color-border); font-weight: 600; color: var(--sfdt-color-text-strong);';
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = doc.createElement('tbody');
    for (const row of vm.rows) {
      const tr = doc.createElement('tr');
      tr.classList.add('sfdt-divider');
      const tdStatus = doc.createElement('td');
      tdStatus.style.cssText = CELL;
      tdStatus.appendChild(statusBadge(row.status));

      const tdType = doc.createElement('td');
      tdType.textContent = row.typeLabel;
      tdType.style.cssText = `${CELL} color: var(--sfdt-color-text-weak);`;

      const tdName = doc.createElement('td');
      tdName.style.cssText = `${CELL} color: var(--sfdt-color-text-strong);`;
      const nameLine = doc.createElement('div');
      nameLine.textContent = row.label;
      tdName.appendChild(nameLine);
      if (row.name !== row.label) {
        const apiLine = doc.createElement('div');
        apiLine.textContent = row.name;
        apiLine.style.cssText =
          'font-family: ui-monospace, monospace; font-size: 11px; color: var(--sfdt-color-text-weak);';
        tdName.appendChild(apiLine);
      }

      const tdDetail = doc.createElement('td');
      tdDetail.textContent = row.detail;
      tdDetail.style.cssText = `${CELL} color: var(--sfdt-color-text-weak);`;

      const tdOpen = doc.createElement('td');
      tdOpen.style.cssText = `${CELL} white-space: nowrap;`;
      if (row.url) {
        const link = doc.createElement('a');
        link.href = row.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'Open';
        link.setAttribute('aria-label', `Open ${row.typeLabel} ${row.label} in a new tab`);
        link.style.cssText =
          'color: var(--sfdt-color-brand-text); text-decoration: underline; font-size: 12px;';
        tdOpen.appendChild(link);
      }

      tr.append(tdStatus, tdType, tdName, tdDetail, tdOpen);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    return table;
  }

  function open(preset?: { object?: string; field?: string }): void {
    close();
    previouslyFocused = doc.activeElement;

    const body = doc.createElement('div');
    body.className = 'sfdt-view-body';
    // The object/field inputs and Analyze are this view's controls — pinned, so
    // they stay reachable while a long impact report scrolls under them.
    const form = toolbar(doc);
    form.classList.add('sfdt-wrap', 'sfdt-bottom');
    const makeInput = (id: string, label: string, placeholder: string): HTMLInputElement => {
      const wrap = doc.createElement('div');
      wrap.classList.add('sfdt-stack', 'sfdt-tight');
      const lab = doc.createElement('label');
      lab.textContent = label;
      lab.htmlFor = id;
      lab.className = 'sfdt-muted';
      const input = doc.createElement('input');
      input.type = 'text';
      input.id = id;
      input.placeholder = placeholder;
      input.setAttribute('autocomplete', 'off');
      input.setAttribute('spellcheck', 'false');
      input.className = 'sfdt-field sfdt-auto';
      input.classList.add('sfdt-search');
      wrap.append(lab, input);
      form.appendChild(wrap);
      return input;
    };

    const objectInput = makeInput('sfdt-field-impact-object', 'Object API name', 'Account');
    const fieldInput = makeInput('sfdt-field-impact-field', 'Field API name', 'Industry');

    const runBtn = button({ label: 'What writes this field?', iconName: 'search', variant: 'primary', doc });
    form.appendChild(runBtn);
    body.appendChild(form);
    const main = doc.createElement('div');
    main.className = 'sfdt-view-main';
    body.appendChild(main);

    const status = doc.createElement('div');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.classList.add('sfdt-muted');
    main.appendChild(status);

    const results = doc.createElement('div');
    main.appendChild(results);

    view = presentView({
      title: 'Field Impact — what writes this field?',
      iconName: 'link',
      body,
      doc,
      width: '900px',
      onClose: () => {
        teardown();
        view = null;
        restoreFocus();
      },
    });

    function clearResults(): void {
      while (results.firstChild) results.removeChild(results.firstChild);
    }

    async function run(object: string, field: string): Promise<void> {
      clearResults();
      if (!object.trim() || !field.trim()) {
        status.textContent = 'Enter both an object and a field API name.';
        return;
      }
      runBtn.disabled = true;
      status.textContent = `Analysing ${object.trim()}.${field.trim()}…`;
      try {
        const { vm } = await analyse(object.trim(), field.trim());
        // A bare "nothing found" is the most dangerous sentence this panel can
        // produce, and it is the ONLY one announced: the summary is the
        // `role="status"` live region, while every caveat sits in the
        // `role="note"` panel OUTSIDE it. So when the scan was bounded — a
        // strict broad scan, a refused query, a construct class the parser does
        // not model — the negative result must carry its qualifier with it,
        // rather than leaving it to a panel a screen-reader user is never told
        // about.
        if (vm.counts.total === 0) {
          status.textContent =
            vm.notes.length > 0
              ? `Nothing found that writes ${vm.object}.${vm.field} in the scanned set — this was ` +
                `a partial scan that can exclude real writers; see Scan scope below.`
              : `Nothing found that writes ${vm.object}.${vm.field}.`;
        } else {
          status.textContent =
            `${vm.counts.total} source(s) for ${vm.object}.${vm.field} — ` +
            `${vm.counts.confirmed} confirmed, ${vm.counts.inferred} inferred.`;
        }
        const notes = buildNotes(vm.notes);
        if (notes) results.appendChild(notes);
        if (vm.counts.total > 0) results.appendChild(buildTable(vm));
        results.appendChild(buildLegend());
      } catch (err) {
        status.textContent = 'Failed';
        results.appendChild(renderSfError(err, { doc }));
      } finally {
        runBtn.disabled = false;
      }
    }

    runAnalysis = async (object: string, field: string) => {
      objectInput.value = object;
      fieldInput.value = field;
      await run(object, field);
    };

    runBtn.addEventListener('click', () => void run(objectInput.value, fieldInput.value));
    for (const input of [objectInput, fieldInput]) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') void run(objectInput.value, fieldInput.value);
      });
    }

    // --- A11y (CONVENTIONS items 1, 3, 4, 8): Esc closes in the capture phase
    // and the listener is removed on close; focus is trapped in modal mode only
    // (a Workspace tab pane is a persistent surface) and restored on close. ---
    // Esc and the focus trap are NOT wired here. ui/present-view.ts owns both,
    // and it checks that this overlay is the topmost one before acting. The
    // capture-phase document listener that used to live here skipped that check,
    // so an Escape meant for a dialog opened ON TOP of this view closed this one
    // too — third instance of that bug in this codebase.

    // Pre-fill whatever the caller knew. Both known (Schema Browser / Show API
    // Names) → analyse immediately; object only (record page) → land the user on
    // the field box so one keystroke path completes the task.
    if (preset?.object) objectInput.value = preset.object;
    if (preset?.field) fieldInput.value = preset.field;
    if (preset?.object && preset.field) {
      void run(preset.object, preset.field);
      runBtn.focus();
    } else if (preset?.object) {
      fieldInput.focus();
    } else {
      objectInput.focus();
    }
  }

  async function openFor(objectApiName: string, fieldApiName: string): Promise<void> {
    if (view && runAnalysis) {
      await runAnalysis(objectApiName, fieldApiName);
      return;
    }
    open({ object: objectApiName, field: fieldApiName });
  }

  return {
    manifest: {
      id: 'field-impact',
      name: 'Field Impact Analysis',
      contexts: [
        CONTEXTS.RECORD_PAGE,
        CONTEXTS.SETUP_OTHER,
        CONTEXTS.SETUP_FLOWS,
        CONTEXTS.WORKSPACE,
      ],
    },

    async onActivate() {
      // On a record page the object is known from the URL; the user names the
      // field. Elsewhere (Workspace, Setup) both boxes start empty.
      const ctx = extractRecordContext(win.location.href);
      open(ctx?.sobjectName ? { object: ctx.sobjectName } : undefined);
    },

    openFor,
  };
}

export function _fieldImpactTestApi() {
  return {
    customFieldIdQuery,
    flowCandidateQuery,
    recentActiveFlowsQuery,
    flowMetadataQuery,
    workflowFieldUpdateListQuery,
    workflowFieldUpdateDetailQuery,
    objectFromFullName,
    apexSearchSosl,
  };
}
