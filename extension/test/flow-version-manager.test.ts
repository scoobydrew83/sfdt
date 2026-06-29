import { describe, it, expect, beforeEach } from 'vitest';
import {
  createFlowVersionManagerFeature,
  _flowVersionManagerTestApi,
} from '../features/flow-version-manager.js';

const { extractRowMeta } = _flowVersionManagerTestApi();

// Build a row matching the Classic Flow Versions list structure that
// extractRowMeta / decorateRows read: cells[1]=label, cells[2]=version,
// cells[7]=status, plus an optional delete link carrying the version id.
function makeRow(opts: {
  label?: string;
  version?: string;
  status?: string;
  deleteId?: string | null;
}): HTMLTableRowElement {
  const { label = 'My Flow', version = '1', status = 'Inactive', deleteId = '301AB0000001abcAAA' } = opts;
  const row = document.createElement('tr');
  row.className = 'dataRow';
  for (let i = 0; i < 8; i += 1) {
    const td = document.createElement('td');
    td.className = 'dataCell';
    row.appendChild(td);
  }
  const cells = row.querySelectorAll('td');
  cells[1]!.textContent = label;
  cells[2]!.textContent = ` ${version} `;
  cells[7]!.textContent = status;
  if (deleteId !== null) {
    const a = document.createElement('a');
    a.id = `thePage:block:repeat:0:deleteLink`;
    a.setAttribute('onclick', `if(confirmDelete()){currVersionId,${deleteId}};return false;`);
    row.appendChild(a);
  }
  return row;
}

// Build the full Classic Flow Versions page scaffold the feature decorates.
function buildVersionsPage(rows: HTMLTableRowElement[]): HTMLTableElement {
  const table = document.createElement('table');
  table.className = 'list';
  table.id = 'view:lists:versions';

  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  headerRow.className = 'headerRow';
  for (let i = 0; i < 8; i += 1) {
    const th = document.createElement('th');
    th.className = 'headerRow';
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  tbody.id = 'view:lists:versions:tb';
  for (const r of rows) tbody.appendChild(r);
  table.appendChild(tbody);

  // Button bar lives outside the table in Classic, but selector only needs it
  // present in the document.
  const bar = document.createElement('td');
  bar.id = 'view:form:thePageBlock:pageBlockButtons';

  document.body.appendChild(table);
  document.body.appendChild(bar);
  return table;
}

describe('flow-version-manager teardown', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    const table = document.createElement('table');
    table.className = 'list';
    table.id = 'view:lists:versions';
    document.body.appendChild(table);
  });

  it('removes any injected panel and stops observers on teardown', async () => {
    const feature = createFlowVersionManagerFeature();
    await feature.init?.();
    await feature.teardown?.();
    expect(document.querySelector('.sfdt-version-manager-panel')).toBeNull();
  });

  it('removes injected checkbox column cells on teardown', async () => {
    const feature = createFlowVersionManagerFeature();
    await feature.init?.();
    await feature.teardown?.();
    expect(document.querySelectorAll('.sfdt-version-select-cell')).toHaveLength(0);
  });

  it('removes the toolbar delete button on teardown', async () => {
    const feature = createFlowVersionManagerFeature();
    await feature.init?.();
    await feature.teardown?.();
    expect(document.querySelector('.sfdt-version-manager-delete-btn')).toBeNull();
  });

  it('teardown does not throw even if init was never called', async () => {
    const feature = createFlowVersionManagerFeature();
    await expect(feature.teardown?.()).resolves.not.toThrow();
  });

  it('teardown does not throw when called twice', async () => {
    const feature = createFlowVersionManagerFeature();
    await feature.init?.();
    await feature.teardown?.();
    await expect(feature.teardown?.()).resolves.not.toThrow();
  });

  it('removes any stranded modal backdrop on teardown', async () => {
    const feature = createFlowVersionManagerFeature();
    await feature.init?.();
    // Simulate an open confirmation modal by manually injecting the backdrop
    const backdrop = document.createElement('div');
    backdrop.className = 'sfdt-version-manager-backdrop';
    document.body.appendChild(backdrop);
    expect(document.querySelector('.sfdt-version-manager-backdrop')).not.toBeNull();
    await feature.teardown?.();
    expect(document.querySelector('.sfdt-version-manager-backdrop')).toBeNull();
  });
});

describe('flow-version-manager — extractRowMeta', () => {
  beforeEach(() => document.body.replaceChildren());

  it('returns null for a row with no data cells', () => {
    const row = document.createElement('tr');
    expect(extractRowMeta(row)).toBeNull();
  });

  it('marks Active versions as not deletable even when a delete link exists', () => {
    const meta = extractRowMeta(makeRow({ status: 'Active' }));
    expect(meta).not.toBeNull();
    expect(meta!.status).toBe('active');
    expect(meta!.canDelete).toBe(false);
  });

  it('falls back to a composite id and canDelete=false when no delete link exists', () => {
    const meta = extractRowMeta(makeRow({ label: 'Order Flow', version: '7', status: 'Obsolete', deleteId: null }));
    expect(meta!.deleteLink).toBeNull();
    expect(meta!.canDelete).toBe(false);
    // versionId is `${flowLabel}::${versionNumber}::${status}` when no id is parseable.
    expect(meta!.versionId).toBe('Order Flow::7::obsolete');
    expect(meta!.versionLabel).toBe('Version 7');
  });

  it('defaults the label to Unknown when the label cell is blank', () => {
    const meta = extractRowMeta(makeRow({ label: '   ', version: '', status: '', deleteId: null }));
    // No version number → versionLabel falls back to the (Unknown) flow label.
    expect(meta!.versionLabel).toBe('Unknown');
    expect(meta!.status).toBe('unknown');
  });
});

describe('flow-version-manager — decorate, select, and bulk delete', () => {
  beforeEach(() => document.body.replaceChildren());

  it('injects a checkbox column, per-row cells, and a disabled toolbar button on init', async () => {
    buildVersionsPage([
      makeRow({ label: 'Flow', version: '2', status: 'Inactive', deleteId: '301AB0000001aaaAAA' }),
      makeRow({ label: 'Flow', version: '3', status: 'Active', deleteId: '301AB0000001bbbAAA' }),
    ]);
    const feature = createFlowVersionManagerFeature();
    await feature.init?.();

    expect(document.querySelectorAll('th.sfdt-version-select-cell')).toHaveLength(1);
    expect(document.querySelectorAll('td.sfdt-version-select-cell')).toHaveLength(2);

    const btn = document.querySelector<HTMLInputElement>('.sfdt-version-manager-delete-btn');
    expect(btn).not.toBeNull();
    expect(btn!.disabled).toBe(true);
    expect(btn!.value).toBe('Delete Selected Versions');

    // The Active row's checkbox is disabled; the Inactive row's is enabled.
    const checkboxes = document.querySelectorAll<HTMLInputElement>('.sfdt-version-select-checkbox');
    expect(checkboxes[0]!.disabled).toBe(false);
    expect(checkboxes[1]!.disabled).toBe(true);

    await feature.teardown?.();
  });

  it('enables the toolbar and shows a count when a deletable version is selected', async () => {
    buildVersionsPage([
      makeRow({ label: 'Flow', version: '2', status: 'Inactive', deleteId: '301AB0000001aaaAAA' }),
    ]);
    const feature = createFlowVersionManagerFeature();
    await feature.init?.();

    const checkbox = document.querySelector<HTMLInputElement>('.sfdt-version-select-checkbox')!;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));

    const btn = document.querySelector<HTMLInputElement>('.sfdt-version-manager-delete-btn')!;
    expect(btn.disabled).toBe(false);
    expect(btn.value).toBe('Delete Selected Versions (1)');

    // Unchecking clears the selection and disables the toolbar again.
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change'));
    expect(btn.disabled).toBe(true);
    expect(btn.value).toBe('Delete Selected Versions');

    await feature.teardown?.();
  });

  it('confirm modal clicks each selected delete link after the user types DELETE', async () => {
    buildVersionsPage([
      makeRow({ label: 'Flow', version: '2', status: 'Inactive', deleteId: '301AB0000001aaaAAA' }),
    ]);
    let deleteLinkClicks = 0;
    document.querySelector('a[id$=":deleteLink"]')!.addEventListener('click', (e) => {
      e.preventDefault();
      deleteLinkClicks += 1;
    });

    const feature = createFlowVersionManagerFeature();
    await feature.init?.();

    const checkbox = document.querySelector<HTMLInputElement>('.sfdt-version-select-checkbox')!;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));

    document.querySelector<HTMLInputElement>('.sfdt-version-manager-delete-btn')!.click();

    const backdrop = document.querySelector('.sfdt-version-manager-backdrop');
    expect(backdrop).not.toBeNull();

    const confirmBtn = Array.from(backdrop!.querySelectorAll('button')).find(
      (b) => b.textContent === 'Delete Selected Versions',
    ) as HTMLButtonElement;
    // Confirm stays disabled until the exact word DELETE is typed.
    expect(confirmBtn.disabled).toBe(true);

    const input = backdrop!.querySelector('input[type="text"]') as HTMLInputElement;
    input.value = 'DELETE';
    input.dispatchEvent(new Event('input'));
    expect(confirmBtn.disabled).toBe(false);

    confirmBtn.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(deleteLinkClicks).toBe(1);
    expect(document.querySelector('.sfdt-version-manager-backdrop')).toBeNull();

    await feature.teardown?.();
  });

  it('confirm modal Cancel dismisses without clicking any delete link', async () => {
    buildVersionsPage([
      makeRow({ label: 'Flow', version: '2', status: 'Inactive', deleteId: '301AB0000001aaaAAA' }),
    ]);
    let deleteLinkClicks = 0;
    document.querySelector('a[id$=":deleteLink"]')!.addEventListener('click', (e) => {
      e.preventDefault();
      deleteLinkClicks += 1;
    });

    const feature = createFlowVersionManagerFeature();
    await feature.init?.();

    const checkbox = document.querySelector<HTMLInputElement>('.sfdt-version-select-checkbox')!;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    document.querySelector<HTMLInputElement>('.sfdt-version-manager-delete-btn')!.click();

    const backdrop = document.querySelector('.sfdt-version-manager-backdrop')!;
    const cancelBtn = Array.from(backdrop.querySelectorAll('button')).find(
      (b) => b.textContent === 'Cancel',
    ) as HTMLButtonElement;
    cancelBtn.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(deleteLinkClicks).toBe(0);
    expect(document.querySelector('.sfdt-version-manager-backdrop')).toBeNull();

    await feature.teardown?.();
  });
});
