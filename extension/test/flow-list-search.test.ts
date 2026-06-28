import { describe, it, expect, beforeEach } from 'vitest';
import {
  _flowListSearchTestApi,
  applyFilters,
  createFlowListSearchFeature,
  indexRows,
} from '../features/flow-list-search.js';

const { humanizeEnum, typeDisplay, normalizeStatus } = _flowListSearchTestApi();

// Builds rows from arbitrary cell elements so extractRowData's cellValue /
// checkboxValue branches (data-value, aria-label, img alt, text fallback) can be
// exercised. Column order mirrors buildTable: [num], th(name), api, proc, trig, status.
function customTable(
  rows: Array<{ name: HTMLElement | null; cells: Array<HTMLElement | null> }>,
): HTMLTableElement {
  const table = document.createElement('table');
  const tbody = document.createElement('tbody');
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.appendChild(document.createElement('td')); // tds[0] — row number
    const th = document.createElement('th');
    th.setAttribute('scope', 'row');
    if (r.name) th.appendChild(r.name);
    tr.appendChild(th);
    for (const cell of r.cells) {
      const td = document.createElement('td');
      if (cell) td.appendChild(cell);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

function el(tag: string, attrs: Record<string, string>, text = ''): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text) node.textContent = text;
  return node;
}

function listViewWrap(table: HTMLTableElement): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'forceListViewManager';
  wrap.appendChild(table);
  return wrap;
}

function setupFlowsPage(): void {
  history.replaceState(null, '', '/lightning/setup/Flows/home');
}

function buildTable(rows: Array<{
  name: string;
  apiName: string;
  processType?: string;
  triggerType?: string;
  active: boolean;
}>): HTMLTableElement {
  const table = document.createElement('table');
  // No <thead> needed — leaving it off avoids any innerHTML cleanup.
  const tbody = document.createElement('tbody');
  for (const r of rows) {
    const tr = document.createElement('tr');
    const num = document.createElement('td');
    num.textContent = '1';
    tr.appendChild(num);

    const th = document.createElement('th');
    th.scope = 'row';
    const a = document.createElement('a');
    a.textContent = r.name;
    th.appendChild(a);
    tr.appendChild(th);

    const apiTd = document.createElement('td');
    const apiSpan = document.createElement('span');
    apiSpan.setAttribute('title', r.apiName);
    apiSpan.textContent = r.apiName;
    apiTd.appendChild(apiSpan);
    tr.appendChild(apiTd);

    const procTd = document.createElement('td');
    if (r.processType) {
      const span = document.createElement('span');
      span.setAttribute('title', r.processType);
      span.textContent = r.processType;
      procTd.appendChild(span);
    }
    tr.appendChild(procTd);

    const trigTd = document.createElement('td');
    if (r.triggerType) {
      const span = document.createElement('span');
      span.setAttribute('title', r.triggerType);
      span.textContent = r.triggerType;
      trigTd.appendChild(span);
    }
    tr.appendChild(trigTd);

    const activeTd = document.createElement('td');
    const checkbox = document.createElement('span');
    checkbox.setAttribute('role', 'checkbox');
    checkbox.setAttribute('aria-checked', r.active ? 'true' : 'false');
    activeTd.appendChild(checkbox);
    tr.appendChild(activeTd);

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

beforeEach(() => {
  document.body.replaceChildren();
  setupFlowsPage();
});

describe('extension/features/flow-list-search', () => {
  describe('pure helpers', () => {
    it('humanizeEnum splits camelCase and replaces underscores', () => {
      expect(humanizeEnum('RecordAfterSave')).toBe('Record After Save');
      expect(humanizeEnum('SOME_VALUE')).toBe('SOME VALUE');
    });

    it('typeDisplay maps trigger type first, then process type', () => {
      expect(typeDisplay('AutoLaunchedFlow', 'RecordAfterSave')).toBe(
        'Record-Triggered Flow (After Save)',
      );
      expect(typeDisplay('AutoLaunchedFlow', '')).toBe('Autolaunched Flow');
      expect(typeDisplay('UnknownProc', '')).toBe('Unknown Proc');
    });

    it('normalizeStatus accepts both true/false and active/inactive', () => {
      expect(normalizeStatus('true')).toBe('active');
      expect(normalizeStatus('false')).toBe('inactive');
      expect(normalizeStatus('Active')).toBe('active');
      expect(normalizeStatus('something else')).toBe('');
    });
  });

  describe('indexRows + applyFilters', () => {
    it('indexes all rows with name + apiName + searchBlob', () => {
      document.body.appendChild(
        buildTable([
          { name: 'Onboarding', apiName: 'Onboarding_Flow', processType: 'Flow', active: true },
          {
            name: 'Account Sync',
            apiName: 'Account_Sync',
            triggerType: 'RecordAfterSave',
            active: false,
          },
        ]),
      );
      const index = indexRows(document);
      expect(index).toHaveLength(2);
      expect(index[0]!.name).toBe('Onboarding');
      expect(index[0]!.apiName).toBe('Onboarding_Flow');
      expect(index[1]!.typeDisplay).toBe('Record-Triggered Flow (After Save)');
    });

    it('filters by free-text against the search blob', () => {
      document.body.appendChild(
        buildTable([
          { name: 'Onboarding', apiName: 'Onboarding_Flow', processType: 'Flow', active: true },
          { name: 'Account Sync', apiName: 'Account_Sync', triggerType: 'RecordAfterSave', active: false },
        ]),
      );
      const index = indexRows(document);
      const result = applyFilters(index, { text: 'account', status: '', type: '' });
      expect(result.visible).toBe(1);
      expect(index[0]!.row.style.display).toBe('none');
      expect(index[1]!.row.style.display).toBe('');
    });

    it('filters by status', () => {
      document.body.appendChild(
        buildTable([
          { name: 'A', apiName: 'A', processType: 'Flow', active: true },
          { name: 'B', apiName: 'B', processType: 'Flow', active: false },
        ]),
      );
      const index = indexRows(document);
      expect(applyFilters(index, { text: '', status: 'active', type: '' }).visible).toBe(1);
      expect(applyFilters(index, { text: '', status: 'inactive', type: '' }).visible).toBe(1);
    });

    it('filters by raw type', () => {
      document.body.appendChild(
        buildTable([
          { name: 'A', apiName: 'A', triggerType: 'RecordAfterSave', active: true },
          { name: 'B', apiName: 'B', triggerType: 'Scheduled', active: true },
        ]),
      );
      const index = indexRows(document);
      const result = applyFilters(index, { text: '', status: '', type: 'Scheduled' });
      expect(result.visible).toBe(1);
      expect(index[0]!.row.style.display).toBe('none');
    });
  });

  describe('feature lifecycle', () => {
    it('init does nothing when not on Setup Flows', async () => {
      history.replaceState(null, '', '/lightning/setup/SomethingElse/home');
      document.body.appendChild(buildTable([{ name: 'A', apiName: 'A', active: true }]));
      const feature = createFlowListSearchFeature({ waitTimeoutMs: 50 });
      await feature.init?.();
      expect(document.getElementById('sfdt-flow-search-container')).toBeNull();
    });

    it('init injects the search bar when the list view is present', async () => {
      const wrap = document.createElement('div');
      wrap.className = 'forceListViewManager';
      wrap.appendChild(buildTable([{ name: 'A', apiName: 'A', active: true }]));
      document.body.appendChild(wrap);
      const feature = createFlowListSearchFeature({ waitTimeoutMs: 200 });
      await feature.init?.();
      expect(document.getElementById('sfdt-flow-search-container')).not.toBeNull();
      expect(document.getElementById('sfdt-flow-search-input')).not.toBeNull();
    });

    it('exposes a working type filter populated from the rows', async () => {
      const wrap = document.createElement('div');
      wrap.className = 'forceListViewManager';
      wrap.appendChild(
        buildTable([
          { name: 'A', apiName: 'A', triggerType: 'RecordAfterSave', active: true },
          { name: 'B', apiName: 'B', triggerType: 'Scheduled', active: true },
        ]),
      );
      document.body.appendChild(wrap);
      const feature = createFlowListSearchFeature({ waitTimeoutMs: 200 });
      await feature.init?.();
      const select = document.getElementById('sfdt-flow-type-filter') as HTMLSelectElement;
      expect(select).not.toBeNull();
      // Two trigger types plus the "All Types" placeholder.
      expect(select.options.length).toBe(3);
    });
  });

  describe('indexRows — cell extraction branches', () => {
    it('reads apiName from data-value and aria-label when no title is present', () => {
      document.body.appendChild(
        customTable([
          {
            name: el('a', {}, 'Alpha'),
            cells: [
              el('span', { 'data-value': 'Alpha_Api' }), // apiName via data-value
              null,
              el('span', { title: 'RecordAfterSave' }),
              el('span', { 'role': 'checkbox', 'aria-checked': 'true' }),
            ],
          },
          {
            name: el('a', {}, 'Beta'),
            cells: [
              el('span', { 'aria-label': 'Beta_Api' }), // apiName via aria-label
              null,
              el('span', { title: 'Scheduled' }),
              el('span', { 'role': 'checkbox', 'aria-checked': 'false' }),
            ],
          },
        ]),
      );
      const index = indexRows(document);
      expect(index[0]!.apiName).toBe('Alpha_Api');
      expect(index[1]!.apiName).toBe('Beta_Api');
    });

    it('resolves status from img[aria-checked], img[alt], aria-label, and text fallback', () => {
      document.body.appendChild(
        customTable([
          {
            name: el('a', {}, 'ImgChecked'),
            cells: [el('span', { title: 'a' }), null, null, el('img', { 'aria-checked': 'true' })],
          },
          {
            name: el('a', {}, 'ImgAlt'),
            cells: [el('span', { title: 'b' }), null, null, el('img', { alt: 'false' })],
          },
          {
            name: el('a', {}, 'AriaLabel'),
            cells: [el('span', { title: 'c' }), null, null, el('span', { 'aria-label': 'Active' })],
          },
          {
            name: el('a', {}, 'TextOnly'),
            cells: [el('span', { title: 'd' }), null, null, el('span', {}, 'Inactive')],
          },
        ]),
      );
      const index = indexRows(document);
      expect(index.map((r) => r.statusNormalized)).toEqual([
        'active',
        'inactive',
        'active',
        'inactive',
      ]);
    });

    it('skips rows that have no resolvable name', () => {
      document.body.appendChild(
        customTable([
          { name: null, cells: [el('span', { title: 'x' }), null, null, null] },
          { name: el('a', {}, 'Keep'), cells: [el('span', { title: 'y' }), null, null, null] },
        ]),
      );
      const index = indexRows(document);
      expect(index).toHaveLength(1);
      expect(index[0]!.name).toBe('Keep');
    });
  });

  describe('feature — interactive handlers', () => {
    async function initPopulated(extraScroller = false) {
      const table = buildTable([
        { name: 'Onboarding', apiName: 'Onboarding_Flow', triggerType: 'RecordAfterSave', active: true },
        { name: 'Account Sync', apiName: 'Account_Sync', triggerType: 'Scheduled', active: false },
      ]);
      let root: HTMLElement = listViewWrap(table);
      if (extraScroller) {
        const scroller = document.createElement('div');
        scroller.className = 'slds-scrollable_y';
        scroller.appendChild(root);
        root = scroller;
      }
      document.body.appendChild(root);
      const feature = createFlowListSearchFeature({ waitTimeoutMs: 200 });
      await feature.init?.();
      return {
        feature,
        input: document.getElementById('sfdt-flow-search-input') as HTMLInputElement,
        status: document.getElementById('sfdt-flow-status-filter') as HTMLSelectElement,
        type: document.getElementById('sfdt-flow-type-filter') as HTMLSelectElement,
        clear: document.querySelector('.sfdt-flow-search-clear') as HTMLButtonElement,
        count: document.getElementById('sfdt-flow-search-count') as HTMLSpanElement,
      };
    }

    const tick = () => new Promise((r) => setTimeout(r, 0));

    it('shows the full count once injected, then a partial count when text filters', async () => {
      const { input, count } = await initPopulated();
      expect(count.textContent).toBe('2 flows');
      input.value = 'account';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));
      expect(count.textContent).toBe('1 of 2 flows');
    });

    it('shows "No matching flows" when nothing matches', async () => {
      const { input, count } = await initPopulated();
      input.value = 'zzzzzz';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));
      expect(count.textContent).toBe('No matching flows');
    });

    it('the status filter narrows the list', async () => {
      const { status, count } = await initPopulated();
      status.value = 'active';
      status.dispatchEvent(new Event('change', { bubbles: true }));
      await tick();
      expect(count.textContent).toBe('1 of 2 flows');
    });

    it('the type filter narrows the list', async () => {
      const { type, count } = await initPopulated();
      type.value = 'Scheduled';
      type.dispatchEvent(new Event('change', { bubbles: true }));
      await tick();
      expect(count.textContent).toBe('1 of 2 flows');
    });

    it('the clear button resets inputs and hides itself', async () => {
      const { input, status, clear, count } = await initPopulated();
      input.value = 'account';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));
      expect(clear.style.display).toBe('inline-block');

      clear.click();
      await tick();
      expect(input.value).toBe('');
      expect(status.value).toBe('');
      expect(count.textContent).toBe('2 flows');
      expect(clear.style.display).toBe('none');
    });

    it('retains a still-valid type selection across a re-index', async () => {
      const { type, input } = await initPopulated();
      type.value = 'Scheduled';
      input.value = 'sync';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));
      expect(type.value).toBe('Scheduled'); // survived refreshFilterOptions
    });

    it('reports an empty count when all rows disappear', async () => {
      const { status, count } = await initPopulated();
      document.querySelector('tbody')!.replaceChildren();
      status.value = 'active';
      status.dispatchEvent(new Event('change', { bubbles: true }));
      await tick();
      expect(count.textContent).toBe('');
    });

    it('auto-scrolls a scroll container to load all rows on first filter', async () => {
      const { status, count } = await initPopulated(true);
      status.value = 'inactive';
      status.dispatchEvent(new Event('change', { bubbles: true }));
      // autoScrollToLoadAll polls in 300ms ticks until the row count stabilises.
      await new Promise((r) => setTimeout(r, 1500));
      expect(count.textContent).toBe('1 of 2 flows');
    }, 5000);

    it('onActivate focuses the existing input', async () => {
      const { feature, input } = await initPopulated();
      feature.onActivate?.();
      expect(document.activeElement).toBe(input);
    });

    it('onActivate injects the bar when invoked before init', async () => {
      document.body.appendChild(
        listViewWrap(buildTable([{ name: 'A', apiName: 'A', active: true }])),
      );
      const feature = createFlowListSearchFeature({ waitTimeoutMs: 200 });
      feature.onActivate?.();
      await new Promise((r) => setTimeout(r, 50));
      expect(document.getElementById('sfdt-flow-search-container')).not.toBeNull();
    });

    it('init times out without injecting when the list view never appears', async () => {
      // Setup Flows context but no table — waitForListView exhausts its budget.
      const feature = createFlowListSearchFeature({ waitTimeoutMs: 50 });
      await feature.init?.();
      expect(document.getElementById('sfdt-flow-search-container')).toBeNull();
    });
  });
});
