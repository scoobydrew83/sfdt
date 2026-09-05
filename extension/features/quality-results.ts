// Quality Results (C-P5-1) — the Chrome surface for `sfdt quality`.
//
// Renders the latest Salesforce Code Analyzer run the CLI recorded, fetched
// over the bridge's read-only `quality.results` kind (protocol 1.4). The kind
// reads `logs/quality-latest.json` through the same `readQuality` parser the
// dashboard's GET /api/quality uses, so this panel and the dashboard cannot
// disagree about a run — and it works over the HTTP bridge AND the native
// messaging host, both of which implement the kind.
//
// Read-only by construction. A Code Analyzer sweep is minutes of work; nothing
// here starts one. With no recorded run the panel says how to record one
// rather than showing an empty (and therefore falsely clean) result.
//
// The J-1 invariant lives in lib/quality-viewmodel.ts and is the reason that
// file exists: a SKIPPED scan reports zero violations exactly like a clean one,
// so it is rendered as SKIPPED with the reason, never as a pass.

import { detectContext, CONTEXTS } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import { getSalesforceApi, type SalesforceApiClient } from '../lib/salesforce-api.js';
import { createBridgeClient } from '../lib/sfdt-bridge.js';
import { loadSettings } from '../lib/settings.js';
import { escapeSoql } from '../lib/escape.js';
import { showToast } from '../ui/toast.js';
import { presentView, type ViewHandle } from '../ui/present-view.js';
import { renderSfError } from '../ui/panels.js';
import { recordActivity } from '../lib/activity-log.js';
import { button, toolbar } from '../lib/ui-controls.js';
import { bridgeErrorHint } from './bridge-tools.js';
import type { SfdtResponse } from '@sfdt/flow-core/bridge-contract';
import {
  toQualityViewModel,
  filterGroups,
  buildSetupUrl,
  statusPillClass,
  severityPillClass,
  summaryLine,
  SEVERITY_ORDER,
  type QualityComponent,
  type QualityFileGroup,
  type QualitySeverity,
  type QualityViewModel,
  type RawQualitySnapshot,
} from '../lib/quality-viewmodel.js';

interface BridgeLike {
  call(
    request: { kind: 'quality.results' },
    options?: { timeoutMs?: number },
  ): Promise<SfdtResponse>;
}

export interface QualityResultsOptions {
  doc?: Document;
  win?: Window;
  api?: SalesforceApiClient;
  bridgeFactory?: () => Promise<BridgeLike>;
}

/** Human status label. SKIPPED reads as "skipped", never as a pass. */
export function statusLabel(status: QualityViewModel['status']): string {
  switch (status) {
    case 'PASS':
      return 'Pass';
    case 'FAIL':
      return 'Issues found';
    case 'SKIPPED':
      return 'Scan skipped';
    default:
      return 'No run recorded';
  }
}

/**
 * The Tooling query that resolves a component to its Setup record Id. Pure so
 * the SOQL is testable without a live org; returns null for component types
 * that have no Tooling row to look up (a Flow, an Aura bundle).
 */
export function buildComponentIdQuery(component: QualityComponent): string | null {
  if (!component.toolingObject) return null;
  const name = escapeSoql(component.name);
  const field = component.toolingObject === 'LightningComponentBundle' ? 'DeveloperName' : 'Name';
  return `SELECT Id FROM ${component.toolingObject} WHERE ${field} = '${name}' LIMIT 1`;
}

export function createQualityResultsFeature(options: QualityResultsOptions = {}): Feature {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  const api = options.api ?? getSalesforceApi();
  const bridgeFactory =
    options.bridgeFactory ??
    (async (): Promise<BridgeLike> => {
      const settings = await loadSettings();
      return createBridgeClient({
        token: settings.bridge.token,
        preferredTransport: settings.bridge.preferredTransport,
        localhostPort: settings.bridge.localhostPort,
        connectNativeImpl: chrome.runtime?.connectNative?.bind(chrome.runtime),
      });
    });

  let view: ViewHandle | null = null;

  function close(): void {
    view?.close();
    view = null;
  }

  /**
   * Open a violation's component in Setup. Resolves the record Id through the
   * Tooling API so the link lands on the component itself; when that is not
   * possible (no Tooling object for the type, or the org has no such row) it
   * falls back to the type's Setup list rather than a dead link.
   */
  async function openInSetup(component: QualityComponent): Promise<void> {
    const hostname = win.location.hostname;
    let recordId: string | null = null;
    const soql = buildComponentIdQuery(component);
    if (soql) {
      try {
        const result = await api.toolingQuery<{ Id?: string }>(soql);
        recordId = result.records?.[0]?.Id ?? null;
      } catch {
        // Fall through to the list page — a failed lookup is not worth an
        // error panel when a usable destination exists.
        recordId = null;
      }
    }
    if (!recordId) {
      showToast(`${component.name} not found in this org — opening the Setup list.`, {
        doc,
        kind: 'info',
      });
    }
    win.open(buildSetupUrl(hostname, component, recordId), '_blank', 'noopener');
  }

  function issueRow(issue: QualityFileGroup['issues'][number]): HTMLElement {
    const tr = doc.createElement('tr');

    const sev = doc.createElement('td');
    const sevPill = doc.createElement('span');
    sevPill.className = severityPillClass(issue.severity);
    sevPill.textContent = issue.severity;
    sev.appendChild(sevPill);

    const line = doc.createElement('td');
    line.className = 'sfdt-cell-code sfdt-num';
    line.textContent = issue.line > 0 ? String(issue.line) : '—';

    const rule = doc.createElement('td');
    rule.className = 'sfdt-cell-code';
    rule.textContent = issue.rule || '(no rule id)';

    const engine = doc.createElement('td');
    engine.className = 'sfdt-cell-code';
    engine.textContent = issue.engine || '—';

    const message = doc.createElement('td');
    message.className = 'sfdt-cell-pre';
    message.textContent = issue.message;

    tr.append(sev, line, rule, engine, message);
    return tr;
  }

  function groupBlock(group: QualityFileGroup): HTMLElement {
    const details = doc.createElement('details');
    details.classList.add('sfdt-card', 'sfdt-below');

    const summary = doc.createElement('summary');
    summary.classList.add('sfdt-row', 'sfdt-tight');

    const worst = doc.createElement('span');
    worst.className = severityPillClass(group.worst);
    worst.textContent = group.worst;

    const name = doc.createElement('span');
    name.classList.add('sfdt-cell-strong');
    name.textContent = group.fileLabel;

    const path = doc.createElement('span');
    path.className = 'sfdt-faint';
    path.textContent = group.file;

    const count = doc.createElement('span');
    count.className = 'sfdt-muted';
    count.textContent = `${group.issues.length} issue${group.issues.length === 1 ? '' : 's'}`;

    summary.append(worst, name, path, count);
    details.appendChild(summary);

    const inner = doc.createElement('div');
    inner.classList.add('sfdt-card-section');

    if (group.component) {
      const component = group.component;
      const openBtn = button({
        label: 'Open in Setup',
        iconName: 'external',
        small: true,
        title: `Open ${component.name} in Salesforce Setup`,
        doc,
      });
      openBtn.addEventListener('click', () => void openInSetup(component));
      const actions = doc.createElement('div');
      actions.classList.add('sfdt-row', 'sfdt-tight', 'sfdt-below');
      actions.appendChild(openBtn);
      inner.appendChild(actions);
    }

    const wrap = doc.createElement('div');
    wrap.className = 'sfdt-scrollbox';
    const table = doc.createElement('table');
    table.className = 'sfdt-table sfdt-align-top';
    const thead = doc.createElement('thead');
    const headRow = doc.createElement('tr');
    for (const label of ['Severity', 'Line', 'Rule', 'Engine', 'Message']) {
      const th = doc.createElement('th');
      th.textContent = label;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    const tbody = doc.createElement('tbody');
    for (const issue of group.issues) tbody.appendChild(issueRow(issue));
    table.append(thead, tbody);
    wrap.appendChild(table);
    inner.appendChild(wrap);

    details.appendChild(inner);
    return details;
  }

  async function open(): Promise<void> {
    close();

    const body = doc.createElement('div');
    body.className = 'sfdt-view-body';

    const bar = toolbar(doc);
    const refreshBtn = button({
      label: 'Refresh',
      iconName: 'refresh',
      variant: 'primary',
      small: true,
      doc,
    });

    const severitySelect = doc.createElement('select');
    severitySelect.className = 'sfdt-field sfdt-auto';
    severitySelect.setAttribute('aria-label', 'Filter issues by severity');
    for (const [value, label] of [
      ['', 'All severities'],
      ...SEVERITY_ORDER.map((s) => [s, s[0]!.toUpperCase() + s.slice(1)] as const),
    ] as ReadonlyArray<readonly [string, string]>) {
      const opt = doc.createElement('option');
      opt.value = value;
      opt.textContent = label;
      severitySelect.appendChild(opt);
    }

    const engineSelect = doc.createElement('select');
    engineSelect.className = 'sfdt-field sfdt-auto';
    engineSelect.setAttribute('aria-label', 'Filter issues by analyzer engine');

    const statusPill = doc.createElement('span');
    statusPill.className = 'sfdt-pill';
    const status = doc.createElement('span');
    status.className = 'sfdt-muted';

    bar.append(refreshBtn, severitySelect, engineSelect, statusPill, status);
    body.appendChild(bar);

    const main = doc.createElement('div');
    main.className = 'sfdt-view-main';
    body.appendChild(main);

    const notice = doc.createElement('div');
    notice.style.display = 'none';
    const results = doc.createElement('div');
    main.append(notice, results);

    let model: QualityViewModel | null = null;

    function renderResults(): void {
      while (results.firstChild) results.removeChild(results.firstChild);
      if (!model) return;
      const severity = (severitySelect.value || null) as QualitySeverity | null;
      const engine = engineSelect.value || null;
      const groups = filterGroups(model.groups, { severity, engine });

      if (model.groups.length === 0) {
        // Nothing to filter. PASS says so; SKIPPED/UNAVAILABLE already carry a
        // notice above and must not also claim a clean result here.
        if (model.status === 'PASS') {
          const clean = doc.createElement('p');
          clean.classList.add('sfdt-muted');
          clean.textContent = 'No violations in the last recorded run.';
          results.appendChild(clean);
        }
        return;
      }

      if (groups.length === 0) {
        const none = doc.createElement('p');
        none.classList.add('sfdt-muted');
        none.textContent = 'No issues match the current filters.';
        results.appendChild(none);
        return;
      }
      for (const group of groups) results.appendChild(groupBlock(group));
    }

    function renderModel(next: QualityViewModel): void {
      model = next;

      statusPill.className = statusPillClass(next.status);
      statusPill.textContent = statusLabel(next.status);

      const parts: string[] = [];
      if (next.total > 0) parts.push(summaryLine(next.counts));
      if (next.timestamp) parts.push(new Date(next.timestamp).toLocaleString());
      status.textContent = parts.join(' · ');

      while (notice.firstChild) notice.removeChild(notice.firstChild);
      if (next.notice) {
        notice.style.display = '';
        notice.className = 'sfdt-callout sfdt-warn sfdt-msg';
        const heading = doc.createElement('div');
        heading.classList.add('sfdt-subhead');
        heading.textContent =
          next.status === 'SKIPPED'
            ? 'Static analysis was SKIPPED — this is not a clean result.'
            : 'No quality run recorded yet.';
        const detail = doc.createElement('p');
        detail.textContent = next.notice;
        notice.append(heading, detail);
      } else {
        notice.style.display = 'none';
      }

      // Rebuild the engine filter from the run's own attribution, preserving
      // the current choice when it still exists.
      const previous = engineSelect.value;
      while (engineSelect.firstChild) engineSelect.removeChild(engineSelect.firstChild);
      const all = doc.createElement('option');
      all.value = '';
      all.textContent = 'All engines';
      engineSelect.appendChild(all);
      for (const engine of next.engines) {
        const opt = doc.createElement('option');
        opt.value = engine;
        opt.textContent = engine;
        engineSelect.appendChild(opt);
      }
      engineSelect.value = next.engines.includes(previous) ? previous : '';
      engineSelect.disabled = next.engines.length === 0;

      renderResults();
    }

    async function load(): Promise<void> {
      while (results.firstChild) results.removeChild(results.firstChild);
      while (notice.firstChild) notice.removeChild(notice.firstChild);
      notice.style.display = 'none';
      statusPill.className = 'sfdt-pill';
      statusPill.textContent = 'Loading';
      status.textContent = '';
      model = null;
      refreshBtn.disabled = true;
      try {
        const bridge = await bridgeFactory();
        // The bridge's default (~8s), not LONG_RUNNING_TIMEOUT_MS. This kind
        // reads one already-written file off disk — it never starts a scan, which
        // is the whole reason the kind is snapshot-only. Borrowing the 60s
        // deploy/retrieve/AI timeout meant a hung host left the panel on
        // "Loading" for a minute before surfacing anything. (sfdt-private#21)
        const response = await bridge.call({ kind: 'quality.results' });
        if (!response.ok) {
          statusPill.className = 'sfdt-pill sfdt-warning';
          statusPill.textContent = 'Unavailable';
          results.appendChild(
            renderSfError(`${response.error}${bridgeErrorHint(response)}`, { doc }),
          );
          void recordActivity({
            featureId: 'quality-results',
            action: 'Quality Results',
            status: 'failed',
          });
          return;
        }
        renderModel(toQualityViewModel((response as { data?: RawQualitySnapshot }).data));
        void recordActivity({
          featureId: 'quality-results',
          action: 'Quality Results',
          status: 'success',
        });
      } catch (err) {
        statusPill.className = 'sfdt-pill sfdt-warning';
        statusPill.textContent = 'Unavailable';
        results.appendChild(renderSfError(err, { doc }));
        void recordActivity({
          featureId: 'quality-results',
          action: 'Quality Results',
          status: 'failed',
        });
      } finally {
        refreshBtn.disabled = false;
      }
    }

    view = presentView({
      title: 'Quality Results',
      iconName: 'check',
      body,
      doc,
      width: '860px',
      onClose: () => {
        view = null;
      },
    });

    refreshBtn.addEventListener('click', () => void load());
    severitySelect.addEventListener('change', renderResults);
    engineSelect.addEventListener('change', renderResults);
    refreshBtn.focus();
    await load();
  }

  return {
    manifest: {
      id: 'quality-results',
      name: 'Quality Results',
      contexts: [CONTEXTS.WORKSPACE, CONTEXTS.SETUP_OTHER, CONTEXTS.SETUP_FLOWS],
    },

    async onActivate() {
      const ctx = detectContext({ location: { href: win.location.href } }, doc);
      if (ctx === CONTEXTS.NONE) {
        showToast('Open a Salesforce page or the Workspace to view quality results.', {
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
