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
  type ObjectListItem,
  type FieldRow,
} from '../lib/schema-viewmodel.js';
import { presentView, inWorkspace, type ViewHandle } from '../ui/present-view.js';
import { showToast } from '../ui/toast.js';

// Object-list windowing: render at most PAGE rows up front and extend by PAGE as
// the user scrolls (or when a filter narrows the set to ≤ PAGE). An 800+ object
// org therefore never builds an unbounded DOM. No virtualization library — the
// windowing is a plain slice + scroll handler.
const PAGE = 50;

export interface SchemaBrowserOptions {
  doc?: Document;
  win?: Window;
  api?: SalesforceApiClient;
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

  let view: ViewHandle | null = null;
  let escHandler: ((e: KeyboardEvent) => void) | null = null;
  let trapHandler: ((e: KeyboardEvent) => void) | null = null;
  let unsubscribe: (() => void) | null = null;
  let previouslyFocused: Element | null = null;

  // View-scoped renderers, wired up in open(). openFor() calls selectObject when
  // a view is already mounted so cross-links navigate in place.
  let selectObject: ((name: string) => void) | null = null;

  function teardown(): void {
    if (escHandler) {
      doc.removeEventListener('keydown', escHandler, true);
      escHandler = null;
    }
    if (trapHandler && view) {
      view.root.removeEventListener('keydown', trapHandler, true);
    }
    trapHandler = null;
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
    body.style.cssText =
      'display: flex; flex: 1; min-height: 0; height: 60vh; font-size: 13px;';

    // --- Left pane: filter box + windowed object list ---
    const leftPane = doc.createElement('div');
    leftPane.style.cssText =
      'display: flex; flex-direction: column; width: 300px; border-right: 1px solid var(--sfdt-color-border); min-height: 0;';

    const filterWrap = doc.createElement('div');
    filterWrap.style.cssText = 'padding: 10px; border-bottom: 1px solid var(--sfdt-color-border);';
    const filterLabel = doc.createElement('label');
    filterLabel.textContent = 'Filter objects';
    filterLabel.style.cssText = 'display: block; font-size: 11px; color: var(--sfdt-color-text-weak); margin-bottom: 4px;';
    const filterInput = doc.createElement('input');
    filterInput.type = 'text';
    filterInput.id = 'sfdt-schema-object-filter';
    filterInput.placeholder = 'Search by label or API name…';
    filterInput.setAttribute('aria-label', 'Filter objects by label or API name');
    filterInput.setAttribute('autocomplete', 'off');
    filterInput.setAttribute('spellcheck', 'false');
    filterInput.style.cssText =
      'width: 100%; padding: 6px 8px; border: 1px solid var(--sfdt-color-border); border-radius: 4px; font-size: 13px; outline: none; box-sizing: border-box;';
    filterLabel.setAttribute('for', filterInput.id);
    filterWrap.appendChild(filterLabel);
    filterWrap.appendChild(filterInput);
    leftPane.appendChild(filterWrap);

    const countLabel = doc.createElement('div');
    countLabel.setAttribute('aria-live', 'polite');
    countLabel.style.cssText = 'padding: 4px 10px; font-size: 11px; color: var(--sfdt-color-text-weak);';
    leftPane.appendChild(countLabel);

    const listScroll = doc.createElement('div');
    listScroll.setAttribute('role', 'listbox');
    listScroll.setAttribute('aria-label', 'Salesforce objects');
    listScroll.style.cssText = 'flex: 1; overflow-y: auto; min-height: 0;';
    leftPane.appendChild(listScroll);

    // --- Right pane: object detail (field table + child relationships) ---
    const rightPane = doc.createElement('div');
    rightPane.style.cssText = 'flex: 1; overflow: auto; min-height: 0; padding: 12px 16px;';
    const placeholder = doc.createElement('div');
    placeholder.textContent = 'Select an object to view its fields.';
    placeholder.style.cssText = 'color: var(--sfdt-color-text-weak); padding: 24px 0;';
    rightPane.appendChild(placeholder);

    body.appendChild(leftPane);
    body.appendChild(rightPane);

    view = presentView({
      title: '🗃 Schema Browser',
      body,
      doc,
      width: '1000px',
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

    function matchesFilter(item: ObjectListItem, term: string): boolean {
      if (!term) return true;
      return (
        item.name.toLowerCase().includes(term) ||
        (item.label ?? '').toLowerCase().includes(term)
      );
    }

    function renderList(): void {
      const global = cache.getGlobal('rest');
      while (listScroll.firstChild) listScroll.removeChild(listScroll.firstChild);

      if (global.status === 'loading') {
        countLabel.textContent = 'Loading objects…';
        return;
      }
      if (global.status === 'error' || !global.data) {
        countLabel.textContent = 'Failed to load objects.';
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

      for (const item of shown) {
        listScroll.appendChild(buildObjectRow(item, item.name === selectedName));
      }
    }

    function buildObjectRow(item: ObjectListItem, active: boolean): HTMLElement {
      const row = doc.createElement('button');
      row.type = 'button';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', active ? 'true' : 'false');
      row.style.cssText = `display: block; width: 100%; text-align: left; padding: 6px 10px; border: 0; border-bottom: 1px solid var(--sfdt-color-bg); cursor: pointer; font-size: 13px; background: ${active ? 'var(--sfdt-color-surface-alt)' : 'transparent'}; color: var(--sfdt-color-text);`;
      const labelSpan = doc.createElement('span');
      labelSpan.textContent = item.label || item.name;
      labelSpan.style.cssText = 'font-weight: 600; color: var(--sfdt-color-text-strong);';
      const apiSpan = doc.createElement('span');
      apiSpan.textContent = item.name;
      apiSpan.style.cssText = 'display: block; font-family: ui-monospace, monospace; font-size: 11px; color: var(--sfdt-color-text-weak);';
      row.appendChild(labelSpan);
      row.appendChild(apiSpan);
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

    // --- Right-pane render ---
    function doSelectObject(name: string): void {
      selectedName = name;
      // Reflect selection in the (possibly re-rendered) list.
      renderList();
      renderDetail();
    }

    // A cross-link to another object — reused by reference-target fields and the
    // child-relationship list (keeps the two from drifting).
    function buildCrossLink(name: string): HTMLAnchorElement {
      const link = doc.createElement('a');
      link.href = '#';
      link.textContent = name;
      link.setAttribute('role', 'link');
      link.style.cssText = 'color: var(--sfdt-color-brand-text); text-decoration: underline; cursor: pointer;';
      link.addEventListener('click', (e) => {
        e.preventDefault();
        void openFor(name);
      });
      return link;
    }

    function renderDetail(): void {
      while (rightPane.firstChild) rightPane.removeChild(rightPane.firstChild);
      if (!selectedName) {
        rightPane.appendChild(placeholder);
        return;
      }

      const heading = doc.createElement('h2');
      heading.textContent = selectedName;
      heading.style.cssText = 'margin: 0 0 12px; font-size: 16px; color: var(--sfdt-color-text-strong);';
      rightPane.appendChild(heading);

      const describe = cache.getSObject('rest', selectedName);
      if (describe.status === 'loading') {
        const loading = doc.createElement('div');
        loading.textContent = 'Loading fields…';
        loading.style.cssText = 'color: var(--sfdt-color-text-weak);';
        rightPane.appendChild(loading);
        return;
      }
      if (describe.status === 'error' || !describe.data) {
        const err = doc.createElement('div');
        err.textContent = 'Failed to load object describe.';
        err.style.cssText = 'color: var(--sfdt-color-error);';
        rightPane.appendChild(err);
        return;
      }

      const vm = toFieldTableVM(describe.data);
      rightPane.appendChild(buildFieldTable(vm.fields));

      if (vm.childRelationships.length > 0) {
        const childHeading = doc.createElement('h3');
        childHeading.textContent = `Child Relationships (${vm.childRelationships.length})`;
        childHeading.style.cssText = 'margin: 20px 0 8px; font-size: 14px; color: var(--sfdt-color-text-strong);';
        rightPane.appendChild(childHeading);

        const childList = doc.createElement('ul');
        childList.style.cssText = 'margin: 0; padding-left: 18px; color: var(--sfdt-color-text-weak);';
        for (const child of vm.childRelationships) {
          const li = doc.createElement('li');
          li.style.cssText = 'margin-bottom: 4px;';
          li.appendChild(buildCrossLink(child.childSObject));
          const rel = doc.createElement('span');
          rel.textContent = child.relationshipName ? ` · ${child.relationshipName} (${child.field})` : ` · ${child.field}`;
          li.appendChild(rel);
          childList.appendChild(li);
        }
        rightPane.appendChild(childList);
      }
    }

    function buildFieldTable(fields: FieldRow[]): HTMLElement {
      const table = doc.createElement('table');
      table.style.cssText = 'width: 100%; border-collapse: collapse; font-size: 12px; text-align: left;';

      const thead = doc.createElement('thead');
      const headRow = doc.createElement('tr');
      for (const h of ['Label', 'API Name', 'Type', 'Length', 'Required', 'Details', '']) {
        const th = doc.createElement('th');
        th.textContent = h;
        th.style.cssText = 'padding: 6px 8px; background: var(--sfdt-color-surface-alt); border-bottom: 1px solid var(--sfdt-color-border); font-weight: 600; position: sticky; top: 0; color: var(--sfdt-color-text-strong);';
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      table.appendChild(thead);

      const tbody = doc.createElement('tbody');
      for (const field of fields) {
        tbody.appendChild(buildFieldRow(field));
      }
      table.appendChild(tbody);
      return table;
    }

    function buildFieldRow(field: FieldRow): HTMLElement {
      const tr = doc.createElement('tr');
      tr.style.cssText = 'border-bottom: 1px solid var(--sfdt-color-bg); vertical-align: top;';

      const tdLabel = doc.createElement('td');
      tdLabel.textContent = field.label;
      tdLabel.style.cssText = 'padding: 6px 8px; color: var(--sfdt-color-text-strong);';

      const tdApi = doc.createElement('td');
      tdApi.textContent = field.name;
      tdApi.style.cssText = 'padding: 6px 8px; font-family: ui-monospace, monospace; color: var(--sfdt-color-text-weak);';

      const tdType = doc.createElement('td');
      tdType.textContent = field.type;
      tdType.style.cssText = 'padding: 6px 8px; color: var(--sfdt-color-text-weak);';

      const tdLength = doc.createElement('td');
      tdLength.textContent = typeof field.length === 'number' && field.length > 0 ? String(field.length) : '';
      tdLength.style.cssText = 'padding: 6px 8px; color: var(--sfdt-color-text-weak);';

      const tdRequired = doc.createElement('td');
      tdRequired.textContent = field.nillable ? '' : '✔';
      tdRequired.setAttribute('aria-label', field.nillable ? 'Not required' : 'Required');
      tdRequired.style.cssText = 'padding: 6px 8px; color: var(--sfdt-color-text-weak); text-align: center;';

      // Details cell: reference cross-links, picklist expander, formula source,
      // and compound-component listing.
      const tdDetails = doc.createElement('td');
      tdDetails.style.cssText = 'padding: 6px 8px; color: var(--sfdt-color-text-weak);';
      appendFieldDetails(tdDetails, field);

      // Quick actions cell (PR-2: Copy API name only).
      const tdActions = doc.createElement('td');
      tdActions.style.cssText = 'padding: 6px 8px; white-space: nowrap;';
      const copyBtn = doc.createElement('button');
      copyBtn.type = 'button';
      copyBtn.textContent = 'Copy';
      copyBtn.title = `Copy API name (${field.name})`;
      copyBtn.setAttribute('aria-label', `Copy API name ${field.name}`);
      copyBtn.style.cssText = 'padding: 3px 8px; border: 1px solid var(--sfdt-color-border); background: var(--sfdt-color-surface); color: var(--sfdt-color-text-weak); border-radius: 4px; cursor: pointer; font-size: 11px;';
      copyBtn.addEventListener('click', async () => {
        try {
          await win.navigator.clipboard.writeText(field.name);
          showToast(`Copied ${field.name}`, { doc, kind: 'success' });
        } catch {
          showToast('Could not copy to clipboard', { doc, kind: 'error' });
        }
      });
      tdActions.appendChild(copyBtn);

      tr.append(tdLabel, tdApi, tdType, tdLength, tdRequired, tdDetails, tdActions);
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
        const toggle = doc.createElement('button');
        toggle.type = 'button';
        toggle.textContent = `Picklist (${values.length})`;
        toggle.setAttribute('aria-expanded', 'false');
        toggle.style.cssText = 'display: block; padding: 2px 0; border: 0; background: none; color: var(--sfdt-color-brand-text); cursor: pointer; font-size: 12px; text-decoration: underline;';
        const valuesList = doc.createElement('div');
        valuesList.style.cssText = 'display: none; margin: 2px 0 0; padding-left: 8px; font-family: ui-monospace, monospace; font-size: 11px;';
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
        formula.textContent = `ƒ ${field.formula}`;
        formula.style.cssText = 'font-family: ui-monospace, monospace; font-size: 11px; color: var(--sfdt-color-text-weak); white-space: pre-wrap; word-break: break-word;';
        cell.appendChild(formula);
      }

      // Compound components (address/geolocation parent).
      if (field.components && field.components.length > 0) {
        const comp = doc.createElement('div');
        comp.textContent = `Components: ${field.components.join(', ')}`;
        comp.style.cssText = 'font-size: 11px; color: var(--sfdt-color-text-weak);';
        cell.appendChild(comp);
      }
    }

    // Expose the selector for openFor / cache updates.
    selectObject = doSelectObject;

    // Re-render both panes when an async describe resolves.
    unsubscribe = cache.subscribe(() => {
      renderList();
      if (selectedName) renderDetail();
    });

    renderList();
    if (initialSobject) doSelectObject(initialSobject);

    // --- A11y: Esc closes (capture phase, removed on close); focus trap in modal
    // mode only (a Workspace tab pane is a persistent surface, not a trap). ---
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
