import { detectContext, CONTEXTS } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';

interface RowIndexEntry {
  row: HTMLElement;
  name: string;
  apiName: string;
  statusNormalized: '' | 'active' | 'inactive';
  typeRaw: string;
  typeDisplay: string;
  searchBlob: string;
}

const SELECTORS = {
  listViewManager:
    '.forceListViewManager, .forceListViewManagerGrid, [data-aura-class="forceListViewManager"]',
  tableBody: 'table tbody, .uiVirtualDataTable tbody, .slds-table tbody',
  tableRow: 'table tbody tr, .uiVirtualDataTable tbody tr, .slds-table tbody tr',
  scrollContainer:
    '.uiScroller .scroller-inner, .uiScroller, .slds-scrollable_y, .listViewContent, [data-aura-class="uiScroller"]',
  listHeader:
    '.listViewContent .slds-page-header, .forceListViewManagerHeader, .slds-page-header',
  flowNameCell: 'th[scope="row"] a, td:first-child a, th a',
};

const TRIGGER_TYPE_LABELS: Record<string, string> = {
  Activation: 'Activation-Triggered Flow',
  AutomationEvent: 'Automation Event-Triggered Flow',
  Capability: 'Capability-Triggered Flow',
  Capabilitiy: 'Capability-Triggered Flow', // typo-safe mapping — observed in Salesforce metadata
  DataCloudDataChange: 'Data Cloud Data Change Flow',
  DataGraphDataChange: 'Data Graph Data Change Flow',
  EventDrivenJourney: 'Event-Driven Journey Flow',
  ExternalSystemChange: 'External System Change Flow',
  PlatformEvent: 'Platform Event-Triggered Flow',
  RecordAfterSave: 'Record-Triggered Flow (After Save)',
  RecordBeforeDelete: 'Record-Triggered Flow (Before Delete)',
  RecordBeforeSave: 'Record-Triggered Flow (Before Save)',
  Scheduled: 'Scheduled Flow',
  ScheduledJourney: 'Scheduled Journey Flow',
  Segment: 'Segment Flow',
};

const PROCESS_TYPE_LABELS: Record<string, string> = {
  ActionableEventManagementFlow: 'Actionable Event Management Flow',
  ActionCadenceAutolaunchedFlow: 'Action Cadence Autolaunched Flow',
  ActionCadenceStepFlow: 'Action Cadence Step Flow',
  ActivityObjectMatchingFlow: 'Activity Object Matching Flow',
  Appointments: 'Appointments Flow',
  ApprovalWorkflow: 'Approval Workflow',
  AutoLaunchedFlow: 'Autolaunched Flow',
  CheckoutFlow: 'Checkout Flow',
  ContactRequestFlow: 'Contact Request Flow',
  CustomerLifecycle: 'Customer Lifecycle Flow',
  CustomEvent: 'Custom Event Flow',
  DataCaptureFlow: 'Data Capture Flow',
  DcvrFrameworkDataCaptureFlow: 'DCVR Framework Data Capture Flow',
  EvaluationFlow: 'Evaluation Flow',
  FieldServiceMobile: 'Field Service Mobile Flow',
  FieldServiceWeb: 'Field Service Web Flow',
  Flow: 'Screen Flow',
  FSCLending: 'FSC Lending Flow',
  IdentityUserRegistrationFlow: 'Identity User Registration Flow',
  IndicatorResultFlow: 'Indicator Result Flow',
  IndividualObjectLinkingFlow: 'Individual Object Linking Flow',
  InvocableProcess: 'Invocable Process',
  Journey: 'Journey Flow',
  LoginFlow: 'Login Flow',
  LoyaltyManagementFlow: 'Loyalty Management Flow',
  Orchestrator: 'Orchestrator Flow',
  PromptFlow: 'Prompt Flow',
  RecommendationStrategy: 'Recommendation Strategy Flow',
  RoutingFlow: 'Routing Flow',
  Survey: 'Survey Flow',
  SurveyEnrich: 'Survey Enrichment Flow',
  Workflow: 'Workflow',
};

function humanizeEnum(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').trim();
}

function typeDisplay(processType: string, triggerType: string): string {
  if (triggerType) return TRIGGER_TYPE_LABELS[triggerType] ?? humanizeEnum(triggerType);
  if (processType) return PROCESS_TYPE_LABELS[processType] ?? humanizeEnum(processType);
  return '';
}

function normalizeStatus(raw: string): RowIndexEntry['statusNormalized'] {
  const v = raw.trim().toLowerCase();
  if (v === 'true' || v === 'active') return 'active';
  if (v === 'false' || v === 'inactive') return 'inactive';
  return '';
}

function cellText(cell: Element | null): string {
  if (!cell) return '';
  return (cell.textContent ?? '').trim().replace(/\s+/g, ' ');
}

function cellValue(cell: Element | null): string {
  if (!cell) return '';
  const title = cell.querySelector('[title]')?.getAttribute('title')?.trim();
  if (title) return title;
  const dataValue = cell.querySelector('[data-value]')?.getAttribute('data-value')?.trim();
  if (dataValue) return dataValue;
  const ariaLabel = cell.querySelector('[aria-label]')?.getAttribute('aria-label')?.trim();
  if (ariaLabel && ariaLabel !== 'true' && ariaLabel !== 'false') return ariaLabel;
  return cellText(cell);
}

function checkboxValue(cell: Element | null): string {
  if (!cell) return '';
  const candidate =
    cell.querySelector('[role="checkbox"][aria-checked]') ??
    cell.querySelector('img[aria-checked]') ??
    cell.querySelector('img[alt]') ??
    cell.querySelector('[aria-label]');
  if (candidate) {
    const aria = candidate.getAttribute('aria-checked')?.trim().toLowerCase();
    if (aria === 'true' || aria === 'false') return aria;
    const alt = candidate.getAttribute('alt')?.trim().toLowerCase();
    if (alt === 'true' || alt === 'false') return alt;
    const label = candidate.getAttribute('aria-label')?.trim().toLowerCase();
    if (label === 'true' || label === 'false') return label;
    if (label === 'active' || label === 'inactive') return label;
  }
  const text = cellText(cell).toLowerCase();
  if (text === 'true' || text === 'false' || text === 'active' || text === 'inactive') return text;
  return '';
}

function extractRowData(row: HTMLElement): RowIndexEntry | null {
  const rowHeader = row.querySelector('th[scope="row"]');
  if (!rowHeader) return null;
  const tds = Array.from(row.querySelectorAll('td'));

  const nameLink = row.querySelector(SELECTORS.flowNameCell);
  const name = nameLink ? cellText(nameLink) : cellText(rowHeader);
  const apiName = cellValue(tds[1] ?? null);
  const processTypeRaw = cellValue(tds[2] ?? null);
  const triggerTypeRaw = cellValue(tds[3] ?? null);
  const statusNormalized = normalizeStatus(checkboxValue(tds[4] ?? null));

  const typeRaw = (triggerTypeRaw || processTypeRaw || '').trim();
  const typeDisp = typeDisplay(processTypeRaw, triggerTypeRaw);
  const searchBlob = [name, apiName, processTypeRaw, triggerTypeRaw, typeRaw, typeDisp]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (!name) return null;
  return {
    row,
    name,
    apiName,
    statusNormalized,
    typeRaw,
    typeDisplay: typeDisp,
    searchBlob,
  };
}

export function indexRows(doc: Document): RowIndexEntry[] {
  return Array.from(doc.querySelectorAll<HTMLElement>(SELECTORS.tableRow))
    .map(extractRowData)
    .filter((entry): entry is RowIndexEntry => entry !== null);
}

interface FilterState {
  text: string;
  status: '' | 'active' | 'inactive';
  type: string;
}

export function applyFilters(
  rows: readonly RowIndexEntry[],
  state: FilterState,
): { visible: number; total: number } {
  let visible = 0;
  const term = state.text.trim().toLowerCase();
  for (const item of rows) {
    const matchesText = !term || item.searchBlob.includes(term);
    const matchesStatus = !state.status || item.statusNormalized === state.status;
    const matchesType = !state.type || item.typeRaw === state.type;
    const isVisible = matchesText && matchesStatus && matchesType;
    item.row.style.display = isVisible ? '' : 'none';
    if (isVisible) visible += 1;
  }
  return { visible, total: rows.length };
}

export interface FlowListSearchOptions {
  doc?: Document;
  win?: Window;
  waitTimeoutMs?: number;
}

export function createFlowListSearchFeature(options: FlowListSearchOptions = {}): Feature {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  const waitTimeoutMs = options.waitTimeoutMs ?? 10_000;

  let searchInput: HTMLInputElement | null = null;
  let statusFilter: HTMLSelectElement | null = null;
  let typeFilter: HTMLSelectElement | null = null;
  let countLabel: HTMLSpanElement | null = null;
  let clearBtn: HTMLButtonElement | null = null;
  let rowIndex: RowIndexEntry[] = [];
  let allRowsLoaded = false;
  let scrolling = false;

  function updateClearButtonState(): void {
    if (!clearBtn) return;
    const hasInputs =
      !!(searchInput?.value || statusFilter?.value || typeFilter?.value);
    clearBtn.style.display = hasInputs ? 'inline-block' : 'none';
  }

  function updateCount(visible: number, total: number, loading = false): void {
    if (!countLabel) return;
    if (loading) {
      countLabel.textContent = 'Loading all flows…';
      countLabel.classList.add('sfdt-flow-search-loading');
      return;
    }
    countLabel.classList.remove('sfdt-flow-search-loading');
    if (total === 0) countLabel.textContent = '';
    else if (visible === total) countLabel.textContent = `${total} flows`;
    else if (visible === 0) countLabel.textContent = 'No matching flows';
    else countLabel.textContent = `${visible} of ${total} flows`;
  }

  function refreshFilterOptions(): void {
    if (!typeFilter) return;
    const previous = typeFilter.value;
    const seen = new Map<string, string>();
    for (const item of rowIndex) {
      if (!item.typeRaw) continue;
      if (!seen.has(item.typeRaw)) seen.set(item.typeRaw, item.typeDisplay || item.typeRaw);
    }
    const sorted = Array.from(seen.entries()).sort((a, b) => a[1].localeCompare(b[1]));

    while (typeFilter.firstChild) typeFilter.removeChild(typeFilter.firstChild);
    const defaultOpt = doc.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = 'All Types';
    typeFilter.appendChild(defaultOpt);
    for (const [raw, label] of sorted) {
      const opt = doc.createElement('option');
      opt.value = raw;
      opt.textContent = label;
      opt.title = raw;
      typeFilter.appendChild(opt);
    }
    if (Array.from(typeFilter.options).some((o) => o.value === previous)) {
      typeFilter.value = previous;
    } else {
      typeFilter.value = '';
    }
  }

  function reIndexAndFilter(): void {
    rowIndex = indexRows(doc);
    refreshFilterOptions();
    const state: FilterState = {
      text: searchInput?.value ?? '',
      status: ((statusFilter?.value ?? '') as FilterState['status']) || '',
      type: typeFilter?.value ?? '',
    };
    const counts = applyFilters(rowIndex, state);
    updateCount(counts.visible, counts.total);
    updateClearButtonState();
  }

  async function autoScrollToLoadAll(): Promise<void> {
    if (allRowsLoaded || scrolling) return;
    scrolling = true;
    updateCount(0, 0, true);

    const scroller = doc.querySelector<HTMLElement>(SELECTORS.scrollContainer);
    if (!scroller) {
      allRowsLoaded = true;
      scrolling = false;
      reIndexAndFilter();
      return;
    }

    let previous = 0;
    let stable = 0;
    for (let i = 0; i < 100; i += 1) {
      scroller.scrollTop = scroller.scrollHeight;
      await new Promise((r) => setTimeout(r, 300));
      const current = doc.querySelectorAll(SELECTORS.tableRow).length;
      if (current === previous) {
        stable += 1;
        if (stable >= 3) break;
      } else {
        stable = 0;
        previous = current;
      }
    }
    scroller.scrollTop = 0;
    allRowsLoaded = true;
    scrolling = false;
    reIndexAndFilter();
  }

  function injectBar(): void {
    if (doc.getElementById('sfdt-flow-search-container')) return;
    const header = doc.querySelector(SELECTORS.listHeader);
    const manager = doc.querySelector(SELECTORS.listViewManager);
    const insertTarget = header ?? manager;
    if (!insertTarget) return;

    const container = doc.createElement('div');
    container.id = 'sfdt-flow-search-container';
    container.className = 'sfdt-flow-search-container';

    const icon = doc.createElement('span');
    icon.className = 'sfdt-flow-search-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '🔍';
    container.appendChild(icon);

    searchInput = doc.createElement('input');
    searchInput.id = 'sfdt-flow-search-input';
    searchInput.className = 'sfdt-flow-search-input';
    searchInput.type = 'text';
    searchInput.placeholder = 'Search by label or API name…';
    searchInput.setAttribute('aria-label', 'Search flows by label or API name');
    searchInput.setAttribute('autocomplete', 'off');
    searchInput.setAttribute('spellcheck', 'false');
    container.appendChild(searchInput);

    statusFilter = doc.createElement('select');
    statusFilter.id = 'sfdt-flow-status-filter';
    statusFilter.className = 'sfdt-flow-search-filter';
    statusFilter.setAttribute('aria-label', 'Filter flows by status');
    const statusOptions: ReadonlyArray<readonly [string, string]> = [
      ['', 'All Statuses'],
      ['active', 'Active'],
      ['inactive', 'Inactive'],
    ];
    for (const [value, label] of statusOptions) {
      const opt = doc.createElement('option');
      opt.value = value;
      opt.textContent = label;
      statusFilter.appendChild(opt);
    }
    container.appendChild(statusFilter);

    typeFilter = doc.createElement('select');
    typeFilter.id = 'sfdt-flow-type-filter';
    typeFilter.className = 'sfdt-flow-search-filter';
    typeFilter.setAttribute('aria-label', 'Filter flows by type');
    const allTypes = doc.createElement('option');
    allTypes.value = '';
    allTypes.textContent = 'All Types';
    typeFilter.appendChild(allTypes);
    container.appendChild(typeFilter);

    clearBtn = doc.createElement('button');
    clearBtn.className = 'sfdt-flow-search-clear';
    clearBtn.textContent = 'Clear';
    clearBtn.title = 'Clear search and filters';
    clearBtn.setAttribute('aria-label', 'Clear search and filters');
    container.appendChild(clearBtn);

    countLabel = doc.createElement('span');
    countLabel.id = 'sfdt-flow-search-count';
    countLabel.className = 'sfdt-flow-search-count';
    container.appendChild(countLabel);

    if (header && header.parentNode) {
      header.parentNode.insertBefore(container, header.nextSibling);
    } else if (insertTarget) {
      insertTarget.insertBefore(container, insertTarget.firstChild);
    }

    let debounce: ReturnType<typeof setTimeout> | null = null;
    searchInput.addEventListener('input', () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(async () => {
        await autoScrollToLoadAll();
        reIndexAndFilter();
      }, 150);
    });
    searchInput.addEventListener('focus', () => {
      void autoScrollToLoadAll();
    });
    statusFilter.addEventListener('change', async () => {
      await autoScrollToLoadAll();
      reIndexAndFilter();
    });
    typeFilter.addEventListener('change', async () => {
      await autoScrollToLoadAll();
      reIndexAndFilter();
    });
    clearBtn.addEventListener('click', async () => {
      if (searchInput) searchInput.value = '';
      if (statusFilter) statusFilter.value = '';
      if (typeFilter) typeFilter.value = '';
      await autoScrollToLoadAll();
      reIndexAndFilter();
      searchInput?.focus();
    });

    reIndexAndFilter();
  }

  async function waitForListView(): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < waitTimeoutMs) {
      const tbody = doc.querySelector(SELECTORS.tableBody);
      if (tbody && tbody.querySelectorAll('tr').length > 0) {
        injectBar();
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  return {
    manifest: {
      id: 'flow-list-search',
      name: 'Flow List Search',
      contexts: [CONTEXTS.SETUP_FLOWS],
    },

    async init() {
      const context = detectContext({ location: { href: win.location.href } }, doc);
      if (context !== CONTEXTS.SETUP_FLOWS) return;
      await waitForListView();
    },

    onActivate() {
      if (searchInput) {
        searchInput.focus();
        searchInput.select();
      } else {
        void waitForListView();
      }
    },
  };
}

export function _flowListSearchTestApi() {
  return { humanizeEnum, typeDisplay, normalizeStatus, indexRows, applyFilters };
}
