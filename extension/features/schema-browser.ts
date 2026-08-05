// Schema Browser (P2-1) — a two-pane tool: a searchable, windowed object list on
// the left and a per-object field table on the right. Available as a Workspace
// tool and from a record page via the ⚡ menu.
//
// All describes flow through the SHARED describe cache (lib/describe-cache.ts) so
// a describe fetched by one consumer (SOQL autocomplete, Inspect Record) is
// reused here and vice-versa — there is no second describe path. Describe →
// view-state mapping lives entirely in the pure mappers (lib/schema-viewmodel.ts).
import { CONTEXTS, extractRecordContext } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import { getSalesforceApi, type SalesforceApiClient } from '../lib/salesforce-api.js';
import { getDescribeCache } from '../lib/describe-cache.js';
import {
  toObjectListVM,
  toFieldTableVM,
  toObjectMetaVM,
  buildObjectGraphVM,
  typeDisplay,
  toExportRows,
  CUSTOM_FIELD_LIMIT,
  type ObjectListItem,
  type FieldRow,
  type ObjectMetaVM,
} from '../lib/schema-viewmodel.js';
import { presentView, type ViewHandle } from '../ui/present-view.js';
import { showToast } from '../ui/toast.js';
import { SF_API_VERSION } from '../lib/api-version.js';
import { escapeSoql } from '../lib/escape.js';
import { button, field, glyph, toolbar } from '../lib/ui-controls.js';
import { buildNodeGraphSvg } from '../ui/node-graph.js';
import { loadingPanel, renderSfError } from '../ui/panels.js';
import { openMenu } from '../ui/menu.js';
import { triggerDownload, exportFilename } from '../lib/download.js';
import { recordsToCsv, recordsToJson } from './soql-runner.js';
import { copyToClipboard } from '../ui/clipboard.js';

// Object-list windowing: render at most PAGE rows up front and extend by PAGE as
// the user scrolls (or when a filter narrows the set to ≤ PAGE). An 800+ object
// org therefore never builds an unbounded DOM. No virtualization library — the
// windowing is a plain slice + scroll handler.
const PAGE = 50;

export interface SchemaBrowserOptions {
  doc?: Document;
  win?: Window;
  api?: SalesforceApiClient;
  /** Drop a field API name into the SOQL Runner draft (P2-1 PR-3). When absent,
   * the per-field "Insert into query" action is hidden. */
  insertFieldIntoDraft?: (fieldApiName: string) => void;
  /** Copy an object's schema (optionally a field subset) to the clipboard for an
   * LLM prompt (P2-1 PR-3). When absent, the field-selection + export UI is hidden. */
  exportForPrompt?: (objectName: string, fieldNames?: readonly string[]) => void | Promise<void>;
  /** Open "What writes this field?" for a field (P4-4). When absent, the
   * per-field action is hidden — same wiring pattern as insertFieldIntoDraft. */
  analyzeFieldImpact?: (objectName: string, fieldApiName: string) => void | Promise<void>;
  /** Stage a whole query in the SOQL Runner and open it ("Generate SOQL").
   * Distinct from insertFieldIntoDraft, which appends ONE field to whatever
   * draft is there — this replaces the draft with a complete SELECT built from
   * the checkbox selection. When absent, the button is hidden. */
  runQueryInRunner?: (soql: string) => void | Promise<void>;
}

/** Row-count endpoint. Replies `{ sObjects: [{ name, count }] }`. */
export function buildRecordCountEndpoint(sobjectName: string): string {
  return `/services/data/${SF_API_VERSION}/limits/recordCount?sObjects=${encodeURIComponent(sobjectName)}`;
}

/**
 * Audit trail for a CUSTOM object.
 *
 * There is deliberately no standard-object equivalent. `CustomObject` is a
 * Tooling entity that only exists for custom objects, and `EntityDefinition` —
 * the standard-object counterpart — carries no audit fields at all. So on
 * Account this data does not exist anywhere in the API, and the rail hides the
 * section rather than rendering four dashes and implying a permission problem.
 */
export function buildObjectAuditQuery(sobjectName: string): string {
  // CustomObject.DeveloperName is the API name WITHOUT the __c suffix.
  const developerName = sobjectName.replace(/__c$/i, '');
  return (
    'SELECT Id, DeveloperName, CreatedDate, CreatedBy.Name, LastModifiedDate, ' +
    'LastModifiedBy.Name FROM CustomObject ' +
    `WHERE DeveloperName = '${escapeSoql(developerName)}' LIMIT 1`
  );
}

/** The query "Generate SOQL" stages for the runner. */
export function buildSelectQuery(sobjectName: string, fieldNames: readonly string[]): string {
  return `SELECT ${fieldNames.join(', ')}\nFROM ${sobjectName}\nLIMIT 200`;
}

interface AsyncCell<T> {
  status: 'loading' | 'ok' | 'error';
  value?: T;
  error?: string;
}

interface AuditInfo {
  createdBy: string;
  createdDate: string;
  modifiedBy: string;
  modifiedDate: string;
}

// Tooling projections for the audit query.
interface CustomObjectRow {
  CreatedDate?: string;
  LastModifiedDate?: string;
  CreatedBy?: { Name?: string };
  LastModifiedBy?: { Name?: string };
}

function formatStamp(iso: string | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString() : iso;
}

/** The Schema Browser feature, plus an imperative opener for cross-links / the ⚡ menu. */
export type SchemaBrowserFeature = Feature & {
  /** Open the browser focused on a specific sObject (record-page entry + reference cross-links). */
  openFor: (sobjectName: string) => Promise<void>;
};

export function createSchemaBrowserFeature(options: SchemaBrowserOptions = {}): SchemaBrowserFeature {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  const api = options.api ?? getSalesforceApi();
  const cache = getDescribeCache(api);
  const insertField = options.insertFieldIntoDraft;
  const exportForPrompt = options.exportForPrompt;
  const analyzeFieldImpact = options.analyzeFieldImpact;
  const runQueryInRunner = options.runQueryInRunner;
  // Per-object async rail data. Keyed by object so revisiting one doesn't refetch
  // — the counts don't move fast enough to be worth a round-trip per click.
  const recordCounts = new Map<string, AsyncCell<number>>();
  const audits = new Map<string, AsyncCell<AuditInfo>>();
  // Per-object field selection for "Export selected for prompt": object API name →
  // set of chosen field API names. Default = every field selected (users unselect
  // what they don't want). Persists across reopens for the feature instance.
  const fieldSelection = new Map<string, Set<string>>();

  let view: ViewHandle | null = null;
  let unsubscribe: (() => void) | null = null;
  let previouslyFocused: Element | null = null;

  // View-scoped renderers, wired up in open(). openFor() calls selectObject when
  // a view is already mounted so cross-links navigate in place.
  let selectObject: ((name: string) => void) | null = null;

  function teardown(): void {
    unsubscribe?.();
    unsubscribe = null;
    selectObject = null;
  }

  function restoreFocus(): void {
    if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    previouslyFocused = null;
  }

  function close(): void {
    teardown();
    view?.close();
    view = null;
    restoreFocus();
  }

  function open(initialSobject?: string): void {
    close();
    previouslyFocused = doc.activeElement;

    const body = doc.createElement('div');
    body.className = 'sfdt-view-body';
    body.style.height = '70vh';

    const split = doc.createElement('div');
    split.className = 'sfdt-split';
    body.appendChild(split);

    // --- Left pane: filter box + windowed object list ---
    const leftPane = doc.createElement('div');
    leftPane.className = 'sfdt-split-side';

    const filterWrap = toolbar(doc);
    const filterInput = field({
      placeholder: 'Filter objects…',
      ariaLabel: 'Filter objects by label or API name',
      doc,
    });
    filterInput.id = 'sfdt-schema-object-filter';
    filterInput.setAttribute('autocomplete', 'off');
    filterInput.setAttribute('spellcheck', 'false');
    filterInput.classList.add('sfdt-toolbar-grow');
    filterWrap.appendChild(filterInput);
    leftPane.appendChild(filterWrap);

    const countLabel = doc.createElement('div');
    countLabel.setAttribute('aria-live', 'polite');
    // Doubles as the failure line, which carries the org's annotated message —
    // '.sfdt-console' brings the white-space rule that keeps the guidance from
    // collapsing onto the end of it.
    countLabel.className = 'sfdt-muted sfdt-msg';
    countLabel.classList.add('sfdt-rail-note');
    leftPane.appendChild(countLabel);

    const listScroll = doc.createElement('div');
    listScroll.setAttribute('role', 'listbox');
    listScroll.setAttribute('aria-label', 'Salesforce objects');
    listScroll.className = 'sfdt-scroll';
    leftPane.appendChild(listScroll);

    // --- Centre pane: object header + field table ---
    const centrePane = doc.createElement('div');
    centrePane.className = 'sfdt-split-main';

    const objectBar = toolbar(doc);
    const objectTitles = doc.createElement('div');
    objectTitles.className = 'sfdt-panel-titles';
    const heading = doc.createElement('h2');
    heading.className = 'sfdt-panel-title';
    const fieldCountLine = doc.createElement('span');
    fieldCountLine.className = 'sfdt-panel-sub';
    objectTitles.append(heading, fieldCountLine);
    const objectActions = doc.createElement('div');
    objectActions.className = 'sfdt-panel-actions';
    objectActions.classList.add('sfdt-toolbar-end');
    objectBar.append(objectTitles, objectActions);
    centrePane.appendChild(objectBar);

    const detailScroll = doc.createElement('div');
    detailScroll.className = 'sfdt-scroll';
    centrePane.appendChild(detailScroll);

    const placeholder = doc.createElement('div');
    placeholder.className = 'sfdt-muted sfdt-placeholder';

    placeholder.textContent = 'Select an object to view its fields.';
    detailScroll.appendChild(placeholder);

    // --- Right rail: object metadata, counts, audit, relationships ---
    const railPane = doc.createElement('div');
    railPane.className = 'sfdt-split-side sfdt-split-end';

    split.append(leftPane, centrePane, railPane);

    // --- Footer: what this view is reading, and how much of it ---
    const statusBar = toolbar(doc, true);
    const apiLine = doc.createElement('span');
    apiLine.className = 'sfdt-muted';
    apiLine.textContent = `Salesforce API ${SF_API_VERSION}`;
    const scopeLine = doc.createElement('span');
    scopeLine.className = 'sfdt-muted sfdt-toolbar-end';
    statusBar.append(apiLine, scopeLine);
    body.appendChild(statusBar);

    view = presentView({
      title: 'Schema Browser',
      iconName: 'schema-browser',
      body,
      doc,
      width: '1200px',
      onClose: () => {
        teardown();
        view = null;
        restoreFocus();
      },
    });

    // --- Object list state + windowed render ---
    let filtered: ObjectListItem[] = [];
    let windowCount = PAGE;
    let selectedName = '';
    // Cache the mapped object-list VM — toObjectListVM over an 800+ object global
    // describe is recomputed only when the underlying data reference changes (once
    // on load, again on org switch/cache clear), not on every keystroke/scroll or
    // unrelated cache-subscribe notification.
    let cachedAll: ObjectListItem[] = [];
    let cachedSource: unknown;
    // Cache-entry refs last rendered into each pane. The shared describe cache's
    // subscribe fires on ANY describe resolving (incl. other tools' unrelated
    // fetches), so each pane re-renders only when its OWN entry changed — else
    // unrelated activity would tear down visible state (e.g. an open picklist).
    let lastRenderedGlobal: unknown;
    let lastRenderedDetail: unknown;

    function matchesFilter(item: ObjectListItem, term: string): boolean {
      if (!term) return true;
      return (
        item.name.toLowerCase().includes(term) ||
        (item.label ?? '').toLowerCase().includes(term)
      );
    }

    function renderList(): void {
      const global = cache.getGlobal('rest');
      lastRenderedGlobal = global;
      while (listScroll.firstChild) listScroll.removeChild(listScroll.firstChild);

      if (global.status === 'loading') {
        countLabel.textContent = 'Loading objects…';
        return;
      }
      if (global.status === 'error' || !global.data) {
        // Say why. The org's own reason is the only thing that tells the user
        // whether to fix a permission, wait for an API limit, or log in again.
        countLabel.textContent = global.error
          ? `Failed to load objects — ${global.error}`
          : 'Failed to load objects.';
        return;
      }

      const term = filterInput.value.trim().toLowerCase();
      if (global.data !== cachedSource) {
        cachedSource = global.data;
        cachedAll = toObjectListVM(global.data);
      }
      const all = cachedAll;
      filtered = all
        .filter((item) => matchesFilter(item, term))
        .sort((a, b) => (a.label || a.name).localeCompare(b.label || b.name));

      if (windowCount > filtered.length) windowCount = Math.max(PAGE, filtered.length);
      const shown = filtered.slice(0, windowCount);

      countLabel.textContent = filtered.length === all.length
        ? `${all.length} objects`
        : `${filtered.length} of ${all.length} objects`;
      scopeLine.textContent = `${all.length} objects${selectedName ? ` · ${selectedName}` : ''}`;

      for (const item of shown) {
        listScroll.appendChild(buildObjectRow(item, item.name === selectedName));
      }
    }

    function buildObjectRow(item: ObjectListItem, active: boolean): HTMLElement {
      const row = doc.createElement('button');
      row.type = 'button';
      row.className = 'sfdt-nav-item';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', active ? 'true' : 'false');

      // Two glyphs, not a per-sObject icon map. An org has hundreds of objects
      // and no API tells us what any of them MEANS, so a map would be a
      // hand-maintained list of the dozen standard ones and a shrug for
      // everything else. Custom vs standard is the distinction that is both
      // knowable and actually useful when scanning.
      row.appendChild(glyph(item.custom ? 'table' : 'database', 16, doc));

      const names = doc.createElement('span');
      names.className = 'sfdt-nav-label';
      const labelSpan = doc.createElement('span');
      labelSpan.textContent = item.label || item.name;
      const apiSpan = doc.createElement('span');
      apiSpan.className = 'sfdt-mono sfdt-muted';
      apiSpan.textContent = item.name;
      names.append(labelSpan, apiSpan);
      row.appendChild(names);

      row.addEventListener('click', () => doSelectObject(item.name));
      return row;
    }

    // Extend the window as the user scrolls near the bottom.
    listScroll.addEventListener('scroll', () => {
      if (windowCount >= filtered.length) return;
      if (listScroll.scrollTop + listScroll.clientHeight >= listScroll.scrollHeight - 40) {
        windowCount += PAGE;
        renderList();
      }
    });

    filterInput.addEventListener('input', () => {
      windowCount = PAGE;
      renderList();
    });

    // --- Rail data (the two things NOT already in the describe) ---

    // Record count is a separate endpoint, so it is fetched per object and
    // cached. A failure is shown in place rather than thrown: the rest of the
    // rail is valid without it, and the usual cause (no "View All Data") is not
    // something the user can act on from here.
    function ensureRecordCount(name: string): void {
      if (recordCounts.has(name)) return;
      recordCounts.set(name, { status: 'loading' });
      void (async () => {
        try {
          const res = await api.apiGet<{ sObjects?: Array<{ name: string; count: number }> }>(
            buildRecordCountEndpoint(name),
          );
          const hit = res?.sObjects?.find((s) => s.name === name);
          recordCounts.set(name, { status: 'ok', value: hit?.count ?? 0 });
        } catch (err) {
          recordCounts.set(name, {
            status: 'error',
            error: err instanceof Error ? err.message : String(err),
          });
        }
        if (selectedName === name) renderRail();
      })();
    }

    // Audit only exists for custom objects — see buildObjectAuditQuery.
    function ensureAudit(name: string, meta: ObjectMetaVM): void {
      if (!meta.custom || audits.has(name)) return;
      audits.set(name, { status: 'loading' });
      void (async () => {
        try {
          const res = await api.toolingQuery<CustomObjectRow>(buildObjectAuditQuery(name));
          const row = res.records[0];
          if (!row) {
            audits.set(name, { status: 'error', error: 'No CustomObject row for this object.' });
          } else {
            audits.set(name, {
              status: 'ok',
              value: {
                createdBy: row.CreatedBy?.Name ?? '—',
                createdDate: formatStamp(row.CreatedDate),
                modifiedBy: row.LastModifiedBy?.Name ?? '—',
                modifiedDate: formatStamp(row.LastModifiedDate),
              },
            });
          }
        } catch (err) {
          audits.set(name, {
            status: 'error',
            error: err instanceof Error ? err.message : String(err),
          });
        }
        if (selectedName === name) renderRail();
      })();
    }

    // --- Right-pane render ---
    function doSelectObject(name: string): void {
      selectedName = name;
      // Reflect selection in the (possibly re-rendered) list.
      renderList();
      renderDetail();
    }

    // A cross-link to another object — reused by reference-target fields, the
    // child-relationship list and the relationship graph (keeps them from
    // drifting).
    function buildCrossLink(name: string): HTMLAnchorElement {
      const link = doc.createElement('a');
      link.href = '#';
      link.textContent = name;
      link.setAttribute('role', 'link');
      link.className = 'sfdt-link';
      link.addEventListener('click', (e) => {
        e.preventDefault();
        void openFor(name);
      });
      return link;
    }

    function railSection(title: string, iconName: string): HTMLElement {
      const section = doc.createElement('section');
      section.className = 'sfdt-rail-section';
      const h = doc.createElement('h3');
      h.appendChild(glyph(iconName, 14, doc));
      const t = doc.createElement('span');
      t.textContent = title;
      h.appendChild(t);
      section.appendChild(h);
      return section;
    }

    function kv(key: string, value: string | HTMLElement): HTMLElement {
      const row = doc.createElement('div');
      row.className = 'sfdt-kv';
      const k = doc.createElement('span');
      k.className = 'sfdt-kv-key';
      k.textContent = key;
      const v = doc.createElement('span');
      v.className = 'sfdt-kv-val';
      if (typeof value === 'string') v.textContent = value;
      else v.appendChild(value);
      row.append(k, v);
      return row;
    }

    function boolPill(on: boolean): HTMLElement {
      const pill = doc.createElement('span');
      pill.className = on ? 'sfdt-pill sfdt-success' : 'sfdt-pill';
      pill.textContent = on ? 'Yes' : 'No';
      return pill;
    }

    function renderRail(): void {
      while (railPane.firstChild) railPane.removeChild(railPane.firstChild);
      if (!selectedName) return;
      const describe = cache.getSObject('rest', selectedName);
      if (describe.status !== 'ready' || !describe.data) return;
      const meta = toObjectMetaVM(describe.data);
      const vm = toFieldTableVM(describe.data);

      // 1. Object metadata — free, straight out of the describe we already have.
      const metaSection = railSection('Object metadata', 'info');
      metaSection.appendChild(kv('API name', meta.name));
      metaSection.appendChild(kv('Label', meta.label));
      metaSection.appendChild(kv('Key prefix', meta.keyPrefix ?? '—'));
      metaSection.appendChild(kv('Custom', boolPill(meta.custom)));
      metaSection.appendChild(kv('Searchable', boolPill(meta.searchable)));
      metaSection.appendChild(kv('Queryable', boolPill(meta.queryable)));
      metaSection.appendChild(kv('Createable', boolPill(meta.createable)));
      metaSection.appendChild(kv('Updateable', boolPill(meta.updateable)));
      metaSection.appendChild(kv('Deletable', boolPill(meta.deletable)));
      railPane.appendChild(metaSection);

      // 2. Record count — one extra call, so it has its own loading/error line.
      const countSection = railSection('Record count', 'database');
      const cell = recordCounts.get(selectedName);
      if (!cell || cell.status === 'loading') {
        countSection.appendChild(kv('Records', 'Loading…'));
      } else if (cell.status === 'error') {
        const why = doc.createElement('div');
        why.className = 'sfdt-muted sfdt-msg';
        why.textContent = `Unavailable — ${cell.error ?? 'unknown error'}`;
        countSection.appendChild(why);
      } else {
        countSection.appendChild(kv('Records', (cell.value ?? 0).toLocaleString()));
        const note = doc.createElement('div');
        note.className = 'sfdt-note';
        // Salesforce documents this endpoint as approximate. Presenting it as
        // exact is how a number like this ends up in a migration plan.
        note.textContent = 'Approximate — Salesforce reports this figure lazily.';
        countSection.appendChild(note);
      }
      railPane.appendChild(countSection);

      // 3. Custom-field budget. This replaces the mockup's "Density Score":
      // that was a percentile with nothing behind it, and this is the same
      // shape of answer ("how full is this object?") computed from data that
      // actually exists. The ceiling is an edition constant, not org data —
      // hence the caveat line rather than a bare percentage.
      const budgetSection = railSection('Custom field budget', 'gauge');
      const pct = meta.customFieldCount / CUSTOM_FIELD_LIMIT;
      budgetSection.appendChild(
        kv('Custom fields', `${meta.customFieldCount} / ${CUSTOM_FIELD_LIMIT}`),
      );
      const meter = doc.createElement('div');
      meter.className = 'sfdt-meter';
      meter.setAttribute('aria-hidden', 'true');
      const fill = doc.createElement('i');
      fill.style.width = `${Math.round(Math.min(1, pct) * 100)}%`;
      // The threshold is policy and stays here; the colour is presentation and
      // lives in the sheet.
      fill.className = pct >= 0.85 ? 'sfdt-bad' : pct >= 0.6 ? 'sfdt-warn' : 'sfdt-ok';
      meter.appendChild(fill);
      budgetSection.appendChild(meter);
      const budgetNote = doc.createElement('div');
      budgetNote.className = 'sfdt-note';
      budgetNote.textContent =
        'Ceiling assumes Enterprise/Unlimited (500). Professional orgs cap at 100 — Salesforce does not expose the limit through the API.';
      budgetSection.appendChild(budgetNote);
      budgetSection.appendChild(kv('Total fields', String(meta.fieldCount)));
      railPane.appendChild(budgetSection);

      // 4. Audit — custom objects only, and it says so rather than showing dashes.
      const auditSection = railSection('Audit', 'history');
      if (!meta.custom) {
        const why = doc.createElement('div');
        why.className = 'sfdt-muted';
        why.textContent =
          'Standard objects carry no audit trail — Salesforce exposes created/modified only for custom objects.';
        auditSection.appendChild(why);
      } else {
        const auditCell = audits.get(selectedName);
        if (!auditCell || auditCell.status === 'loading') {
          auditSection.appendChild(kv('Created', 'Loading…'));
        } else if (auditCell.status === 'error') {
          const why = doc.createElement('div');
          why.className = 'sfdt-muted sfdt-msg';
          why.textContent = `Unavailable — ${auditCell.error ?? 'unknown error'}`;
          auditSection.appendChild(why);
        } else {
          const a = auditCell.value!;
          auditSection.appendChild(kv('Created by', a.createdBy));
          auditSection.appendChild(kv('Created', a.createdDate));
          auditSection.appendChild(kv('Modified by', a.modifiedBy));
          auditSection.appendChild(kv('Modified', a.modifiedDate));
        }
      }
      railPane.appendChild(auditSection);

      // 5. Relationship graph — the shared renderer from ui/node-graph.ts.
      const graphSection = railSection('Relationships', 'compare');
      const graphVM = buildObjectGraphVM(selectedName, vm);
      if (graphVM.nodes.size <= 1) {
        const none = doc.createElement('div');
        none.className = 'sfdt-muted';
        none.textContent = 'No lookups in or out of this object.';
        graphSection.appendChild(none);
      } else {
        const graphBox = doc.createElement('div');
        graphBox.className = 'sfdt-frame';
        graphBox.style.maxHeight = '200px';
        graphBox.appendChild(buildGraphSvg(graphVM));
        graphSection.appendChild(graphBox);

        // No silent caps (golden principle): a graph showing 12 of 63 children
        // reads as "this object has 12 children" unless it says otherwise.
        const dropped = graphVM.truncated.children + graphVM.truncated.parents;
        if (dropped > 0) {
          const note = doc.createElement('div');
          note.className = 'sfdt-note';
          note.textContent = `${dropped} more related object${dropped === 1 ? '' : 's'} not shown — open the full graph.`;
          graphSection.appendChild(note);
        }

        graphSection.appendChild(
          button({
            label: 'Expand graph',
            iconName: 'search',
            small: true,
            doc,
            onClick: () => openGraphModal(selectedName),
          }),
        );
      }
      railPane.appendChild(graphSection);
    }

    /**
     * The full-size relationship graph, in its own view.
     *
     * It owns its OWN root rather than following the browser's selection. The
     * version this replaces rendered once from a captured viewmodel, so clicking
     * a node updated the list behind the modal while the modal itself kept
     * showing the previous object's graph — the picture and the thing it
     * described silently diverged.
     *
     * Re-rooting also has to survive the describe being unloaded: the object
     * just clicked is usually NOT in the cache yet, so the view paints a loading
     * state and repaints from the cache subscription when the fetch lands.
     */
    function openGraphModal(initialRoot: string): void {
      let root = initialRoot;
      let painted: unknown;
      let unsubGraph: (() => void) | null = null;

      const graphBody = doc.createElement('div');
      graphBody.className = 'sfdt-view-main';

      const heading = doc.createElement('h2');
      heading.className = 'sfdt-subhead';

      const canvas = doc.createElement('div');
      graphBody.append(heading, canvas);

      function paint(): void {
        heading.textContent = `${root} relationships`;
        canvas.textContent = '';
        const entry = cache.getSObject('rest', root);
        painted = entry;
        if (entry.status === 'loading') {
          canvas.appendChild(loadingPanel(`Loading ${root}…`, doc));
          return;
        }
        if (entry.status === 'error' || !entry.data) {
          canvas.appendChild(
            renderSfError(
              entry.error ? `Could not load ${root} — ${entry.error}` : `Could not load ${root}.`,
              { doc },
            ),
          );
          return;
        }
        const gvm = buildObjectGraphVM(root, toFieldTableVM(entry.data));
        canvas.appendChild(
          buildNodeGraphSvg(doc, gvm, {
            nodeTitle: (node) =>
              node.id === root ? `${node.label} (this object)` : `${node.label}\nClick to re-centre`,
            onNodeClick: (node) => {
              if (node.id === root) return;
              root = node.id;
              // Keep the browser behind in sync, and — the part that matters —
              // this is also what asks the cache to fetch the new describe.
              doSelectObject(node.id);
              paint();
            },
          }),
        );
        const dropped = gvm.truncated.children + gvm.truncated.parents;
        if (dropped > 0) {
          const note = doc.createElement('div');
          note.className = 'sfdt-note';
          note.textContent = `${dropped} more related object${dropped === 1 ? '' : 's'} not shown.`;
          canvas.appendChild(note);
        }
      }

      presentView({
        title: 'Object relationships',
        iconName: 'compare',
        body: graphBody,
        doc,
        width: '1000px',
        onClose: () => {
          unsubGraph?.();
          unsubGraph = null;
        },
      });

      // Repaint only when THIS view's own entry changed — the shared cache
      // notifies on any describe resolving, including other tools' fetches.
      unsubGraph = cache.subscribe(() => {
        if (cache.getSObject('rest', root) !== painted) paint();
      });
      paint();
    }

    function buildGraphSvg(graphVM: ReturnType<typeof buildObjectGraphVM>): SVGSVGElement {
      return buildNodeGraphSvg(doc, graphVM, {
        nodeTitle: (node) =>
          node.id === selectedName
            ? `${node.label} (this object)`
            : `${node.label}\nClick to browse`,
        // Clicking a node navigates the browser, which is what makes the picture
        // a control rather than an illustration.
        onNodeClick: (node) => {
          if (node.id !== selectedName) void openFor(node.id);
        },
      });
    }

    function renderDetail(): void {
      while (detailScroll.firstChild) detailScroll.removeChild(detailScroll.firstChild);
      while (objectActions.firstChild) objectActions.removeChild(objectActions.firstChild);
      renderRail();

      if (!selectedName) {
        lastRenderedDetail = undefined;
        heading.textContent = '';
        fieldCountLine.textContent = '';
        detailScroll.appendChild(placeholder);
        return;
      }

      heading.textContent = selectedName;

      const describe = cache.getSObject('rest', selectedName);
      lastRenderedDetail = describe;
      if (describe.status === 'loading') {
        fieldCountLine.textContent = '';
        detailScroll.appendChild(loadingPanel('Loading fields…', doc));
        return;
      }
      if (describe.status === 'error' || !describe.data) {
        fieldCountLine.textContent = '';
        const err = renderSfError(
          describe.error
            ? `Failed to load object describe — ${describe.error}`
            : 'Failed to load object describe.',
          { doc },
        );

        detailScroll.appendChild(err);
        return;
      }

      const vm = toFieldTableVM(describe.data);
      fieldCountLine.textContent = `${vm.fields.length} field${vm.fields.length === 1 ? '' : 's'}`;

      // Field selection is the input to BOTH export and Generate SOQL, so the
      // set is initialised whenever either hook is wired.
      const wantsSelection = Boolean(exportForPrompt || runQueryInRunner);
      if (wantsSelection && !fieldSelection.has(selectedName)) {
        fieldSelection.set(selectedName, new Set(vm.fields.map((f) => f.name)));
      }
      if (wantsSelection) {
        detailScroll.appendChild(buildSelectionToolbar(vm.fields));
        objectActions.append(...buildObjectActions());
      }

      detailScroll.appendChild(buildFieldTable(vm.fields, wantsSelection));

      if (vm.childRelationships.length > 0) {
        const childHeading = doc.createElement('h3');
        childHeading.className = 'sfdt-section-title';
        childHeading.textContent = `Child Relationships (${vm.childRelationships.length})`;
        detailScroll.appendChild(childHeading);

        const childList = doc.createElement('ul');
        childList.className = 'sfdt-list';
        for (const child of vm.childRelationships) {
          const li = doc.createElement('li');
          li.appendChild(buildCrossLink(child.childSObject));
          const rel = doc.createElement('span');
          rel.textContent = child.relationshipName ? ` · ${child.relationshipName} (${child.field})` : ` · ${child.field}`;
          li.appendChild(rel);
          childList.appendChild(li);
        }
        detailScroll.appendChild(childList);
      }
    }

    // Header actions — whole-object operations, as opposed to the per-field ones
    // in each row and the selection controls above the table.
    function buildObjectActions(): HTMLElement[] {
      const out: HTMLElement[] = [];
      if (exportForPrompt || runQueryInRunner) {
        const exportBtn = button({
          label: 'Export schema',
          iconName: 'export',
          small: true,
          doc,
        });
        exportBtn.setAttribute('aria-haspopup', 'menu');
        // A menu, not a single action. It used to copy AI-oriented markdown to
        // the clipboard with no indication that was what it did or that any
        // other shape existed — the button named a noun and performed one
        // unadvertised verb.
        exportBtn.addEventListener('click', () => {
          const chosen = fieldSelection.get(selectedName);
          const n = chosen?.size ?? 0;
          openMenu({
            anchor: exportBtn,
            label: `Export ${selectedName} schema`,
            doc,
            win,
            items: [
              {
                label: `Copy for AI — Markdown (${n} field${n === 1 ? '' : 's'})`,
                iconName: 'sparkle',
                onSelect: () => exportSelection(),
              },
              {
                label: 'Copy as JSON',
                iconName: 'clipboard',
                onSelect: () => void copyExport('json'),
              },
              {
                label: 'Copy as CSV',
                iconName: 'table',
                onSelect: () => void copyExport('csv'),
              },
              {
                label: 'Download JSON',
                iconName: 'export',
                separatorBefore: true,
                onSelect: () => downloadExport('json'),
              },
              {
                label: 'Download CSV',
                iconName: 'export',
                onSelect: () => downloadExport('csv'),
              },
            ],
          });
        });
        out.push(exportBtn);
      }
      if (runQueryInRunner) {
        out.push(
          button({
            label: 'Generate SOQL',
            iconName: 'soql-runner',
            variant: 'primary',
            small: true,
            doc,
            onClick: () => {
              const chosen = fieldSelection.get(selectedName);
              if (!chosen || chosen.size === 0) {
                showToast('Select at least one field to build a query.', { doc, kind: 'warning' });
                return;
              }
              // Describe order, not Set-insertion order: the query should read
              // like the table above it, and a Set preserves whatever order the
              // user happened to click checkboxes in.
              const describe = cache.getSObject('rest', selectedName);
              const ordered = describe.data
                ? toFieldTableVM(describe.data)
                    .fields.map((f) => f.name)
                    .filter((n) => chosen.has(n))
                : [...chosen];
              void runQueryInRunner(buildSelectQuery(selectedName, ordered));
              showToast(`Staged a query for ${selectedName}`, { doc, kind: 'success' });
            },
          }),
        );
      }
      return out;
    }

    /**
     * The selected fields as text, in describe order.
     *
     * Order comes from the describe rather than the selection Set, for the same
     * reason "Generate SOQL" does it: a Set preserves click order, and an export
     * whose rows are in the order the user happened to tick boxes is not the
     * table they were looking at.
     */
    function exportText(format: 'json' | 'csv'): string | null {
      const describe = cache.getSObject('rest', selectedName);
      if (!describe.data) return null;
      const chosen = fieldSelection.get(selectedName);
      const fields = toFieldTableVM(describe.data).fields.filter(
        (f) => !chosen || chosen.has(f.name),
      );
      if (fields.length === 0) return null;
      const rows = toExportRows(fields);
      return format === 'json' ? recordsToJson(rows) : recordsToCsv(rows);
    }

    async function copyExport(format: 'json' | 'csv'): Promise<void> {
      const text = exportText(format);
      if (!text) {
        showToast('Select at least one field to export.', { doc, kind: 'warning' });
        return;
      }
      try {
        await copyToClipboard(text, { doc, win, label: `${selectedName} schema as ${format.toUpperCase()}` });
        showToast(`${selectedName} schema copied as ${format.toUpperCase()}`, {
          doc,
          kind: 'success',
        });
      } catch {
        showToast('Could not copy to clipboard', { doc, kind: 'error' });
      }
    }

    function downloadExport(format: 'json' | 'csv'): void {
      const text = exportText(format);
      if (!text) {
        showToast('Select at least one field to export.', { doc, kind: 'warning' });
        return;
      }
      triggerDownload(
        doc,
        exportFilename(`${selectedName}-schema`, format),
        text,
        format === 'json' ? 'application/json' : 'text/csv',
      );
      showToast(`Downloaded ${selectedName} schema`, { doc, kind: 'success' });
    }

    function exportSelection(): void {
      const chosen = fieldSelection.get(selectedName);
      if (!chosen || chosen.size === 0) {
        showToast('Select at least one field to export.', { doc, kind: 'warning' });
        return;
      }
      void exportForPrompt!(selectedName, [...chosen]);
    }

    // Select-all / clear-all + "Export selected for prompt". Mutating a selection
    // re-renders the detail so the row checkboxes reflect the new state.
    function buildSelectionToolbar(fields: FieldRow[]): HTMLElement {
      const bar = toolbar(doc);

      const selected = fieldSelection.get(selectedName)!;
      const count = doc.createElement('span');
      count.setAttribute('aria-live', 'polite');
      count.className = 'sfdt-muted sfdt-toolbar-end';
      count.textContent = `${selected.size} of ${fields.length} fields selected`;

      bar.append(
        button({
          label: 'Select all',
          small: true,
          doc,
          onClick: () => {
            fieldSelection.set(selectedName, new Set(fields.map((f) => f.name)));
            renderDetail();
          },
        }),
        button({
          label: 'Clear all',
          small: true,
          doc,
          onClick: () => {
            fieldSelection.set(selectedName, new Set());
            renderDetail();
          },
        }),
      );
      if (exportForPrompt) {
        bar.appendChild(
          button({
            label: 'Export selected for prompt',
            iconName: 'clipboard',
            variant: 'primary',
            small: true,
            doc,
            onClick: () => exportSelection(),
          }),
        );
      }
      bar.appendChild(count);
      return bar;
    }

    function buildFieldTable(fields: FieldRow[], withSelection: boolean): HTMLElement {
      const table = doc.createElement('table');
      table.className = 'sfdt-table sfdt-align-top';

      const thead = doc.createElement('thead');
      const headRow = doc.createElement('tr');
      const headers = withSelection
        ? ['', 'Label', 'API Name', 'Type', 'Len', 'Req', 'Unq', 'Ext', 'Help Text', 'Details', '']
        : ['Label', 'API Name', 'Type', 'Len', 'Req', 'Unq', 'Ext', 'Help Text', 'Details', ''];
      for (const h of headers) {
        const th = doc.createElement('th');
        th.scope = 'col';
        th.textContent = h;
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      table.appendChild(thead);

      const tbody = doc.createElement('tbody');
      for (const field of fields) {
        tbody.appendChild(buildFieldRow(field, withSelection));
      }
      table.appendChild(tbody);
      return table;
    }

    // A boolean flag column. An UNSET flag renders as an empty cell rather than
    // a "no" glyph: three columns of negative marks is visual noise, and empty
    // already reads as false. When it IS set the glyph carries no text, so the
    // meaning rides on a visually-hidden label — otherwise a screen reader gets
    // an empty cell either way and the column is decorative.
    function flagCell(on: boolean, label: string): HTMLTableCellElement {
      const td = doc.createElement('td');
      td.className = 'sfdt-center';
      if (!on) return td;
      td.appendChild(glyph('check', 14, doc));
      const sr = doc.createElement('span');
      sr.className = 'sfdt-sr';
      sr.textContent = label;
      td.appendChild(sr);
      return td;
    }

    function buildFieldRow(field: FieldRow, withSelection: boolean): HTMLElement {
      const tr = doc.createElement('tr');

      // Leading selection checkbox. Pre-checked; unchecking drops the field from
      // the exported subset and the generated query for this object.
      let tdSelect: HTMLTableCellElement | null = null;
      if (withSelection) {
        tdSelect = doc.createElement('td');
        tdSelect.className = 'sfdt-center';
        const cb = doc.createElement('input');
        cb.type = 'checkbox';
        const selected = fieldSelection.get(selectedName)!;
        cb.checked = selected.has(field.name);
        cb.setAttribute('aria-label', `Select field ${field.name} for export`);
        cb.addEventListener('change', () => {
          if (cb.checked) selected.add(field.name);
          else selected.delete(field.name);
        });
        tdSelect.appendChild(cb);
      }

      const tdLabel = doc.createElement('td');
      tdLabel.textContent = field.label;

      const tdApi = doc.createElement('td');
      tdApi.className = 'sfdt-cell-code';
      tdApi.textContent = field.name;

      const tdType = doc.createElement('td');
      const typePill = doc.createElement('span');
      typePill.className = 'sfdt-pill sfdt-square';
      typePill.textContent = typeDisplay(field);
      tdType.appendChild(typePill);

      const tdLength = doc.createElement('td');
      tdLength.className = 'sfdt-cell-code';
      tdLength.textContent = typeof field.length === 'number' && field.length > 0 ? String(field.length) : '';

      // `nillable` is the describe's spelling of "optional", so Required is its
      // negation — the one flag column that is not a straight read.
      const tdRequired = flagCell(!field.nillable, 'Required');
      const tdUnique = flagCell(field.unique, 'Unique');
      const tdExternal = flagCell(field.externalId, 'External Id');

      const tdHelp = doc.createElement('td');
      tdHelp.className = 'sfdt-muted sfdt-cell-clip';
      tdHelp.textContent = field.helpText;
      if (field.helpText) tdHelp.title = field.helpText;

      // Details cell: reference cross-links, picklist expander, formula source,
      // and compound-component listing.
      const tdDetails = doc.createElement('td');
      tdDetails.className = 'sfdt-muted';
      appendFieldDetails(tdDetails, field);

      // Quick actions cell: Copy API name, plus "Insert into query" when the SOQL
      // Runner hook is wired (PR-3).
      const tdActions = doc.createElement('td');
      tdActions.className = 'sfdt-nowrap';
      const actionWrap = doc.createElement('div');
      actionWrap.className = 'sfdt-row';
      tdActions.appendChild(actionWrap);

      actionWrap.appendChild(
        button({
          label: 'Copy',
          small: true,
          title: `Copy API name (${field.name})`,
          ariaLabel: `Copy API name ${field.name}`,
          doc,
          onClick: () => {
            void (async () => {
              await copyToClipboard(field.name, { doc, win: win, label: `${field.name}` });
            })();
          },
        }),
      );

      if (insertField) {
        actionWrap.appendChild(
          button({
            label: 'Insert into query',
            small: true,
            title: `Insert ${field.name} into the SOQL Runner draft`,
            ariaLabel: `Insert field ${field.name} into query`,
            doc,
            onClick: () => {
              insertField(field.name);
              showToast(`Inserted ${field.name} into query`, { doc, kind: 'success' });
            },
          }),
        );
      }

      // P4-4 entry point: hand the field to Field Impact Analysis. The analysis
      // itself lives in features/field-impact.ts (flow-core does the Flow
      // parsing) — the Schema Browser only launches it.
      if (analyzeFieldImpact) {
        actionWrap.appendChild(
          button({
            label: 'What writes this?',
            small: true,
            title: `Find what writes ${selectedName}.${field.name}`,
            ariaLabel: `What writes field ${field.name} on ${selectedName}?`,
            doc,
            onClick: () => {
              void analyzeFieldImpact(selectedName, field.name);
            },
          }),
        );
      }

      const cells = [
        tdLabel,
        tdApi,
        tdType,
        tdLength,
        tdRequired,
        tdUnique,
        tdExternal,
        tdHelp,
        tdDetails,
        tdActions,
      ];
      if (tdSelect) cells.unshift(tdSelect);
      tr.append(...cells);
      return tr;
    }

    function appendFieldDetails(cell: HTMLElement, field: FieldRow): void {
      // Reference targets → clickable cross-links that navigate the tool.
      if (field.referenceTo && field.referenceTo.length > 0) {
        const wrap = doc.createElement('div');
        wrap.appendChild(doc.createTextNode('→ '));
        field.referenceTo.forEach((target, i) => {
          if (i > 0) wrap.appendChild(doc.createTextNode(', '));
          wrap.appendChild(buildCrossLink(target));
        });
        cell.appendChild(wrap);
      }

      // Picklist values — expand inline on demand.
      if (field.picklistValues && field.picklistValues.length > 0) {
        const values = field.picklistValues;
        const toggle = button({
          label: `Picklist (${values.length})`,
          variant: 'ghost',
          small: true,
          doc,
        });
        toggle.setAttribute('aria-expanded', 'false');
        const valuesList = doc.createElement('div');
        valuesList.className = 'sfdt-mono sfdt-list';
        valuesList.style.display = 'none';
        valuesList.textContent = values.join(', ');
        toggle.addEventListener('click', () => {
          const isOpen = valuesList.style.display === 'none';
          valuesList.style.display = isOpen ? 'block' : 'none';
          toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        });
        cell.appendChild(toggle);
        cell.appendChild(valuesList);
      }

      // Formula source.
      if (field.formula) {
        const formula = doc.createElement('div');
        formula.className = 'sfdt-mono sfdt-msg';
        formula.textContent = `ƒ ${field.formula}`;
        cell.appendChild(formula);
      }

      // Compound components (address/geolocation parent).
      if (field.components && field.components.length > 0) {
        const comp = doc.createElement('div');
        comp.textContent = `Components: ${field.components.join(', ')}`;
        cell.appendChild(comp);
      }
    }

    // Expose the selector for openFor / cache updates.
    selectObject = doSelectObject;

    // Re-render a pane only when its OWN cache entry changed. The shared cache
    // notifies on ANY describe resolving (incl. other tools' unrelated fetches),
    // so an unconditional rebuild would discard visible state — e.g. an expanded
    // picklist collapsing when SOQL Runner describes a different object.
    unsubscribe = cache.subscribe(() => {
      if (cache.getGlobal('rest') !== lastRenderedGlobal) renderList();
      if (selectedName && cache.getSObject('rest', selectedName) !== lastRenderedDetail) {
        renderDetail();
        const ready = cache.getSObject('rest', selectedName);
        if (ready.status === 'ready' && ready.data) {
          ensureRecordCount(selectedName);
          ensureAudit(selectedName, toObjectMetaVM(ready.data));
        }
      }
    });

    renderList();
    if (initialSobject) {
      doSelectObject(initialSobject);
      const ready = cache.getSObject('rest', initialSobject);
      if (ready.status === 'ready' && ready.data) {
        ensureRecordCount(initialSobject);
        ensureAudit(initialSobject, toObjectMetaVM(ready.data));
      }
    }

    // Esc and the focus trap are NOT wired here. ui/present-view.ts owns both,
    // and it checks that this overlay is the topmost one before acting. The
    // capture-phase document listener that used to live here skipped that check,
    // so an Escape meant for a dialog opened ON TOP of this view closed this one
    // too — third instance of that bug in this codebase.

    filterInput.focus();
  }

  async function openFor(sobjectName: string): Promise<void> {
    if (view && selectObject) {
      selectObject(sobjectName);
      return;
    }
    open(sobjectName);
  }

  return {
    manifest: {
      id: 'schema-browser',
      name: 'Schema Browser',
      contexts: [CONTEXTS.RECORD_PAGE, CONTEXTS.SETUP_OTHER, CONTEXTS.WORKSPACE],
    },

    async onActivate() {
      const ctx = extractRecordContext(win.location.href);
      if (ctx?.sobjectName) {
        await openFor(ctx.sobjectName);
      } else {
        open();
      }
    },

    openFor,
  };
}
