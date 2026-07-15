import { detectContext, CONTEXTS } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import { createBridgeClient } from '../lib/sfdt-bridge.js';
import { loadSettings } from '../lib/settings.js';
import { showToast } from '../ui/toast.js';
import { presentView, type ViewHandle } from '../ui/present-view.js';
import { describeFinding } from '@sfdt/flow-core';
import type { OrgHealthResponseData, SfdtResponse } from '@sfdt/flow-core/bridge-contract';

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

const BAND_COLOUR: Record<'green' | 'amber' | 'red' | 'grey', string> = {
  green: 'var(--sfdt-color-success)',
  amber: 'var(--sfdt-color-warning)',
  red: 'var(--sfdt-color-error)',
  grey: 'var(--sfdt-color-text-icon)',
};

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
}

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

  let view: ViewHandle | null = null;

  function close(): void {
    view?.close();
    view = null;
  }

  function renderSnapshot(container: HTMLElement, title: string, command: 'audit' | 'monitor', snapshot: Snapshot | null): void {
    const section = doc.createElement('div');
    section.style.cssText = 'margin-bottom: 16px;';

    const heading = doc.createElement('div');
    heading.style.cssText = 'font-weight: 600; font-size: 13px; margin-bottom: 8px;';
    const org = snapshot?.org ? ` · ${snapshot.org}` : '';
    heading.textContent = `${title}${org}`;
    section.appendChild(heading);

    const checks = shapeChecks(snapshot);
    if (checks.length === 0) {
      const empty = doc.createElement('div');
      empty.style.cssText = 'padding: 8px 0; color: var(--sfdt-color-text-icon); font-size: 12px;';
      empty.textContent = `No data. Run \`sfdt ${command} all\` to populate.`;
      section.appendChild(empty);
      container.appendChild(section);
      return;
    }

    for (const c of checks) {
      const row = doc.createElement('div');
      row.style.cssText = 'border: 1px solid var(--sfdt-color-border); border-radius: 4px; padding: 8px 10px; margin-bottom: 6px;';

      const head = doc.createElement('div');
      head.style.cssText = 'display: flex; align-items: center; gap: 8px;';
      const dot = doc.createElement('span');
      dot.style.cssText = `width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; background: ${BAND_COLOUR[bandFor(c.status)]};`;
      const titleEl = doc.createElement('span');
      titleEl.style.cssText = 'font-weight: 600; font-size: 12px;';
      titleEl.textContent = c.title;
      const summaryEl = doc.createElement('span');
      summaryEl.style.cssText = 'color: var(--sfdt-color-text-weak); font-size: 11px;';
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
          li.style.fontStyle = 'italic';
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
    status.textContent = 'Loading…';
    while (body.firstChild) body.removeChild(body.firstChild);
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
        const errorPanel = doc.createElement('div');
        errorPanel.style.cssText =
          'border: 1px solid var(--sfdt-color-error); background: var(--sfdt-color-error-bg); color: var(--sfdt-color-error-text); padding: 8px 12px; border-radius: 4px; font-size: 13px;';
        errorPanel.textContent = `${response.error}${hint}`;
        body.appendChild(errorPanel);
        status.textContent = 'Failed';
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
      const errorPanel = doc.createElement('div');
      errorPanel.style.cssText =
        'border: 1px solid var(--sfdt-color-error); background: var(--sfdt-color-error-bg); color: var(--sfdt-color-error-text); padding: 8px 12px; border-radius: 4px; font-size: 13px;';
      errorPanel.textContent = err instanceof Error ? err.message : String(err);
      body.appendChild(errorPanel);
      status.textContent = 'Failed';
      return null;
    }
  }

  async function open(): Promise<void> {
    close();

    const body = doc.createElement('div');
    body.style.cssText = 'padding: 16px; overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 12px;';

    // Header extras (status + refresh/copy) move to a toolbar at the top of the
    // body — presentView's own header is just the title + ×.
    const toolbar = doc.createElement('div');
    toolbar.style.cssText = 'display: flex; gap: 12px; align-items: center;';
    const status = doc.createElement('span');
    status.style.cssText = 'color: var(--sfdt-color-text-weak); font-size: 12px;';
    const actions = doc.createElement('div');
    actions.style.cssText = 'display: flex; gap: 6px; margin-left: auto;';
    const refreshBtn = doc.createElement('button');
    refreshBtn.textContent = 'Refresh';
    refreshBtn.style.cssText =
      'padding: 4px 10px; border: 1px solid var(--sfdt-color-border); background: var(--sfdt-color-surface); border-radius: 4px; cursor: pointer; font-size: 12px;';
    const copyBtn = doc.createElement('button');
    copyBtn.textContent = 'Copy JSON';
    copyBtn.style.cssText =
      'padding: 4px 10px; border: 1px solid var(--sfdt-color-border); background: var(--sfdt-color-surface); border-radius: 4px; cursor: pointer; font-size: 12px;';
    actions.appendChild(refreshBtn);
    actions.appendChild(copyBtn);
    toolbar.appendChild(status);
    toolbar.appendChild(actions);
    body.appendChild(toolbar);

    const content = doc.createElement('div');
    body.appendChild(content);

    view = presentView({
      title: '🏥 Org Health',
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
      try {
        await win.navigator.clipboard.writeText(JSON.stringify(raw, null, 2));
        showToast('Org health copied as JSON', { doc, kind: 'success' });
      } catch {
        showToast('Could not copy to clipboard', { doc, kind: 'error' });
      }
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
