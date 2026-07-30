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
//                          field outright → confirmed.
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
import { presentView, inWorkspace, type ViewHandle } from '../ui/present-view.js';
import { escapeSoql } from '@sfdt/flow-core';

// Bounded scans: every one of these costs org round-trips, and an unbounded
// sweep of a big org would hang the panel. Whatever a cap excludes is reported
// as a scope note, never silently dropped.
const FLOW_CANDIDATE_CAP = 50;
/** Flows whose `Metadata` we fetch — Tooling returns Metadata one row at a time. */
const FLOW_ANALYSE_CAP = 15;
const WORKFLOW_METADATA_CAP = 15;
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

/** Fallback candidate set when no dependency edge exists (standard fields). */
export function recentActiveFlowsQuery(): string {
  return (
    `SELECT Id, MasterLabel, Status, Definition.DeveloperName FROM Flow WHERE Status = 'Active'` +
    ` ORDER BY LastModifiedDate DESC LIMIT ${FLOW_ANALYSE_CAP}`
  );
}

export function flowMetadataQuery(versionId: string): string {
  return (
    `SELECT Id, MasterLabel, Status, Definition.DeveloperName, Metadata FROM Flow` +
    ` WHERE Id = '${escapeSoql(versionId)}' LIMIT 1`
  );
}

export function workflowFieldUpdateQuery(object: string, withMetadata: boolean): string {
  const fields = withMetadata ? 'Id, Name, TableEnumOrId, Metadata' : 'Id, Name, TableEnumOrId';
  return `SELECT ${fields} FROM WorkflowFieldUpdate WHERE TableEnumOrId = '${escapeSoql(object)}'`;
}

/**
 * SOSL for the Apex text search. Field API names are `[A-Za-z0-9_]` only, so an
 * unexpected character means we refuse to build a search rather than emit a
 * term with SOSL syntax in it.
 */
export function apexSearchSosl(field: string): string | null {
  if (!/^[A-Za-z0-9_]+$/.test(field)) return null;
  return `FIND {${field}} IN ALL FIELDS RETURNING ApexClass(Id, Name), ApexTrigger(Id, Name) LIMIT ${APEX_HIT_CAP}`;
}

// --------------------------------------------------------------------------
// Feature
// --------------------------------------------------------------------------

export function createFieldImpactFeature(options: FieldImpactOptions = {}): FieldImpactFeature {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  const api = options.api ?? getSalesforceApi();

  let view: ViewHandle | null = null;
  let escHandler: ((e: KeyboardEvent) => void) | null = null;
  let trapHandler: ((e: KeyboardEvent) => void) | null = null;
  let previouslyFocused: Element | null = null;
  let runAnalysis: ((object: string, field: string) => Promise<void>) | null = null;

  function teardown(): void {
    if (escHandler) {
      doc.removeEventListener('keydown', escHandler, true);
      escHandler = null;
    }
    if (trapHandler && view) view.root.removeEventListener('keydown', trapHandler, true);
    trapHandler = null;
    runAnalysis = null;
  }

  function close(): void {
    teardown();
    view?.close();
    view = null;
    if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    previouslyFocused = null;
  }

  // ---- org fetching -------------------------------------------------------

  async function resolveCustomFieldId(object: string, field: string): Promise<string | null> {
    if (!/__c$/i.test(field)) return null; // standard fields have no CustomField row
    try {
      const result = await api.toolingQuery<{ Id?: string }>(customFieldIdQuery(object, field));
      return result.records[0]?.Id ?? null;
    } catch {
      return null;
    }
  }

  interface FlowFetch {
    candidates: FlowCandidate[];
    notes: string[];
  }

  async function fetchFlowCandidates(object: string, field: string): Promise<FlowFetch> {
    const notes: string[] = [];
    const fieldId = await resolveCustomFieldId(object, field);
    let versionIds: string[] = [];

    if (fieldId) {
      try {
        const deps = await api.toolingQuery<{ MetadataComponentId?: string }>(
          flowCandidateQuery(fieldId),
        );
        versionIds = deps.records
          .map((r) => r.MetadataComponentId)
          .filter((id): id is string => typeof id === 'string' && id.length > 0);
      } catch (err) {
        notes.push(
          `Flow candidates could not be narrowed via MetadataComponentDependency (${message(err)}).`,
        );
      }
    }

    if (!fieldId || versionIds.length === 0) {
      // No dependency edge (standard field, or the org records none) — fall back
      // to the most recently modified ACTIVE flows and say so plainly.
      try {
        const flows = await api.toolingQuery<{ Id?: string }>(recentActiveFlowsQuery());
        versionIds = flows.records
          .map((r) => r.Id)
          .filter((id): id is string => typeof id === 'string' && id.length > 0);
        notes.push(
          `No dependency edge for ${object}.${field}, so Flow coverage is a partial scan of the ` +
            `${versionIds.length} most recently modified active flow(s) — not every flow in the org.`,
        );
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
        if (!record) continue;
        candidates.push({
          versionId,
          apiName: record.Definition?.DeveloperName ?? record.MasterLabel ?? versionId,
          label: record.MasterLabel ?? null,
          status: record.Status ?? null,
          metadata: (record.Metadata ?? null) as FlowCandidate['metadata'],
        });
      } catch {
        candidates.push({
          versionId,
          apiName: versionId,
          label: null,
          status: null,
          metadata: null,
        });
      }
    }
    for (const versionId of skipped) {
      candidates.push({ versionId, apiName: versionId, label: null, status: null, metadata: null });
    }
    return { candidates, notes };
  }

  interface WorkflowFetch {
    candidates: WorkflowFieldUpdateCandidate[];
    notes: string[];
  }

  async function fetchWorkflowFieldUpdates(object: string): Promise<WorkflowFetch> {
    const notes: string[] = [];
    // Preferred: one query with Metadata. Some orgs/API versions refuse a
    // multi-row Metadata projection, so fall back to list + per-row fetch.
    try {
      const bulk = await api.toolingQuery<{
        Id?: string;
        Name?: string;
        TableEnumOrId?: string;
        Metadata?: { field?: string };
      }>(workflowFieldUpdateQuery(object, true));
      return {
        candidates: bulk.records.map((r) => ({
          id: r.Id ?? '',
          name: r.Name ?? r.Id ?? '',
          label: r.Name ?? null,
          object: r.TableEnumOrId ?? object,
          field: r.Metadata?.field ?? null,
          unresolved: !r.Metadata?.field,
        })),
        notes,
      };
    } catch {
      // fall through to the per-row path
    }

    let listed: Array<{ Id?: string; Name?: string; TableEnumOrId?: string }> = [];
    try {
      const list = await api.toolingQuery<{ Id?: string; Name?: string; TableEnumOrId?: string }>(
        workflowFieldUpdateQuery(object, false),
      );
      listed = list.records;
    } catch (err) {
      notes.push(`Workflow field updates could not be read (${message(err)}).`);
      return { candidates: [], notes };
    }

    const candidates: WorkflowFieldUpdateCandidate[] = [];
    for (const [index, row] of listed.entries()) {
      const base: WorkflowFieldUpdateCandidate = {
        id: row.Id ?? '',
        name: row.Name ?? row.Id ?? '',
        label: row.Name ?? null,
        object: row.TableEnumOrId ?? object,
        field: null,
        unresolved: true,
      };
      if (index >= WORKFLOW_METADATA_CAP || !row.Id) {
        candidates.push(base);
        continue;
      }
      try {
        const detail = await api.toolingQuery<{ Metadata?: { field?: string } }>(
          `SELECT Id, Metadata FROM WorkflowFieldUpdate WHERE Id = '${escapeSoql(row.Id)}' LIMIT 1`,
        );
        const target = detail.records[0]?.Metadata?.field ?? null;
        candidates.push({ ...base, field: target, unresolved: !target });
      } catch {
        candidates.push(base);
      }
    }
    if (listed.length > WORKFLOW_METADATA_CAP) {
      notes.push(
        `${listed.length - WORKFLOW_METADATA_CAP} workflow field update(s) on ${object} were not ` +
          `read individually (cap ${WORKFLOW_METADATA_CAP}); they are listed as inferred.`,
      );
    }
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
    legend.style.cssText =
      'margin: 8px 0 0; font-size: 11px; color: var(--sfdt-color-text-weak); display: flex; gap: 12px; flex-wrap: wrap;';
    for (const status of ['confirmed', 'inferred'] as const) {
      const item = doc.createElement('span');
      item.style.cssText = 'display: inline-flex; align-items: center; gap: 6px;';
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
    heading.style.cssText = 'font-weight: 600; margin-bottom: 4px;';
    wrap.appendChild(heading);
    const list = doc.createElement('ul');
    list.style.cssText = 'margin: 0; padding-left: 18px;';
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
    for (const heading of ['Source', 'Type', 'Component', 'Evidence', '']) {
      const th = doc.createElement('th');
      th.textContent = heading;
      th.setAttribute('scope', 'col');
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
      tr.style.cssText = 'border-bottom: 1px solid var(--sfdt-color-bg);';

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
    body.style.cssText = 'padding: 16px; overflow-y: auto; flex: 1; font-size: 13px;';

    const form = doc.createElement('div');
    form.style.cssText = 'display: flex; gap: 8px; align-items: flex-end; flex-wrap: wrap;';

    const makeInput = (id: string, label: string, placeholder: string): HTMLInputElement => {
      const wrap = doc.createElement('div');
      wrap.style.cssText = 'display: flex; flex-direction: column; gap: 4px;';
      const lab = doc.createElement('label');
      lab.textContent = label;
      lab.htmlFor = id;
      lab.style.cssText = 'font-size: 11px; color: var(--sfdt-color-text-weak);';
      const input = doc.createElement('input');
      input.type = 'text';
      input.id = id;
      input.placeholder = placeholder;
      input.setAttribute('autocomplete', 'off');
      input.setAttribute('spellcheck', 'false');
      input.style.cssText =
        'padding: 5px 8px; border: 1px solid var(--sfdt-color-border); border-radius: 4px; font-size: 13px; min-width: 180px;';
      wrap.append(lab, input);
      form.appendChild(wrap);
      return input;
    };

    const objectInput = makeInput('sfdt-field-impact-object', 'Object API name', 'Account');
    const fieldInput = makeInput('sfdt-field-impact-field', 'Field API name', 'Industry');

    const runBtn = doc.createElement('button');
    runBtn.type = 'button';
    runBtn.textContent = 'What writes this field?';
    runBtn.style.cssText =
      'padding: 6px 14px; border: 1px solid var(--sfdt-color-brand); background: var(--sfdt-color-brand); color: var(--sfdt-color-on-accent); border-radius: 4px; cursor: pointer; font-size: 13px;';
    form.appendChild(runBtn);
    body.appendChild(form);

    const status = doc.createElement('div');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.style.cssText = 'margin-top: 10px; font-size: 12px; color: var(--sfdt-color-text-weak);';
    body.appendChild(status);

    const results = doc.createElement('div');
    body.appendChild(results);

    view = presentView({
      title: '✍️ Field Impact — what writes this field?',
      body,
      doc,
      width: '900px',
      onClose: () => {
        teardown();
        view = null;
        if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
        previouslyFocused = null;
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
        status.textContent =
          vm.counts.total === 0
            ? `Nothing found that writes ${vm.object}.${vm.field}.`
            : `${vm.counts.total} source(s) for ${vm.object}.${vm.field} — ` +
              `${vm.counts.confirmed} confirmed, ${vm.counts.inferred} inferred.`;
        const notes = buildNotes(vm.notes);
        if (notes) results.appendChild(notes);
        if (vm.counts.total > 0) results.appendChild(buildTable(vm));
        results.appendChild(buildLegend());
      } catch (err) {
        status.textContent = 'Failed';
        const errorPanel = doc.createElement('div');
        errorPanel.style.cssText =
          'margin-top: 10px; border: 1px solid var(--sfdt-color-error-border); background: var(--sfdt-color-error-bg); color: var(--sfdt-color-error-text); padding: 8px 12px; border-radius: 4px; font-size: 13px;';
        errorPanel.textContent = message(err);
        results.appendChild(errorPanel);
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
    escHandler = (e) => {
      if (e.key === 'Escape' && view) close();
    };
    doc.addEventListener('keydown', escHandler, true);

    if (!inWorkspace()) {
      trapHandler = (e) => {
        if (e.key !== 'Tab' || !view) return;
        const focusables = view.root.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        const activeEl = doc.activeElement;
        if (e.shiftKey && activeEl === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && activeEl === last) {
          e.preventDefault();
          first.focus();
        }
      };
      view.root.addEventListener('keydown', trapHandler, true);
    }

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
    workflowFieldUpdateQuery,
    apexSearchSosl,
  };
}
