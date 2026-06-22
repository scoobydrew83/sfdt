import { detectContext, CONTEXTS } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import { createBridgeClient } from '../lib/sfdt-bridge.js';
import { loadSettings } from '../lib/settings.js';
import { showToast } from '../ui/toast.js';
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
// Pure helpers (exported for tests via _orgHealthTestApi)
// ---------------------------------------------------------------------------

const BAND_COLOUR: Record<'green' | 'amber' | 'red' | 'grey', string> = {
  green: '#04844b',
  amber: '#fe9339',
  red: '#c23934',
  grey: '#80868d',
};

export function bandFor(status: string): 'green' | 'amber' | 'red' | 'grey' {
  if (status === 'ok') return 'green';
  if (status === 'warn') return 'amber';
  if (status === 'fail' || status === 'error') return 'red';
  return 'grey';
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : v == null ? undefined : String(v);
}

/** One-line description for an arbitrary finding object (mirrors the CLI/GUI). */
export function describeFinding(f: Record<string, unknown>): string {
  if (f.name != null && f.apiVersion != null) {
    return `${f.type ? `${str(f.type)} ` : ''}${str(f.name)} (API ${str(f.apiVersion)})`;
  }
  if (f.username != null) {
    return `${str(f.name) ?? str(f.username)} <${str(f.username)}>${f.lastLogin ? ` — last login ${str(f.lastLogin)}` : ''}`;
  }
  if (f.action != null) return `${str(f.date)}: ${str(f.action)} (${str(f.section)}) by ${str(f.user)}`;
  if (f.job != null) return `${str(f.date)}: ${str(f.job)} (${str(f.type)}) — ${str(f.errors)} error(s)`;
  if (f.name != null && f.max != null) return `${str(f.name)}: ${str(f.used)}/${str(f.max)}`;
  if (f.score != null) return `score ${str(f.score)}% (floor ${str(f.floor)}%)`;
  if (f.name != null) return String(f.name);
  return JSON.stringify(f);
}

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

  let overlay: HTMLDivElement | null = null;

  function close(): void {
    overlay?.remove();
    overlay = null;
  }

  function renderSnapshot(container: HTMLElement, title: string, snapshot: Snapshot | null): void {
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
      empty.style.cssText = 'padding: 8px 0; color: #80868d; font-size: 12px;';
      empty.textContent = `No data. Run \`sfdt ${title.toLowerCase().includes('audit') ? 'audit' : 'monitor'} all\` to populate.`;
      section.appendChild(empty);
      container.appendChild(section);
      return;
    }

    for (const c of checks) {
      const row = doc.createElement('div');
      row.style.cssText = 'border: 1px solid #d8dde6; border-radius: 4px; padding: 8px 10px; margin-bottom: 6px;';

      const head = doc.createElement('div');
      head.style.cssText = 'display: flex; align-items: center; gap: 8px;';
      const dot = doc.createElement('span');
      dot.style.cssText = `width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; background: ${BAND_COLOUR[bandFor(c.status)]};`;
      const titleEl = doc.createElement('span');
      titleEl.style.cssText = 'font-weight: 600; font-size: 12px;';
      titleEl.textContent = c.title;
      const summaryEl = doc.createElement('span');
      summaryEl.style.cssText = 'color: #54698d; font-size: 11px;';
      summaryEl.textContent = c.summary;
      head.appendChild(dot);
      head.appendChild(titleEl);
      head.appendChild(summaryEl);
      row.appendChild(head);

      if (c.findings.length > 0) {
        const list = doc.createElement('ul');
        list.style.cssText = 'margin: 6px 0 0; padding-left: 18px; color: #3e3e3c; font-size: 11px;';
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
              ? ' — open extension settings and pair the bridge token (`sfdt extension token`).'
              : '';
        const errorPanel = doc.createElement('div');
        errorPanel.style.cssText =
          'border: 1px solid #c23934; background: #fef2f1; color: #c23934; padding: 8px 12px; border-radius: 4px; font-size: 13px;';
        errorPanel.textContent = `${response.error}${hint}`;
        body.appendChild(errorPanel);
        status.textContent = 'Failed';
        return null;
      }
      const data = (response.data ?? {}) as OrgHealthResponseData;
      const audit = (data.audit?.data ?? null) as Snapshot | null;
      const monitor = (data.monitor?.data ?? null) as Snapshot | null;
      renderSnapshot(body, 'Diagnostics & Audit', audit);
      renderSnapshot(body, 'Monitoring', monitor);
      const auditIssues = shapeChecks(audit).filter((c) => c.status !== 'ok').length;
      const monIssues = shapeChecks(monitor).filter((c) => c.status !== 'ok').length;
      status.textContent = `${auditIssues + monIssues} issue(s)`;
      return data;
    } catch (err) {
      const errorPanel = doc.createElement('div');
      errorPanel.style.cssText =
        'border: 1px solid #c23934; background: #fef2f1; color: #c23934; padding: 8px 12px; border-radius: 4px; font-size: 13px;';
      errorPanel.textContent = err instanceof Error ? err.message : String(err);
      body.appendChild(errorPanel);
      status.textContent = 'Failed';
      return null;
    }
  }

  async function open(): Promise<void> {
    close();

    overlay = doc.createElement('div');
    overlay.className = 'sfut-org-health-overlay';
    overlay.style.cssText =
      'position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 100020; display: flex; align-items: center; justify-content: center; font-family: system-ui, sans-serif;';
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    const modal = doc.createElement('div');
    modal.style.cssText =
      'background: #fff; border-radius: 4px; width: 760px; max-width: 95vw; max-height: 90vh; display: flex; flex-direction: column;';

    const header = doc.createElement('div');
    header.style.cssText =
      'padding: 12px 16px; border-bottom: 1px solid #d8dde6; display: flex; justify-content: space-between; align-items: center;';
    const headerLeft = doc.createElement('div');
    headerLeft.style.cssText = 'display: flex; gap: 12px; align-items: center; font-weight: 600;';
    const headerLabel = doc.createElement('span');
    headerLabel.textContent = '🏥 Org Health';
    const status = doc.createElement('span');
    status.style.cssText = 'color: #54698d; font-size: 12px; font-weight: normal;';
    headerLeft.appendChild(headerLabel);
    headerLeft.appendChild(status);

    const headerRight = doc.createElement('div');
    headerRight.style.cssText = 'display: flex; gap: 6px;';
    const refreshBtn = doc.createElement('button');
    refreshBtn.textContent = 'Refresh';
    refreshBtn.style.cssText =
      'padding: 4px 10px; border: 1px solid #d8dde6; background: #fff; border-radius: 4px; cursor: pointer; font-size: 12px;';
    const copyBtn = doc.createElement('button');
    copyBtn.textContent = 'Copy JSON';
    copyBtn.style.cssText =
      'padding: 4px 10px; border: 1px solid #d8dde6; background: #fff; border-radius: 4px; cursor: pointer; font-size: 12px;';
    const closeBtn = doc.createElement('button');
    closeBtn.textContent = '×';
    closeBtn.style.cssText = 'background: none; border: 0; font-size: 22px; cursor: pointer; margin-left: 4px;';
    closeBtn.addEventListener('click', close);
    headerRight.appendChild(refreshBtn);
    headerRight.appendChild(copyBtn);
    headerRight.appendChild(closeBtn);
    header.appendChild(headerLeft);
    header.appendChild(headerRight);
    modal.appendChild(header);

    const body = doc.createElement('div');
    body.style.cssText = 'padding: 16px; overflow-y: auto; flex: 1;';
    modal.appendChild(body);

    overlay.appendChild(modal);
    doc.body.appendChild(overlay);

    let raw: unknown = await fetchAndRender(body, status);
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.disabled = true;
      raw = await fetchAndRender(body, status);
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

export function _orgHealthTestApi() {
  return { bandFor, describeFinding, shapeChecks };
}
