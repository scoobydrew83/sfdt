import { describe, it, expect, beforeEach } from 'vitest';
import {
  _flowListSearchTestApi,
  applyFilters,
  createFlowListSearchFeature,
  indexRows,
} from '../features/flow-list-search.js';

const { humanizeEnum, typeDisplay, normalizeStatus } = _flowListSearchTestApi();

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
});
