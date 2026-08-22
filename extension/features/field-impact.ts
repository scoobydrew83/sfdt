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
  analyzeFieldImpact,
  STATUS_LEGEND,
  type FieldImpactQueries,
  type FieldImpactRow,
  type FieldImpactVM,
} from '../lib/field-impact.js';
import { presentView, type ViewHandle } from '../ui/present-view.js';
import { renderSfError } from '../ui/panels.js';
import { button, toolbar } from '../lib/ui-controls.js';

export interface FieldImpactOptions {
  doc?: Document;
  win?: Window;
  api?: SalesforceApiClient;
}

export type FieldImpactFeature = Feature & {
  /** Open the analysis for a specific object + field (Schema Browser / Show API Names entry). */
  openFor: (objectApiName: string, fieldApiName: string) => Promise<void>;
};

// --------------------------------------------------------------------------
// Pure query builders (exported for tests — no DOM, no network)
// --------------------------------------------------------------------------
//
// The pure query builders and the scan caps moved to `@sfdt/flow-core`
// (`lib/field-impact.ts` re-exports them). They are re-exported here too,
// because this module's public surface is what `test/field-impact.test.ts` and
// the two entry-point features import — and because a builder that lived here
// while the CLI used its own copy is exactly how the two surfaces would drift
// to different scan depths.
export {
  FLOW_CANDIDATE_CAP,
  FLOW_ANALYSE_CAP,
  WORKFLOW_LIST_CAP,
  WORKFLOW_METADATA_CAP,
  WORKFLOW_DETAIL_CONCURRENCY,
  APEX_HIT_CAP,
  customFieldIdQuery,
  flowCandidateQuery,
  recentActiveFlowsQuery,
  flowMetadataQuery,
  workflowFieldUpdateListQuery,
  workflowFieldUpdateDetailQuery,
  objectFromFullName,
  apexSearchSosl,
} from '../lib/field-impact.js';

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
  //
  // The scan moved to `@sfdt/flow-core` (`analyzeFieldImpact`). What stayed here
  // is the transport: this feature supplies the worker-proxied Tooling client,
  // the CLI supplies `sf data query --use-tooling-api`, and both get the same
  // rows and — the part that matters — the same scope notes.
  //
  // Both methods let a refusal THROW. Resolving empty instead would tell the
  // shared scan "your org has none of these", turning a permissions failure into
  // a clean bill of health.
  const queries: FieldImpactQueries = {
    toolingQuery: (soql) => api.toolingQuery(soql),
    toolingSearch: async (sosl) => {
      const result = await api.apiGet<{
        searchRecords?: Array<{ Id?: string; Name?: string; attributes?: { type?: string } }>;
      }>(`/services/data/${api.apiVersion}/tooling/search/`, { q: sosl });
      return result.searchRecords ?? [];
    },
  };


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
        const vm = await analyzeFieldImpact(queries, {
          object: object.trim(),
          field: field.trim(),
          origin: win.location.origin,
        });
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
