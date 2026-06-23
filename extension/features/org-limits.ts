import { detectContext, CONTEXTS } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import {
  getSalesforceApi,
  type SalesforceApiClient,
} from '../lib/salesforce-api.js';
import { showToast } from '../ui/toast.js';

export interface LimitRow {
  name: string;
  max: number;
  used: number;
  remaining: number;
  pct: number;
}

export function shapeLimits(
  raw: Record<string, { Max: number; Remaining: number }>,
): LimitRow[] {
  const rows: LimitRow[] = [];
  for (const [name, entry] of Object.entries(raw)) {
    if (!entry || typeof entry.Max !== 'number' || typeof entry.Remaining !== 'number') continue;
    const used = Math.max(0, entry.Max - entry.Remaining);
    const pct = entry.Max > 0 ? used / entry.Max : 0;
    rows.push({ name, max: entry.Max, used, remaining: entry.Remaining, pct });
  }
  rows.sort((a, b) => b.pct - a.pct || a.name.localeCompare(b.name));
  return rows;
}

export function bandFor(pct: number): 'green' | 'amber' | 'red' {
  if (pct >= 0.9) return 'red';
  if (pct >= 0.7) return 'amber';
  return 'green';
}

const BAND_COLOUR: Record<'green' | 'amber' | 'red', string> = {
  green: '#04844b',
  amber: '#fe9339',
  red: '#c23934',
};

function humaniseName(camel: string): string {
  return camel.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

export interface OrgLimitsOptions {
  doc?: Document;
  win?: Window;
  api?: SalesforceApiClient;
}

export function createOrgLimitsFeature(options: OrgLimitsOptions = {}): Feature {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  const api = options.api ?? getSalesforceApi();

  let overlay: HTMLDivElement | null = null;

  function close(): void {
    overlay?.remove();
    overlay = null;
  }

  async function fetchAndRender(body: HTMLElement, status: HTMLSpanElement): Promise<unknown> {
    status.textContent = 'Loading…';
    while (body.firstChild) body.removeChild(body.firstChild);
    try {
      const raw = await api.limits();
      const rows = shapeLimits(raw);
      status.textContent = `${rows.length} limits`;
      if (rows.length === 0) {
        const empty = doc.createElement('div');
        empty.style.cssText = 'padding: 12px; color: #80868d;';
        empty.textContent = 'No limits returned.';
        body.appendChild(empty);
        return raw;
      }
      const grid = doc.createElement('div');
      grid.style.cssText =
        'display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px;';
      for (const r of rows) {
        const card = doc.createElement('div');
        card.style.cssText =
          'border: 1px solid #d8dde6; border-radius: 4px; padding: 10px; display: flex; flex-direction: column; gap: 6px;';
        const title = doc.createElement('div');
        title.style.cssText = 'font-weight: 600; font-size: 12px;';
        title.textContent = humaniseName(r.name);
        const usage = doc.createElement('div');
        usage.style.cssText = 'font-size: 11px; color: #54698d;';
        usage.textContent = `${r.used.toLocaleString()} / ${r.max.toLocaleString()}  (${(r.pct * 100).toFixed(1)}%)`;
        const bar = doc.createElement('div');
        bar.style.cssText =
          'height: 6px; background: #f3f3f3; border-radius: 3px; overflow: hidden;';
        const fill = doc.createElement('div');
        const band = bandFor(r.pct);
        fill.style.cssText = `height: 100%; width: ${Math.min(100, r.pct * 100).toFixed(1)}%; background: ${BAND_COLOUR[band]};`;
        bar.appendChild(fill);
        card.appendChild(title);
        card.appendChild(bar);
        card.appendChild(usage);
        grid.appendChild(card);
      }
      body.appendChild(grid);
      return raw;
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
    overlay.className = 'sfdt-org-limits-overlay';
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
    headerLabel.textContent = '🚦 Org Limits';
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
    closeBtn.style.cssText =
      'background: none; border: 0; font-size: 22px; cursor: pointer; margin-left: 4px;';
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
        showToast('Limits copied as JSON', { doc, kind: 'success' });
      } catch {
        showToast('Could not copy to clipboard', { doc, kind: 'error' });
      }
    });
  }

  return {
    manifest: {
      id: 'org-limits',
      name: 'Org Limits',
      contexts: [
        CONTEXTS.SETUP_FLOWS,
        CONTEXTS.SETUP_OTHER,
        CONTEXTS.FLOW_BUILDER,
        CONTEXTS.FLOW_TRIGGER_EXPLORER,
      ],
    },

    async onActivate() {
      const ctx = detectContext({ location: { href: win.location.href } }, doc);
      if (ctx === CONTEXTS.NONE) {
        showToast('Open a Salesforce page to view org limits.', { doc, kind: 'warning' });
        return;
      }
      await open();
    },
  };
}

export function _orgLimitsTestApi() {
  return { shapeLimits, bandFor };
}
