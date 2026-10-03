import { detectContext, CONTEXTS } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import { createBridgeClient } from '../lib/sfdt-bridge.js';
import { buildLiveChecks, renderCheckRow, type CheckResult } from './org-health-checks.js';
import { getSalesforceApi, type SalesforceApiClient } from '../lib/salesforce-api.js';
import { loadSettings } from '../lib/settings.js';
import { showToast } from '../ui/toast.js';
import { presentView, type ViewHandle } from '../ui/present-view.js';
import { describeFinding, buildIndexEvidence, renderIndexMarkdown, type IndexEvidence } from '@sfdt/flow-core';
import type { OrgHealthResponseData, SfdtResponse } from '@sfdt/flow-core/bridge-contract';
import { button, toolbar } from '../lib/ui-controls.js';
import { BAND_CLASS } from './org-limits.js';
import { copyToClipboard } from '../ui/clipboard.js';

// ---------------------------------------------------------------------------
// Snapshot shapes (mirror src/lib/audit-runner.js / monitor-runner.js output)
// ---------------------------------------------------------------------------

type CheckStatus = 'ok' | 'warn' | 'fail' | 'error';

interface Check {
  id: string;
  title: string;
  status: CheckStatus;
  summary: string;
  findings: Array<Record<string, unknown>>;
}

interface Snapshot {
  org?: string;
  timestamp?: string;
  checks?: Check[];
  summary?: { ok?: number; warn?: number; fail?: number; error?: number };
}

// ---------------------------------------------------------------------------
// Pure helpers (exported directly for tests)
// ---------------------------------------------------------------------------


export function bandFor(status: string): 'green' | 'amber' | 'red' | 'grey' {
  if (status === 'ok') return 'green';
  if (status === 'warn') return 'amber';
  if (status === 'fail' || status === 'error') return 'red';
  return 'grey';
}

// describeFinding now lives in @sfdt/flow-core (imported above) so the CLI, GUI,
// and this panel render findings identically.

/** Normalise a snapshot's checks array, tolerating null/partial payloads. */
export function shapeChecks(snapshot: Snapshot | null | undefined): Check[] {
  const checks = snapshot?.checks;
  if (!Array.isArray(checks)) return [];
  return checks.map((c) => ({
    id: String(c.id ?? ''),
    title: String(c.title ?? c.id ?? 'Check'),
    status: (c.status ?? 'ok') as CheckStatus,
    summary: String(c.summary ?? ''),
    findings: Array.isArray(c.findings) ? c.findings : [],
  }));
}

/** Everything one run of the panel gathered — enough to re-render either view. */
export interface PanelState {
  live: CheckResult[];
  audit: Snapshot | null;
  monitor: Snapshot | null;
  /** Why the CLI checks are absent (bridge offline, unauthorised, …), or null. */
  offlineReason: string | null;
  /** The bridge payload, for "Copy JSON". */
  raw: unknown;
  /**
   * The org this browser is on (Organization.Id), so snapshots the CLI wrote
   * for a different org are never merged into this org's evidence. null when
   * it couldn't be read.
   */
  liveOrgId?: string | null;
}

/**
 * Group this run's checks under the AI-Readiness Index dimensions — the same
 * @sfdt/flow-core grouping `sfdt audit --index` uses. Evidence, not a score.
 */
export function indexEvidenceFor(state: PanelState): IndexEvidence {
  return buildIndexEvidence({
    audit: state.audit,
    monitor: state.monitor,
    live: state.live,
    liveOrgId: state.liveOrgId ?? null,
  });
}

// ---------------------------------------------------------------------------
// Feature
// ---------------------------------------------------------------------------

interface BridgeLike {
  call(
    request: { kind: 'org-health' },
    options?: { timeoutMs?: number },
  ): Promise<SfdtResponse>;
}

export interface OrgHealthOptions {
  doc?: Document;
  win?: Window;
  bridgeFactory?: () => Promise<BridgeLike>;
  /** Injected for the in-browser checks; defaults to the shared client. */
  api?: SalesforceApiClient;
}

/**
 * Checks that only the CLI can run (`sfdt audit`), listed so the panel can say
 * what it is missing. Titles, not ids — this is read by a person deciding
 * whether the CLI is worth installing.
 */
const CLI_ONLY_CHECKS: readonly string[] = [
  'MFA enforcement',
  'MFA readiness',
  'SOAP API logins',
  'Setup audit trail',
  'Connected apps',
  'Unused permission sets',
  'Unused Apex',
  'Unreferenced Apex',
  'Inactive flows',
  'Inactive validation rules',
  'Inactive workflow rules',
  'Missing field descriptions',
];

export function createOrgHealthFeature(options: OrgHealthOptions = {}): Feature {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
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

  const api = options.api ?? getSalesforceApi();
  const live = buildLiveChecks({ doc, win, api });

  /** This browser's org ID — best-effort; null means "couldn't tell". */
  async function readOrgId(): Promise<string | null> {
    try {
      const res = await api.query<{ Id?: string }>('SELECT Id FROM Organization LIMIT 1');
      const id = res.records?.[0]?.Id;
      return typeof id === 'string' && id ? id : null;
    } catch {
      return null;
    }
  }

  let view: ViewHandle | null = null;

  function close(): void {
    view?.close();
    view = null;
  }

  /**
   * What the CLI adds, shown as a locked list rather than an error.
   *
   * The 12 CLI-only check titles are named explicitly. A bare "bridge offline"
   * message tells the user something failed; this tells them what they are
   * missing and exactly how to get it — which is the whole reason these two
   * features were merged.
   */
  function buildDeeperChecksNotice(reason: string): HTMLElement {
    const section = doc.createElement('div');
    section.classList.add('sfdt-callout', 'sfdt-warn', 'sfdt-stack', 'sfdt-tight');

    const heading = doc.createElement('div');
    heading.classList.add('sfdt-subhead');
    heading.textContent = `${CLI_ONLY_CHECKS.length} deeper checks need the sfdt CLI`;
    section.appendChild(heading);

    const how = doc.createElement('div');
    how.classList.add('sfdt-msg');
    how.textContent = `Run \`sfdt ui\` in your Salesforce project to include them. (${reason})`;
    section.appendChild(how);

    const list = doc.createElement('ul');
    list.classList.add('sfdt-list', 'sfdt-flush-x');
    for (const title of CLI_ONLY_CHECKS) {
      const li = doc.createElement('li');
      li.textContent = title;
      list.appendChild(li);
    }
    section.appendChild(list);
    return section;
  }

  function renderSnapshot(container: HTMLElement, title: string, command: 'audit' | 'monitor', snapshot: Snapshot | null): void {
    const section = doc.createElement('div');
    section.style.cssText = 'margin-bottom: 16px;';

    const heading = doc.createElement('div');
    heading.classList.add('sfdt-subhead');
    const org = snapshot?.org ? ` · ${snapshot.org}` : '';
    heading.textContent = `${title}${org}`;
    section.appendChild(heading);

    const checks = shapeChecks(snapshot);
    if (checks.length === 0) {
      const empty = doc.createElement('div');
      empty.classList.add('sfdt-prose', 'sfdt-muted');
      empty.textContent = `No data. Run \`sfdt ${command} all\` to populate.`;
      section.appendChild(empty);
      container.appendChild(section);
      return;
    }

    for (const c of checks) {
      const row = doc.createElement('div');
      row.classList.add('sfdt-panel', 'sfdt-below');
      const head = doc.createElement('div');
      head.classList.add('sfdt-row');
      const dot = doc.createElement('span');
      dot.className = `sfdt-dot ${BAND_CLASS[bandFor(c.status)]}`;
      const titleEl = doc.createElement('span');
      titleEl.className = 'sfdt-subhead';
      titleEl.textContent = c.title;
      const summaryEl = doc.createElement('span');
      // Same rule as the live rows in org-health-checks.ts: a check summary can
      // be a failure message, and a Salesforce failure message is multi-line.
      // These rows come from the CLI snapshot rather than from a settled
      // rejection, but they are the same field rendered the same way, and half
      // a fix is the shape this guard keeps shipping.
      summaryEl.className = 'sfdt-muted sfdt-msg';
      summaryEl.textContent = c.summary;
      head.appendChild(dot);
      head.appendChild(titleEl);
      head.appendChild(summaryEl);
      row.appendChild(head);

      if (c.findings.length > 0) {
        const list = doc.createElement('ul');
        list.style.cssText = 'margin: 6px 0 0; padding-left: 18px; color: var(--sfdt-color-text); font-size: 11px;';
        for (const f of c.findings.slice(0, 25)) {
          const li = doc.createElement('li');
          li.textContent = describeFinding(f);
          list.appendChild(li);
        }
        if (c.findings.length > 25) {
          const li = doc.createElement('li');
          li.classList.add('sfdt-italic');
          li.textContent = `… and ${c.findings.length - 25} more`;
          list.appendChild(li);
        }
        row.appendChild(list);
      }
      section.appendChild(row);
    }
    container.appendChild(section);
  }

  function renderLiveSection(body: HTMLElement, rows: CheckResult[]): HTMLElement {
    const liveSection = doc.createElement('div');
    liveSection.classList.add('sfdt-below');
    const liveHeading = doc.createElement('div');
    liveHeading.classList.add('sfdt-subhead');
    liveHeading.textContent = 'In-browser checks';
    liveSection.appendChild(liveHeading);
    body.appendChild(liveSection);
    for (const r of rows) renderCheckRow(doc, liveSection, r);
    return liveSection;
  }

  /** The by-check view, rebuilt from a gathered state (no refetch). */
  function renderChecksView(body: HTMLElement, state: PanelState): void {
    while (body.firstChild) body.removeChild(body.firstChild);
    renderLiveSection(body, state.live);
    if (state.offlineReason !== null) {
      body.appendChild(buildDeeperChecksNotice(state.offlineReason));
      return;
    }
    renderSnapshot(body, 'Diagnostics & Audit', 'audit', state.audit);
    renderSnapshot(body, 'Monitoring', 'monitor', state.monitor);
  }

  /**
   * The by-dimension view: the same checks grouped under the eight AI-Readiness
   * Index dimensions. Each dimension shows the worst check under it — a pointer
   * for the person assessing the org, never a score.
   */
  function renderIndexView(body: HTMLElement, state: PanelState): void {
    while (body.firstChild) body.removeChild(body.firstChild);
    const evidence = indexEvidenceFor(state);

    const intro = doc.createElement('div');
    intro.classList.add('sfdt-prose', 'sfdt-muted', 'sfdt-below');
    intro.textContent =
      'Checks grouped by AI-Readiness Index dimension. A dimension shows its worst check — evidence to review, not a score.';
    body.appendChild(intro);

    if (evidence.warnings.length) {
      // Before any dimension: a pack that mixed two orgs would be worse than
      // no pack, so what was left out — and why — comes first.
      const callout = doc.createElement('div');
      callout.classList.add('sfdt-callout', 'sfdt-warn', 'sfdt-stack', 'sfdt-tight', 'sfdt-below');
      const list = doc.createElement('ul');
      list.classList.add('sfdt-list', 'sfdt-flush-x');
      for (const w of evidence.warnings) {
        const li = doc.createElement('li');
        li.classList.add('sfdt-msg');
        li.textContent = w;
        list.appendChild(li);
      }
      callout.appendChild(list);
      body.appendChild(callout);
    }

    for (const dim of evidence.dimensions) {
      const section = doc.createElement('div');
      section.classList.add('sfdt-panel', 'sfdt-below');
      const head = doc.createElement('div');
      head.classList.add('sfdt-row');
      const dot = doc.createElement('span');
      dot.className = `sfdt-dot ${BAND_CLASS[dim.status === 'none' ? 'none' : bandFor(dim.status)]}`;
      const titleEl = doc.createElement('span');
      titleEl.className = 'sfdt-subhead';
      titleEl.textContent = dim.title;
      const measures = doc.createElement('span');
      measures.className = 'sfdt-muted sfdt-msg';
      measures.textContent = dim.measures;
      head.append(dot, titleEl, measures);
      section.appendChild(head);

      const list = doc.createElement('ul');
      list.style.cssText = 'margin: 6px 0 0; padding-left: 18px; color: var(--sfdt-color-text); font-size: 11px;';
      if (dim.checks.length === 0) {
        const li = doc.createElement('li');
        li.classList.add('sfdt-italic');
        li.textContent = 'No automated evidence.';
        list.appendChild(li);
      }
      for (const c of dim.checks) {
        const li = doc.createElement('li');
        const cDot = doc.createElement('span');
        cDot.className = `sfdt-dot ${BAND_CLASS[bandFor(c.status)]}`;
        const text = doc.createElement('span');
        text.className = 'sfdt-msg';
        text.textContent = ` ${c.title} — ${c.summary}`;
        li.append(cDot, text);
        list.appendChild(li);
      }
      section.appendChild(list);

      if (dim.missing.some((m) => m.source !== 'live')) {
        const missing = doc.createElement('div');
        missing.classList.add('sfdt-muted', 'sfdt-msg');
        missing.style.cssText = 'margin-top: 6px; font-size: 11px;';
        const cli = dim.missing.filter((m) => m.source !== 'live').map((m) => `${m.source} ${m.id}`);
        missing.textContent = `Needs the CLI: ${cli.join(', ')}`;
        section.appendChild(missing);
      }

      const note = doc.createElement('div');
      note.classList.add('sfdt-muted', 'sfdt-italic', 'sfdt-msg');
      note.style.cssText = 'margin-top: 6px; font-size: 11px;';
      note.textContent = `Assessor: ${dim.manualNote}`;
      section.appendChild(note);

      body.appendChild(section);
    }

    if (state.offlineReason !== null) body.appendChild(buildDeeperChecksNotice(state.offlineReason));
  }

  async function fetchAndRender(body: HTMLElement, status: HTMLSpanElement): Promise<PanelState> {
    status.textContent = 'Running checks…';
    while (body.firstChild) body.removeChild(body.firstChild);

    // The five in-browser checks ALWAYS run and always render first. They need
    // no setup, so the panel is never empty and never a dead end — which is what
    // the separate "Org Health (Live)" feature existed to provide.
    const [liveRows, liveOrgId] = await Promise.all([live.run(), readOrgId()]);
    renderLiveSection(body, liveRows);
    const liveIssues = liveRows.filter((r) => r.status !== 'green').length;
    status.textContent = `${liveIssues} issue${liveIssues === 1 ? '' : 's'}`;

    const state: PanelState = { live: liveRows, audit: null, monitor: null, offlineReason: null, raw: null, liveOrgId };
    try {
      const bridge = await bridgeFactory();
      const response = await bridge.call({ kind: 'org-health' });
      if (!response.ok) {
        const hint =
          response.code === 'BRIDGE_OFFLINE'
            ? ' — run `sfdt ui` in your Salesforce project to start the bridge.'
            : response.code === 'BRIDGE_UNAUTHORIZED'
              ? ' — open extension settings and paste the bridge token from `~/.sfdt/bridge-token` (created when you run `sfdt ui`).'
              : '';
        // NOT an error state: the in-browser checks above already ran. This
        // says what the CLI would ADD, so the depth difference is discoverable
        // rather than being two tools the user has to know to compare.
        state.offlineReason = `${response.error}${hint}`;
        body.appendChild(buildDeeperChecksNotice(state.offlineReason));
        return state;
      }
      const data = (response.data ?? {}) as OrgHealthResponseData;
      state.audit = (data.audit?.data ?? null) as Snapshot | null;
      state.monitor = (data.monitor?.data ?? null) as Snapshot | null;
      state.raw = data;
      renderSnapshot(body, 'Diagnostics & Audit', 'audit', state.audit);
      renderSnapshot(body, 'Monitoring', 'monitor', state.monitor);
      const auditChecks = shapeChecks(state.audit);
      const monChecks = shapeChecks(state.monitor);
      if (auditChecks.length === 0 && monChecks.length === 0) {
        // No snapshots yet — don't imply a healthy org with "0 issue(s)".
        status.textContent = 'No data';
      } else {
        const issues = [...auditChecks, ...monChecks].filter((c) => c.status !== 'ok').length;
        status.textContent = `${issues} issue(s)`;
      }
      return state;
    } catch (err) {
      state.offlineReason = err instanceof Error ? err.message : String(err);
      body.appendChild(buildDeeperChecksNotice(state.offlineReason));
      return state;
    }
  }

  async function open(): Promise<void> {
    close();

    const body = doc.createElement('div');
    body.className = 'sfdt-view-body';
    // Status + actions as a real pinned strip. presentView's own header is just
    // the title + ×, so a view's controls belong at the top of its body — and as
    // a toolbar rather than a row floating inside the scroll region, so they
    // stay put while the checks scroll.
    const bar = toolbar(doc);
    const status = doc.createElement('span');
    status.className = 'sfdt-muted';
    const actions = doc.createElement('div');
    actions.className = 'sfdt-row sfdt-snug sfdt-toolbar-end';
    const refreshBtn = button({ label: 'Refresh', iconName: 'refresh', small: true, doc });
    const viewBtn = button({ label: 'Index view', iconName: 'compass', small: true, doc });
    const copyBtn = button({ label: 'Copy JSON', iconName: 'clipboard', small: true, doc });
    const packBtn = button({ label: 'Copy evidence pack', iconName: 'clipboard', small: true, doc });
    actions.append(refreshBtn, viewBtn, copyBtn, packBtn);
    bar.append(status, actions);
    body.appendChild(bar);

    const content = doc.createElement('div');
    content.className = 'sfdt-view-main';
    body.appendChild(content);

    view = presentView({
      title: 'Org Health',
      iconName: 'heart',
      body,
      doc,
      width: '760px',
      onClose: () => {
        view = null;
      },
    });

    // 'checks' = grouped by source (in-browser, audit, monitor); 'index' = the
    // same checks grouped by AI-Readiness Index dimension.
    let mode: 'checks' | 'index' = 'checks';
    const viewLabel = viewBtn.querySelector('.sfdt-btn-label');
    const renderMode = (state: PanelState): void => {
      if (mode === 'index') renderIndexView(content, state);
      else renderChecksView(content, state);
      if (viewLabel) viewLabel.textContent = mode === 'index' ? 'Check view' : 'Index view';
    };

    let state = await fetchAndRender(content, status);
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.disabled = true;
      state = await fetchAndRender(content, status);
      if (mode === 'index') renderMode(state);
      refreshBtn.disabled = false;
    });
    viewBtn.addEventListener('click', () => {
      mode = mode === 'index' ? 'checks' : 'index';
      renderMode(state);
    });
    copyBtn.addEventListener('click', async () => {
      await copyToClipboard(JSON.stringify(state.raw, null, 2), { doc, win: win, label: 'Org health copied as JSON' });
    });
    // Local clipboard only — the evidence never leaves the browser.
    packBtn.addEventListener('click', async () => {
      await copyToClipboard(renderIndexMarkdown(indexEvidenceFor(state)), {
        doc,
        win: win,
        label: 'Index evidence pack copied as Markdown',
      });
    });
  }

  return {
    manifest: {
      id: 'org-health',
      name: 'Org Health',
      contexts: [CONTEXTS.SETUP_FLOWS, CONTEXTS.SETUP_OTHER, CONTEXTS.FLOW_BUILDER],
    },

    async onActivate() {
      const ctx = detectContext({ location: { href: win.location.href } }, doc);
      if (ctx === CONTEXTS.NONE) {
        showToast('Open a Salesforce page to view org health.', { doc, kind: 'warning' });
        return;
      }
      await open();
    },
  };
}
