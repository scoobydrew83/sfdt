import { detectContext, CONTEXTS } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import {
  getSalesforceApi,
  type SalesforceApiClient,
} from '../lib/salesforce-api.js';
import { showToast } from '../ui/toast.js';
import { presentView, type ViewHandle } from '../ui/present-view.js';
import { button, toolbar } from '../lib/ui-controls.js';
import { meterCard, meterGrid, type MeterTone } from '../ui/meter-card.js';
import { renderSfError } from '../ui/panels.js';
import { copyToClipboard } from '../ui/clipboard.js';

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

// Exported so the Workspace Overview's health tiles render the same bands and
// labels as the full Org Limits tool — one definition, not two that drift.
/**
 * Band → meter-fill CLASS. Was a token string set as an inline background at
 * each call site; the band thresholds are policy and stay here, the colours
 * live in lib/ui-styles.ts so a palette change reaches every meter at once.
 */
/** Band → shared meter tone, for meterCard(). */
export const BAND_TONE: Record<'green' | 'amber' | 'red' | 'grey' | 'none', MeterTone> = {
  green: 'ok',
  amber: 'warn',
  red: 'bad',
  grey: 'idle',
  none: 'idle',
};

export const BAND_CLASS: Record<'green' | 'amber' | 'red' | 'grey' | 'none', string> = {
  green: 'sfdt-ok',
  amber: 'sfdt-warn',
  red: 'sfdt-bad',
  // Two spellings of "no data" because the five features that each had a
  // private copy of this map spelled it differently. One map, both keys, rather
  // than a sixth copy.
  grey: 'sfdt-idle',
  none: 'sfdt-idle',
};

export function humaniseName(camel: string): string {
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
        empty.classList.add('sfdt-prose', 'sfdt-muted');
        empty.textContent = 'No limits returned.';
        body.appendChild(empty);
        return raw;
      }
      const grid = meterGrid(doc);
      for (const r of rows) {
        grid.appendChild(
          meterCard({
            doc,
            label: humaniseName(r.name),
            value: `${r.used.toLocaleString()} / ${r.max.toLocaleString()}`,
            sub: `· ${(r.pct * 100).toFixed(1)}%`,
            pct: r.pct,
            // Org limits are usage: a full bar is bad, unlike coverage.
            tone: BAND_TONE[bandFor(r.pct)],
          }),
        );
      }
      body.appendChild(grid);
      return raw;
    } catch (err) {
      body.appendChild(renderSfError(err, { doc }));
      status.textContent = 'Failed';
      return null;
    }
  }

  async function open(): Promise<void> {
    close();

    const body = doc.createElement('div');
    body.className = 'sfdt-view-body';
    // Toolbar (status + actions) lives at the top of the body so it shows in both
    // the modal and the workspace tab — presentView's header is title + × only.
    const bar = toolbar(doc);
    const status = doc.createElement('span');
    status.className = 'sfdt-muted';
    const actions = doc.createElement('div');
    actions.style.cssText = 'display: flex; gap: 6px; margin-left: auto;';
    const refreshBtn = button({ label: 'Refresh', iconName: 'refresh', small: true, doc });
    const copyBtn = button({ label: 'Copy JSON', iconName: 'clipboard', small: true, doc });
    actions.appendChild(refreshBtn);
    actions.appendChild(copyBtn);
    bar.appendChild(status);
    bar.appendChild(actions);
    body.appendChild(bar);
    const main = doc.createElement('div');
    main.className = 'sfdt-view-main';
    body.appendChild(main);

    const results = doc.createElement('div');
    main.appendChild(results);

    view = presentView({
      title: 'Org Limits',
      iconName: 'gauge',
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
      await copyToClipboard(JSON.stringify(raw, null, 2), { doc, win: win, label: 'Limits copied as JSON' });
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
