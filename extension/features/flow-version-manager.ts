// Flow Version Manager — port of
// /Users/dkennedy/dev/2.0.2_0 copy/features/flow-version-manager.js.
//
// Adds row checkboxes and a "Delete Selected Versions" toolbar button to the
// classic Flow Details / Versions page. v2.0.2 also implemented a
// sessionStorage-based queue so navigations between deletes resumed
// automatically; this port keeps the same surface but simplifies to a
// straight loop with the user-facing modal confirming bulk action.

import type { Feature } from '../lib/feature-registry.js';
import { CONTEXTS } from '../lib/context-detector.js';

const SELECTORS = {
  versionsTable: 'table.list[id="view:lists:versions"]',
  rows: 'tbody[id="view:lists:versions:tb"] > tr.dataRow',
  headerRow: 'table.list[id="view:lists:versions"] > thead > tr.headerRow',
  headerCells: 'th.headerRow',
  bodyCells: 'td.dataCell',
  buttonBar: 'td[id="view:form:thePageBlock:pageBlockButtons"]',
  deleteLink: 'a[id$=":deleteLink"]',
};

const TAB_CLASS = 'sfut-version-select-cell';
const CHECKBOX_CLASS = 'sfut-version-select-checkbox';
const DELETE_BTN_CLASS = 'sfut-version-manager-delete-btn';

interface RowMeta {
  row: HTMLTableRowElement;
  versionId: string;
  versionLabel: string;
  status: string;
  canDelete: boolean;
  deleteLink: HTMLAnchorElement | null;
}

function extractRowMeta(row: HTMLTableRowElement): RowMeta | null {
  const cells = Array.from(row.querySelectorAll<HTMLTableCellElement>(SELECTORS.bodyCells));
  if (cells.length === 0) return null;
  const flowLabel = (cells[1]?.textContent ?? '').replace(/\s+/g, ' ').trim() || 'Unknown';
  const versionMatch = (cells[2]?.textContent ?? '').match(/\d+/);
  const versionNumber = versionMatch ? versionMatch[0] : '';
  const status = ((cells[7]?.textContent ?? '').replace(/\s+/g, ' ').trim() || 'unknown').toLowerCase();
  const deleteLink = row.querySelector<HTMLAnchorElement>(SELECTORS.deleteLink);
  const canDelete = !!deleteLink && status !== 'active';

  const onclick = deleteLink?.getAttribute('onclick') ?? '';
  const idMatch = onclick.match(/currVersionId,([0-9A-Za-z]{15,18})/);
  const versionId = idMatch ? idMatch[1]! : `${flowLabel}::${versionNumber}::${status}`;

  return {
    row,
    versionId,
    versionLabel: versionNumber ? `Version ${versionNumber}` : flowLabel,
    status,
    canDelete,
    deleteLink,
  };
}

function injectCheckboxColumn(doc: Document, table: Element): void {
  if (table.querySelector(`.${TAB_CLASS}`)) return;
  const headerRow = table.querySelector(SELECTORS.headerRow);
  if (!headerRow) return;
  const firstHeader = headerRow.querySelector(SELECTORS.headerCells);
  if (!firstHeader) return;
  const th = doc.createElement('th');
  th.className = `headerRow ${TAB_CLASS}`;
  th.setAttribute('scope', 'col');
  const inner = doc.createElement('div');
  const sr = doc.createElement('span');
  sr.className = 'slds-assistive-text';
  sr.textContent = 'Select versions';
  inner.appendChild(sr);
  th.appendChild(inner);
  headerRow.insertBefore(th, firstHeader);
}

async function confirmModal(doc: Document, selected: RowMeta[]): Promise<boolean> {
  return new Promise((resolve) => {
    const backdrop = doc.createElement('div');
    backdrop.className = 'sfut-version-manager-backdrop';
    backdrop.style.cssText =
      'position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 100020; display: flex; align-items: center; justify-content: center;';

    const modal = doc.createElement('div');
    modal.className = 'sfut-version-manager-modal';
    modal.setAttribute('role', 'dialog');
    modal.style.cssText =
      'background: #fff; border-radius: 4px; padding: 16px; min-width: 360px; max-width: 480px; font-family: system-ui, sans-serif;';

    const title = doc.createElement('h2');
    title.textContent = 'Delete Selected Versions';
    title.style.cssText = 'margin: 0 0 8px; font-size: 16px;';
    modal.appendChild(title);

    const intro = doc.createElement('p');
    intro.style.cssText = 'margin: 0 0 8px; font-size: 13px;';
    intro.textContent =
      'Type DELETE to confirm. Active versions cannot be deleted; interviews in progress may fail.';
    modal.appendChild(intro);

    const list = doc.createElement('ul');
    list.style.cssText = 'max-height: 120px; overflow: auto; font-size: 12px; margin: 8px 0;';
    for (const s of selected) {
      const li = doc.createElement('li');
      li.textContent = `${s.versionLabel} — ${s.status}`;
      list.appendChild(li);
    }
    modal.appendChild(list);

    const input = doc.createElement('input');
    input.type = 'text';
    input.placeholder = 'DELETE';
    input.autocomplete = 'off';
    input.style.cssText = 'width: 100%; padding: 6px; margin: 8px 0;';
    modal.appendChild(input);

    const footer = doc.createElement('div');
    footer.style.cssText = 'display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px;';
    const cancel = doc.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.style.cssText = 'padding: 6px 12px;';
    const confirm = doc.createElement('button');
    confirm.type = 'button';
    confirm.textContent = 'Delete Selected Versions';
    confirm.disabled = true;
    confirm.style.cssText = 'padding: 6px 12px; background: #c23934; color: #fff; border: 0;';
    footer.appendChild(cancel);
    footer.appendChild(confirm);
    modal.appendChild(footer);

    const cleanup = (result: boolean) => {
      backdrop.remove();
      resolve(result);
    };
    cancel.addEventListener('click', () => cleanup(false));
    confirm.addEventListener('click', () => {
      if (!confirm.disabled) cleanup(true);
    });
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) cleanup(false);
    });
    input.addEventListener('input', () => {
      confirm.disabled = input.value.trim() !== 'DELETE';
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') cleanup(false);
      else if (e.key === 'Enter' && !confirm.disabled) cleanup(true);
    });

    backdrop.appendChild(modal);
    doc.body.appendChild(backdrop);
    setTimeout(() => input.focus(), 0);
  });
}

export interface FlowVersionManagerOptions {
  doc?: Document;
  win?: Window;
}

export function createFlowVersionManagerFeature(
  options: FlowVersionManagerOptions = {},
): Feature {
  const doc = options.doc ?? document;
  const win = options.win ?? window;

  const selected = new Set<string>();
  const rowMap = new Map<string, RowMeta>();
  let toolbarBtn: HTMLInputElement | null = null;
  let observer: MutationObserver | null = null;

  function updateToolbar(): void {
    if (!toolbarBtn) return;
    const count = selected.size;
    toolbarBtn.disabled = count === 0;
    toolbarBtn.value =
      count > 0 ? `Delete Selected Versions (${count})` : 'Delete Selected Versions';
    toolbarBtn.className = toolbarBtn.disabled
      ? `btnDisabled ${DELETE_BTN_CLASS}`
      : `btn ${DELETE_BTN_CLASS}`;
  }

  function decorateRows(table: Element): void {
    const rows = table.querySelectorAll<HTMLTableRowElement>(SELECTORS.rows);
    for (const row of rows) {
      const meta = extractRowMeta(row);
      if (!meta) continue;
      rowMap.set(meta.versionId, meta);
      if (row.querySelector(`.${TAB_CLASS}`)) continue;
      const firstCell = row.querySelector(SELECTORS.bodyCells);
      if (!firstCell) continue;

      const cell = doc.createElement('td');
      cell.className = `dataCell ${TAB_CLASS}`;
      const checkbox = doc.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = CHECKBOX_CLASS;
      checkbox.disabled = !meta.canDelete;
      checkbox.title = meta.canDelete ? `Select ${meta.versionLabel}` : 'Active versions cannot be deleted';
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selected.add(meta.versionId);
        else selected.delete(meta.versionId);
        updateToolbar();
      });
      cell.appendChild(checkbox);
      row.insertBefore(cell, firstCell);
    }
  }

  async function handleBulkDelete(): Promise<void> {
    const items = Array.from(selected)
      .map((id) => rowMap.get(id))
      .filter((m): m is RowMeta => !!m && !!m.deleteLink);
    if (items.length === 0) return;
    const confirmed = await confirmModal(doc, items);
    if (!confirmed) return;

    // Bypass native confirm() dialogs while clicking each delete link in turn.
    const origConfirm = win.confirm;
    win.confirm = () => true;
    try {
      for (const item of items) {
        item.deleteLink?.click();
      }
    } finally {
      setTimeout(() => {
        win.confirm = origConfirm;
      }, 1000);
    }
  }

  function ensureToolbarButton(): void {
    if (toolbarBtn && doc.contains(toolbarBtn)) return;
    const bar = doc.querySelector(SELECTORS.buttonBar);
    if (!bar) return;
    const btn = doc.createElement('input');
    btn.type = 'button';
    btn.value = 'Delete Selected Versions';
    btn.className = `btnDisabled ${DELETE_BTN_CLASS}`;
    btn.disabled = true;
    btn.style.marginLeft = '4px';
    btn.addEventListener('click', () => void handleBulkDelete());
    bar.appendChild(btn);
    toolbarBtn = btn;
  }

  function refresh(): void {
    const table = doc.querySelector(SELECTORS.versionsTable);
    if (!table) return;
    injectCheckboxColumn(doc, table);
    decorateRows(table);
    ensureToolbarButton();
    updateToolbar();
  }

  return {
    manifest: {
      id: 'flow-version-manager',
      contexts: [CONTEXTS.FLOW_DETAILS],
    },

    async init() {
      refresh();
      observer = new MutationObserver(() => refresh());
      if (doc.body) observer.observe(doc.body, { childList: true, subtree: true });
    },

    refresh() {
      refresh();
    },

    async teardown(): Promise<void> {
      observer?.disconnect();
      observer = null;
      if (toolbarBtn) {
        toolbarBtn.remove();
        toolbarBtn = null;
      }
      doc.querySelectorAll(`.${TAB_CLASS}`).forEach((el) => el.remove());
      selected.clear();
      rowMap.clear();
    },
  };
}

export function _flowVersionManagerTestApi() {
  return { extractRowMeta };
}
