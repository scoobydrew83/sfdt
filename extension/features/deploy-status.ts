// Deployment Status (DIRECT, Workspace tool). Lists recent Tooling DeployRequest
// rows and, for a failed deploy, the SOAP Metadata checkDeployStatus component
// errors. Read-only: it never starts, cancels, or retries a deploy.
//
// Auto-refresh is data-driven, not a user toggle: an interval runs only while
// any loaded row is Pending / InProgress / Canceling, and is cleared on close
// and teardown. A DeployRequest query the org rejects degrades to a warning
// callout (same convention as the CLI's checkDeployHistory) — it is not an
// error panel, and it must not rethrow (that would fire feature.errored).

import { detectContext, CONTEXTS } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import {
  getSalesforceApi,
  type SalesforceApiClient,
} from '../lib/salesforce-api.js';
import { asArray } from '../lib/collections.js';
import { showToast } from '../ui/toast.js';
import { presentView, type ViewHandle } from '../ui/present-view.js';
import { button, field, toolbar } from '../lib/ui-controls.js';

export const AUTO_REFRESH_INTERVAL_MS = 15_000;
export const DEFAULT_PAGE_SIZE = 50;

const IN_FLIGHT = new Set(['Pending', 'InProgress', 'Canceling']);
const FAILED_STATUSES = new Set(['Failed', 'SucceededPartial']);

export interface RawDeployRequest {
  Id?: string | null;
  Status?: string | null;
  StartDate?: string | null;
  CompletedDate?: string | null;
  NumberComponentsDeployed?: number | null;
  NumberComponentErrors?: number | null;
  NumberComponentsTotal?: number | null;
  NumberTestsCompleted?: number | null;
  NumberTestErrors?: number | null;
  NumberTestsTotal?: number | null;
  CreatedBy?: { Name?: string | null } | null;
  CheckOnly?: boolean | null;
  ErrorMessage?: string | null;
  StateDetail?: string | null;
}

export interface DeployRow {
  id: string;
  status: string;
  startDate: string | null;
  completedDate: string | null;
  componentsDeployed: number;
  componentErrors: number;
  componentsTotal: number;
  testsCompleted: number;
  testErrors: number;
  testsTotal: number;
  createdBy: string;
  checkOnly: boolean;
  errorMessage: string;
  stateDetail: string;
}

export interface ComponentFailure {
  componentType: string;
  fullName: string;
  problem: string;
  lineNumber?: string;
  columnNumber?: string;
}

/** Pure query builder so the SOQL is unit-testable without a live org. */
export function buildDeployRequestQuery(limit: number): string {
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  return (
    'SELECT Id, Status, StartDate, CompletedDate, ' +
    'NumberComponentsDeployed, NumberComponentErrors, NumberComponentsTotal, ' +
    'NumberTestsCompleted, NumberTestErrors, NumberTestsTotal, ' +
    'CreatedBy.Name, CheckOnly, ErrorMessage, StateDetail ' +
    'FROM DeployRequest ORDER BY CompletedDate DESC NULLS LAST ' +
    `LIMIT ${safeLimit}`
  );
}

export function shapeDeployRows(records: RawDeployRequest[]): DeployRow[] {
  const rows: DeployRow[] = [];
  for (const r of records) {
    if (typeof r.Id !== 'string' || r.Id.length === 0) continue;
    rows.push({
      id: r.Id,
      status: r.Status ?? 'Unknown',
      startDate: r.StartDate ?? null,
      completedDate: r.CompletedDate ?? null,
      componentsDeployed: r.NumberComponentsDeployed ?? 0,
      componentErrors: r.NumberComponentErrors ?? 0,
      componentsTotal: r.NumberComponentsTotal ?? 0,
      testsCompleted: r.NumberTestsCompleted ?? 0,
      testErrors: r.NumberTestErrors ?? 0,
      testsTotal: r.NumberTestsTotal ?? 0,
      createdBy: r.CreatedBy?.Name ?? '—',
      checkOnly: r.CheckOnly === true,
      errorMessage: r.ErrorMessage ?? '',
      stateDetail: r.StateDetail ?? '',
    });
  }
  return rows;
}

export function isInFlight(status: string | null | undefined): boolean {
  return typeof status === 'string' && IN_FLIGHT.has(status);
}

export function statusPillClass(status: string): string {
  if (status === 'Succeeded') return 'sfdt-pill sfdt-success';
  if (status === 'Failed') return 'sfdt-pill sfdt-error';
  if (
    status === 'SucceededPartial' ||
    status === 'Pending' ||
    status === 'InProgress' ||
    status === 'Canceling'
  ) {
    return 'sfdt-pill sfdt-warning';
  }
  return 'sfdt-pill';
}

export function formatDeployWhen(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export function formatDeployDuration(
  start: string | null | undefined,
  end: string | null | undefined,
): string {
  if (!start || !end) return '—';
  const a = new Date(start).getTime();
  const b = new Date(end).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return '—';
  const ms = b - a;
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

export function formatCountTriple(done: number, total: number, errors: number): string {
  if (done === 0 && total === 0 && errors === 0) return '—';
  const base = `${done} / ${total}`;
  if (errors <= 0) return base;
  return `${base} (${errors} error${errors === 1 ? '' : 's'})`;
}

/**
 * True for the two shapes orgs actually send when they refuse a DeployRequest
 * list query. The feature degrades ANY list-query throw (CLI catch-all); this
 * classifier exists so the known refusals stay named and unit-testable.
 */
export function isDeployQueryRejected(err: unknown): boolean {
  if (err == null) return false;
  const msg = err instanceof Error ? err.message : String(err);
  if (/INVALID_TYPE/i.test(msg)) return true;
  if (/DeployRequest requires a filter/i.test(msg)) return true;
  const details = (err as { details?: Array<{ errorCode?: string; message?: string }> }).details;
  if (!Array.isArray(details)) return false;
  return details.some(
    (d) =>
      d.errorCode === 'INVALID_TYPE' ||
      /DeployRequest requires a filter/i.test(d.message ?? ''),
  );
}

function errorText(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  return String(err);
}

/**
 * Accepts the SOAP checkDeployStatus result, its `.details`, or a bare
 * componentFailures value. Salesforce SOAP returns a single object when there
 * is one failure, so this always goes through asArray().
 */
export function shapeComponentFailures(raw: unknown): ComponentFailure[] {
  if (raw == null) return [];
  const rec = raw as Record<string, unknown>;
  const details = rec.details as Record<string, unknown> | undefined;
  const source =
    rec.componentFailures ?? details?.componentFailures ?? (Array.isArray(raw) ? raw : null);
  if (source == null && !details && !Array.isArray(raw)) return [];
  return asArray(source as Record<string, unknown> | Record<string, unknown>[] | null).map((f) => {
    const row = f ?? {};
    const failure: ComponentFailure = {
      componentType: String(row.componentType ?? 'Component'),
      fullName: String(row.fullName ?? ''),
      problem: String(row.problem ?? 'Unknown failure'),
    };
    if (row.lineNumber != null && String(row.lineNumber) !== '') {
      failure.lineNumber = String(row.lineNumber);
    }
    if (row.columnNumber != null && String(row.columnNumber) !== '') {
      failure.columnNumber = String(row.columnNumber);
    }
    return failure;
  });
}

export function shouldFetchComponentErrors(row: DeployRow): boolean {
  return FAILED_STATUSES.has(row.status) || row.componentErrors > 0;
}

export interface DeployStatusOptions {
  doc?: Document;
  win?: Window;
  api?: SalesforceApiClient;
}

export function createDeployStatusFeature(options: DeployStatusOptions = {}): Feature {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  const api = options.api ?? getSalesforceApi();

  let view: ViewHandle | null = null;
  let autoTimer: ReturnType<typeof setInterval> | null = null;
  let loadSeq = 0;

  function stopAutoRefresh(): void {
    if (autoTimer !== null) {
      clearInterval(autoTimer);
      autoTimer = null;
    }
  }

  function close(): void {
    loadSeq += 1;
    stopAutoRefresh();
    view?.close();
    view = null;
  }

  async function open(): Promise<void> {
    close();
    loadSeq = 0;

    const body = doc.createElement('div');
    body.className = 'sfdt-view-body';

    const bar = toolbar(doc);

    const filterField = field({
      placeholder: 'Filter deployments…',
      ariaLabel: 'Filter deployments',
      doc,
    });
    filterField.classList.add('sfdt-toolbar-grow');

    const watch = doc.createElement('span');
    watch.className = 'sfdt-muted';
    watch.setAttribute('role', 'status');
    watch.setAttribute('aria-live', 'polite');

    const refreshBtn = button({
      iconName: 'refresh',
      title: 'Refresh',
      ariaLabel: 'Refresh',
      small: true,
      doc,
    });

    bar.append(filterField, watch, refreshBtn);
    body.appendChild(bar);

    const main = doc.createElement('div');
    main.className = 'sfdt-view-main';
    body.appendChild(main);

    // OUR prose, not an org-error console — see lib/ui-styles.ts at .sfdt-callout.
    const warnPanel = doc.createElement('div');
    warnPanel.className = 'sfdt-callout sfdt-warn';
    warnPanel.setAttribute('role', 'status');
    warnPanel.style.display = 'none';
    main.appendChild(warnPanel);

    const tableWrap = doc.createElement('div');
    tableWrap.className = 'sfdt-scrollbox';
    tableWrap.style.maxHeight = '360px';
    const table = doc.createElement('table');
    table.className = 'sfdt-table';
    table.setAttribute('aria-label', 'Recent deployments');
    const thead = doc.createElement('thead');
    const headRow = doc.createElement('tr');
    for (const label of ['Status', 'Who', 'Started', 'Finished', 'Components', 'Tests', 'Type']) {
      const th = doc.createElement('th');
      th.scope = 'col';
      th.textContent = label;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    const tbody = doc.createElement('tbody');
    table.append(thead, tbody);
    tableWrap.appendChild(table);
    main.appendChild(tableWrap);

    const detail = doc.createElement('div');
    detail.className = 'sfdt-stack';
    detail.style.display = 'none';
    detail.setAttribute('aria-label', 'Deployment details');
    main.appendChild(detail);

    const statusBar = toolbar(doc, true);
    const status = doc.createElement('span');
    status.className = 'sfdt-muted';
    statusBar.appendChild(status);
    body.appendChild(statusBar);

    view = presentView({
      title: 'Deployment Status',
      iconName: 'rocket',
      body,
      doc,
      width: '960px',
      onClose: () => {
        // presentView does not call teardown. Clearing here is what stops the
        // interval when the user dismisses the overlay (debug-log-viewer leaks
        // on this path; do not copy that).
        loadSeq += 1;
        stopAutoRefresh();
        setWatch(false);
        view = null;
      },
    });

    let loaded: DeployRow[] = [];
    let selectedRow: HTMLTableRowElement | null = null;
    let selectedId: string | null = null;

    function setWatch(on: boolean): void {
      watch.textContent = on ? 'Watching in-progress deployments…' : '';
    }

    function startAutoRefresh(): void {
      if (autoTimer !== null) return;
      autoTimer = setInterval(() => void load(), AUTO_REFRESH_INTERVAL_MS);
      setWatch(true);
    }

    function syncAutoRefresh(rows: DeployRow[]): void {
      if (rows.some((r) => isInFlight(r.status))) startAutoRefresh();
      else {
        stopAutoRefresh();
        setWatch(false);
      }
    }

    function hideWarn(): void {
      warnPanel.style.display = 'none';
      while (warnPanel.firstChild) warnPanel.removeChild(warnPanel.firstChild);
    }

    function showWarn(err: unknown): void {
      while (warnPanel.firstChild) warnPanel.removeChild(warnPanel.firstChild);
      warnPanel.textContent = `Deployment history unavailable in this org: ${errorText(err)}`;
      warnPanel.style.display = 'block';
    }

    function emptyRow(text: string): HTMLTableRowElement {
      const tr = doc.createElement('tr');
      const td = doc.createElement('td');
      td.colSpan = 7;
      td.className = 'sfdt-muted';
      td.textContent = text;
      tr.appendChild(td);
      return tr;
    }

    function matchesFilter(row: DeployRow, needle: string): boolean {
      if (!needle) return true;
      return [
        row.status,
        row.createdBy,
        row.id,
        row.checkOnly ? 'validate' : 'deploy',
        row.errorMessage,
        row.stateDetail,
        formatDeployWhen(row.startDate),
        formatDeployWhen(row.completedDate),
      ]
        .join(' ')
        .toLowerCase()
        .includes(needle);
    }

    function addFact(parent: HTMLElement, label: string, value: string): void {
      const line = doc.createElement('div');
      line.className = 'sfdt-row';
      const lab = doc.createElement('span');
      lab.className = 'sfdt-muted';
      lab.textContent = label;
      const val = doc.createElement('span');
      val.textContent = value;
      line.append(lab, val);
      parent.appendChild(line);
    }

    function renderFailures(failures: ComponentFailure[]): void {
      if (failures.length === 0) {
        const empty = doc.createElement('div');
        empty.className = 'sfdt-prose sfdt-muted';
        empty.textContent = 'No component errors reported.';
        detail.appendChild(empty);
        return;
      }
      const wrap = doc.createElement('div');
      wrap.className = 'sfdt-scrollbox';
      const ft = doc.createElement('table');
      ft.className = 'sfdt-table';
      ft.setAttribute('aria-label', 'Component errors');
      const fh = doc.createElement('thead');
      const hr = doc.createElement('tr');
      for (const label of ['Component', 'Name', 'Problem']) {
        const th = doc.createElement('th');
        th.scope = 'col';
        th.textContent = label;
        hr.appendChild(th);
      }
      fh.appendChild(hr);
      const fb = doc.createElement('tbody');
      for (const f of failures) {
        const tr = doc.createElement('tr');
        const type = doc.createElement('td');
        type.textContent = f.componentType;
        const name = doc.createElement('td');
        name.className = 'sfdt-cell-code';
        name.textContent = f.fullName || '—';
        const problem = doc.createElement('td');
        let problemText = f.problem;
        if (f.lineNumber) {
          problemText += ` (line ${f.lineNumber}${f.columnNumber ? `:${f.columnNumber}` : ''})`;
        }
        problem.textContent = problemText;
        tr.append(type, name, problem);
        fb.appendChild(tr);
      }
      ft.append(fh, fb);
      wrap.appendChild(ft);
      detail.appendChild(wrap);
    }

    function renderDetailShell(row: DeployRow): void {
      while (detail.firstChild) detail.removeChild(detail.firstChild);
      detail.style.display = 'block';

      const head = doc.createElement('div');
      head.className = 'sfdt-row sfdt-baseline';
      const pill = doc.createElement('span');
      pill.className = statusPillClass(row.status);
      pill.textContent = row.status;
      const title = doc.createElement('span');
      title.className = 'sfdt-cell-code';
      title.textContent = row.id;
      head.append(pill, title);
      detail.appendChild(head);

      addFact(detail, 'Who', row.createdBy);
      addFact(detail, 'Started', formatDeployWhen(row.startDate));
      addFact(detail, 'Finished', formatDeployWhen(row.completedDate));
      addFact(detail, 'Duration', formatDeployDuration(row.startDate, row.completedDate));
      addFact(detail, 'Type', row.checkOnly ? 'Validate only' : 'Deploy');
      addFact(
        detail,
        'Components',
        formatCountTriple(row.componentsDeployed, row.componentsTotal, row.componentErrors),
      );
      addFact(
        detail,
        'Tests',
        formatCountTriple(row.testsCompleted, row.testsTotal, row.testErrors),
      );
      if (row.stateDetail) addFact(detail, 'Detail', row.stateDetail);
      if (row.errorMessage) addFact(detail, 'Error', row.errorMessage);
    }

    async function showDetail(row: DeployRow, tr: HTMLTableRowElement): Promise<void> {
      selectedRow?.removeAttribute('aria-current');
      selectedRow = tr;
      selectedId = row.id;
      tr.setAttribute('aria-current', 'true');
      renderDetailShell(row);
      if (!shouldFetchComponentErrors(row)) return;
      const seq = loadSeq;
      try {
        const soap = await api.apiSoap<unknown>(
          'Metadata',
          'checkDeployStatus',
          { id: row.id, includeDetails: true },
          { mutating: false },
        );
        if (seq !== loadSeq || selectedId !== row.id) return;
        renderFailures(shapeComponentFailures(soap));
      } catch (err) {
        if (seq !== loadSeq || selectedId !== row.id) return;
        const callout = doc.createElement('div');
        callout.className = 'sfdt-callout sfdt-warn';
        callout.setAttribute('role', 'status');
        callout.textContent = `Component errors unavailable: ${errorText(err)}`;
        detail.appendChild(callout);
      }
    }

    function renderRows(): void {
      const typed = filterField.value.trim();
      const rows = loaded.filter((r) => matchesFilter(r, typed.toLowerCase()));
      while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
      selectedRow = null;

      const noun = `deployment${loaded.length === 1 ? '' : 's'}`;
      status.textContent =
        rows.length === loaded.length
          ? `${loaded.length} ${noun}`
          : `${rows.length} of ${loaded.length} ${noun}`;

      if (rows.length === 0) {
        tbody.appendChild(
          emptyRow(loaded.length ? `No deployments match "${typed}".` : 'No recent deployments.'),
        );
        return;
      }

      for (const row of rows) {
        const tr = doc.createElement('tr');
        tr.classList.add('sfdt-clickable');
        tr.tabIndex = 0;
        tr.setAttribute(
          'aria-label',
          `Deployment ${row.status} by ${row.createdBy}${row.checkOnly ? ', validate only' : ''}`,
        );

        const statusCell = doc.createElement('td');
        const pill = doc.createElement('span');
        pill.className = statusPillClass(row.status);
        pill.textContent = row.status;
        statusCell.appendChild(pill);

        const who = doc.createElement('td');
        who.textContent = row.createdBy;

        const started = doc.createElement('td');
        started.className = 'sfdt-cell-code';
        started.textContent = formatDeployWhen(row.startDate);

        const finished = doc.createElement('td');
        finished.className = 'sfdt-cell-code';
        finished.textContent = formatDeployWhen(row.completedDate);

        const comps = doc.createElement('td');
        comps.className = 'sfdt-cell-code';
        comps.textContent = formatCountTriple(
          row.componentsDeployed,
          row.componentsTotal,
          row.componentErrors,
        );

        const tests = doc.createElement('td');
        tests.className = 'sfdt-cell-code';
        tests.textContent = formatCountTriple(row.testsCompleted, row.testsTotal, row.testErrors);

        const kind = doc.createElement('td');
        kind.textContent = row.checkOnly ? 'Validate' : 'Deploy';

        tr.append(statusCell, who, started, finished, comps, tests, kind);
        tr.addEventListener('click', () => void showDetail(row, tr));
        tr.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            void showDetail(row, tr);
          }
        });
        if (selectedId === row.id) {
          selectedRow = tr;
          tr.setAttribute('aria-current', 'true');
        }
        tbody.appendChild(tr);
      }
    }

    async function load(): Promise<void> {
      const seq = ++loadSeq;
      status.textContent = 'Loading deployments…';
      try {
        const result = await api.toolingQuery<RawDeployRequest>(
          buildDeployRequestQuery(DEFAULT_PAGE_SIZE),
        );
        if (seq !== loadSeq) return;
        loaded = shapeDeployRows(result.records ?? []);
        hideWarn();
        renderRows();
        syncAutoRefresh(loaded);
      } catch (err) {
        if (seq !== loadSeq) return;
        loaded = [];
        while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
        selectedRow = null;
        selectedId = null;
        detail.style.display = 'none';
        while (detail.firstChild) detail.removeChild(detail.firstChild);
        status.textContent = '';
        showWarn(err);
        tbody.appendChild(emptyRow('Deployment history is unavailable.'));
        stopAutoRefresh();
        setWatch(false);
        // Do not rethrow — a rejected DeployRequest query is a warn, not
        // feature.errored (CLI checkDeployHistory catch-all).
      }
    }

    filterField.addEventListener('input', renderRows);
    refreshBtn.addEventListener('click', () => void load());
    filterField.focus();
    await load();
  }

  return {
    manifest: {
      id: 'deploy-status',
      name: 'Deployment Status',
      contexts: [CONTEXTS.WORKSPACE, CONTEXTS.SETUP_OTHER, CONTEXTS.SETUP_FLOWS],
    },

    async onActivate() {
      const ctx = detectContext({ location: { href: win.location.href } }, doc);
      if (ctx === CONTEXTS.NONE) {
        showToast('Open a Salesforce page or the Workspace to view deployment status.', {
          doc,
          kind: 'warning',
        });
        return;
      }
      await open();
    },

    teardown() {
      close();
    },
  };
}
