import { detectContext, CONTEXTS } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import {
  getSalesforceApi,
  type SalesforceApiClient,
} from '../lib/salesforce-api.js';
import { showToast } from '../ui/toast.js';
import { presentView, type ViewHandle } from '../ui/present-view.js';

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
  green: 'var(--sfdt-color-success)',
  amber: 'var(--sfdt-color-warning)',
  red: 'var(--sfdt-color-error)',
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

  let view: ViewHandle | null = null;

  function close(): void {
    view?.close();
    view = null;
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
        empty.style.cssText = 'padding: 12px; color: var(--sfdt-color-text-icon);';
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
          'border: 1px solid var(--sfdt-color-border); border-radius: 4px; padding: 10px; display: flex; flex-direction: column; gap: 6px;';
        const title = doc.createElement('div');
        title.style.cssText = 'font-weight: 600; font-size: 12px;';
        title.textContent = humaniseName(r.name);
        const usage = doc.createElement('div');
        usage.style.cssText = 'font-size: 11px; color: var(--sfdt-color-text-weak);';
        usage.textContent = `${r.used.toLocaleString()} / ${r.max.toLocaleString()}  (${(r.pct * 100).toFixed(1)}%)`;
        const bar = doc.createElement('div');
        bar.style.cssText =
          'height: 6px; background: var(--sfdt-color-bg); border-radius: 3px; overflow: hidden;';
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
    body.style.cssText = 'padding: 16px; overflow-y: auto; flex: 1; display: flex; flex-direction: column;';

    // Toolbar (status + actions) lives at the top of the body so it shows in both
    // the modal and the workspace tab — presentView's header is title + × only.
    const toolbar = doc.createElement('div');
    toolbar.style.cssText = 'display: flex; align-items: center; gap: 12px; margin-bottom: 12px;';
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

    const results = doc.createElement('div');
    body.appendChild(results);

    view = presentView({
      title: '🚦 Org Limits',
      body,
      doc,
      width: '760px',
      onClose: () => { view = null; },
    });

    let raw: unknown = await fetchAndRender(results, status);
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.disabled = true;
      raw = await fetchAndRender(results, status);
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
