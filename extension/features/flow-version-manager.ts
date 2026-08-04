import type { Feature } from '../lib/feature-registry.js';
import { CONTEXTS } from '../lib/context-detector.js';
import { confirmDialog } from '../ui/confirm-dialog.js';

const SELECTORS = {
  versionsTable: 'table.list[id="view:lists:versions"]',
  rows: 'tbody[id="view:lists:versions:tb"] > tr.dataRow',
  headerRow: 'table.list[id="view:lists:versions"] > thead > tr.headerRow',
  headerCells: 'th.headerRow',
  bodyCells: 'td.dataCell',
  buttonBar: 'td[id="view:form:thePageBlock:pageBlockButtons"]',
  deleteLink: 'a[id$=":deleteLink"]',
};

const TAB_CLASS = 'sfdt-version-select-cell';
const CHECKBOX_CLASS = 'sfdt-version-select-checkbox';
const DELETE_BTN_CLASS = 'sfdt-version-manager-delete-btn';

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

/**
 * Type-to-confirm gate for the destructive multi-version delete.
 *
 * The dialog itself is ui/confirm-dialog.ts. This function survives only to
 * describe WHAT is being deleted; the chrome, the focus trap, Esc-cancels and
 * focus restore now come from the shared component — the copy that used to live
 * here had the typed gate but none of the a11y.
 */
async function confirmModal(doc: Document, selected: RowMeta[]): Promise<boolean> {
  return confirmDialog({
    doc,
    title: 'Delete Selected Versions',
    message:
      'Type DELETE to confirm. Active versions cannot be deleted; interviews in progress may fail.',
    details: selected.map((s) => `${s.versionLabel} — ${s.status}`),
    confirmLabel: 'Delete Selected Versions',
    requireTyped: 'DELETE',
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
    // Bounded: auto-accept at most one confirm per clicked link, restoring the
    // original confirm immediately after the last expected one — a blanket
    // override left in place would silently accept ANY confirm on the page.
    const origConfirm = win.confirm;
    let remaining = items.length;
    let restored = false;
    const restore = (): void => {
      if (restored) return;
      restored = true;
      win.confirm = origConfirm;
    };
    win.confirm = () => {
      remaining -= 1;
      if (remaining <= 0) restore();
      return true;
    };
    try {
      for (const item of items) {
        item.deleteLink?.click();
      }
    } finally {
      // Fallback for pages that fire fewer confirms than links (or none).
      setTimeout(restore, 1000);
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
    btn.classList.add('sfdt-toolbar-end');
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
      name: 'Flow Version Manager',
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
      // The confirm dialog is ui/confirm-dialog.ts now, so the stranded-overlay
      // sweep has to look for ITS class. A teardown still hunting for the old
      // private one would silently stop cleaning up.
      doc.querySelectorAll('.sfdt-confirm-overlay').forEach((el) => el.remove());
      selected.clear();
      rowMap.clear();
    },
  };
}

export function _flowVersionManagerTestApi() {
  return { extractRowMeta };
}
