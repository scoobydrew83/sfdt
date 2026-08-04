import { detectContext, CONTEXTS } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import { createBridgeClient } from '../lib/sfdt-bridge.js';
import { buildLiveChecks, renderCheckRow } from './org-health-checks.js';
import { getSalesforceApi, type SalesforceApiClient } from '../lib/salesforce-api.js';
import { loadSettings } from '../lib/settings.js';
import { showToast } from '../ui/toast.js';
import { presentView, type ViewHandle } from '../ui/present-view.js';
import { describeFinding } from '@sfdt/flow-core';
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

  const live = buildLiveChecks({ doc, win, api: options.api ?? getSalesforceApi() });

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
      summaryEl.className = 'sfdt-muted';
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

  async function fetchAndRender(body: HTMLElement, status: HTMLSpanElement): Promise<unknown> {
    status.textContent = 'Running checks…';
    while (body.firstChild) body.removeChild(body.firstChild);

    // The five in-browser checks ALWAYS run and always render first. They need
    // no setup, so the panel is never empty and never a dead end — which is what
    // the separate "Org Health (Live)" feature existed to provide.
    const liveSection = doc.createElement('div');
    liveSection.classList.add('sfdt-below');
    const liveHeading = doc.createElement('div');
    liveHeading.classList.add('sfdt-subhead');
    liveHeading.textContent = 'In-browser checks';
    liveSection.appendChild(liveHeading);
    body.appendChild(liveSection);

    const liveRows = await live.run();
    for (const r of liveRows) renderCheckRow(doc, liveSection, r);
    const liveIssues = liveRows.filter((r) => r.status !== 'green').length;
    status.textContent = `${liveIssues} issue${liveIssues === 1 ? '' : 's'}`;

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
        body.appendChild(buildDeeperChecksNotice(`${response.error}${hint}`));
        return null;
      }
      const data = (response.data ?? {}) as OrgHealthResponseData;
      const audit = (data.audit?.data ?? null) as Snapshot | null;
      const monitor = (data.monitor?.data ?? null) as Snapshot | null;
      renderSnapshot(body, 'Diagnostics & Audit', 'audit', audit);
      renderSnapshot(body, 'Monitoring', 'monitor', monitor);
      const auditChecks = shapeChecks(audit);
      const monChecks = shapeChecks(monitor);
      if (auditChecks.length === 0 && monChecks.length === 0) {
        // No snapshots yet — don't imply a healthy org with "0 issue(s)".
        status.textContent = 'No data';
      } else {
        const issues = [...auditChecks, ...monChecks].filter((c) => c.status !== 'ok').length;
        status.textContent = `${issues} issue(s)`;
      }
      return data;
    } catch (err) {
      body.appendChild(
        buildDeeperChecksNotice(err instanceof Error ? err.message : String(err)),
      );
      return null;
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
    const copyBtn = button({ label: 'Copy JSON', iconName: 'clipboard', small: true, doc });
    actions.append(refreshBtn, copyBtn);
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

    let raw: unknown = await fetchAndRender(content, status);
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.disabled = true;
      raw = await fetchAndRender(content, status);
      refreshBtn.disabled = false;
    });
    copyBtn.addEventListener('click', async () => {
      await copyToClipboard(JSON.stringify(raw, null, 2), { doc, win: win, label: 'Org health copied as JSON' });
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
