import { detectContext, CONTEXTS } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import {
  getSalesforceApi,
  type SalesforceApiClient,
} from '../lib/salesforce-api.js';
import { showToast } from '../ui/toast.js';
import { presentView, type ViewHandle } from '../ui/present-view.js';
import {
  shapeClassCoverage,
  classCoverageBand,
  type RawClassCoverageRow,
  type ClassCoverageRow,
} from '@sfdt/flow-core';

// Per-class coverage shaping/banding now lives in @sfdt/flow-core so the Chrome
// viewer, the GUI Coverage page, and `sfdt coverage` band identically. These
// aliases keep the historical local names (and this module's test) working.
export const shapeCoverage = shapeClassCoverage;
export const coverageBand = classCoverageBand;
export type RawCoverageRow = RawClassCoverageRow;
export type CoverageRow = ClassCoverageRow;

const BAND_COLOUR: Record<'green' | 'amber' | 'red' | 'none', string> = {
  green: 'var(--sfdt-color-success)',
  amber: 'var(--sfdt-color-warning)',
  red: 'var(--sfdt-color-error)',
  none: 'var(--sfdt-color-text-disabled)',
};

export interface CodeCoverageOptions {
  doc?: Document;
  win?: Window;
  api?: SalesforceApiClient;
}

export function createCodeCoverageFeature(options: CodeCoverageOptions = {}): Feature {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  const api = options.api ?? getSalesforceApi();

  let view: ViewHandle | null = null;

  function close(): void {
    view?.close();
    view = null;
  }

  function pctLabel(pct: number | null): string {
    return pct === null ? '—' : `${(pct * 100).toFixed(1)}%`;
  }

  async function fetchAndRender(results: HTMLElement, status: HTMLSpanElement): Promise<void> {
    status.textContent = 'Loading…';
    while (results.firstChild) results.removeChild(results.firstChild);
    try {
      const [orgWide, perClass] = await Promise.all([
        api.toolingQuery<{ PercentCovered?: number }>(
          'SELECT PercentCovered FROM ApexOrgWideCoverage',
        ),
        api.toolingQuery<RawCoverageRow>(
          'SELECT ApexClassOrTrigger.Name, NumLinesCovered, NumLinesUncovered FROM ApexCodeCoverageAggregate',
        ),
      ]);

      const rows = shapeCoverage(perClass.records);
      const orgPct = orgWide.records[0]?.PercentCovered;
      status.textContent = `${rows.length} component${rows.length === 1 ? '' : 's'}`;

      // Org-wide summary banner.
      const summary = doc.createElement('div');
      const orgFrac = typeof orgPct === 'number' ? orgPct / 100 : null;
      summary.style.cssText = `margin-bottom: 14px; padding: 12px 14px; border-radius: 6px; border: 1px solid var(--sfdt-color-border); border-left: 4px solid ${BAND_COLOUR[coverageBand(orgFrac)]}; display: flex; align-items: baseline; gap: 10px;`;
      const big = doc.createElement('span');
      big.style.cssText = 'font-size: 22px; font-weight: 700;';
      big.textContent = typeof orgPct === 'number' ? `${orgPct}%` : '—';
      const cap = doc.createElement('span');
      cap.style.cssText = 'font-size: 12px; color: var(--sfdt-color-text-weak);';
      cap.textContent = 'org-wide Apex coverage (75% required to deploy)';
      summary.appendChild(big);
      summary.appendChild(cap);
      results.appendChild(summary);

      if (rows.length === 0) {
        const empty = doc.createElement('div');
        empty.style.cssText = 'padding: 12px; color: var(--sfdt-color-text-icon);';
        empty.textContent = 'No coverage data. Run Apex tests in this org first.';
        results.appendChild(empty);
        return;
      }

      const grid = doc.createElement('div');
      grid.style.cssText =
        'display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px;';
      for (const r of rows) {
        const card = doc.createElement('div');
        card.style.cssText =
          'border: 1px solid var(--sfdt-color-border); border-radius: 4px; padding: 10px; display: flex; flex-direction: column; gap: 6px;';
        const title = doc.createElement('div');
        title.style.cssText = 'font-weight: 600; font-size: 12px; word-break: break-all;';
        title.textContent = r.name;
        const bar = doc.createElement('div');
        bar.style.cssText = 'height: 6px; background: var(--sfdt-color-bg); border-radius: 3px; overflow: hidden;';
        const fill = doc.createElement('div');
        const band = coverageBand(r.pct);
        fill.style.cssText = `height: 100%; width: ${((r.pct ?? 0) * 100).toFixed(1)}%; background: ${BAND_COLOUR[band]};`;
        bar.appendChild(fill);
        const usage = doc.createElement('div');
        usage.style.cssText = 'font-size: 11px; color: var(--sfdt-color-text-weak);';
        usage.textContent = `${pctLabel(r.pct)} — ${r.covered}/${r.total} lines`;
        card.appendChild(title);
        card.appendChild(bar);
        card.appendChild(usage);
        grid.appendChild(card);
      }
      results.appendChild(grid);
    } catch (err) {
      const errorPanel = doc.createElement('div');
      errorPanel.style.cssText =
        'border: 1px solid var(--sfdt-color-error); background: var(--sfdt-color-error-bg); color: var(--sfdt-color-error); padding: 8px 12px; border-radius: 4px; font-size: 13px;';
      errorPanel.textContent = err instanceof Error ? err.message : String(err);
      results.appendChild(errorPanel);
      status.textContent = 'Failed';
    }
  }

  async function open(): Promise<void> {
    close();

    const body = doc.createElement('div');
    body.style.cssText = 'padding: 16px; overflow-y: auto; flex: 1; display: flex; flex-direction: column;';

    // Toolbar (status + refresh) lives at the top of the body so it shows in both
    // the modal and the workspace tab — presentView's header is title + × only.
    const toolbar = doc.createElement('div');
    toolbar.style.cssText = 'display: flex; align-items: center; gap: 10px; margin-bottom: 12px;';
    const status = doc.createElement('span');
    status.style.cssText = 'color: var(--sfdt-color-text-weak); font-size: 12px;';
    const refreshBtn = doc.createElement('button');
    refreshBtn.textContent = 'Refresh';
    refreshBtn.style.cssText =
      'margin-left: auto; padding: 4px 10px; border: 1px solid var(--sfdt-color-border); background: var(--sfdt-color-surface); border-radius: 4px; cursor: pointer; font-size: 12px;';
    toolbar.appendChild(status);
    toolbar.appendChild(refreshBtn);
    body.appendChild(toolbar);

    const results = doc.createElement('div');
    body.appendChild(results);

    view = presentView({
      title: '📊 Apex Code Coverage',
      body,
      doc,
      width: '820px',
      onClose: () => { view = null; },
    });

    refreshBtn.addEventListener('click', async () => {
      refreshBtn.disabled = true;
      await fetchAndRender(results, status);
      refreshBtn.disabled = false;
    });
    await fetchAndRender(results, status);
  }

  return {
    manifest: {
      id: 'apex-coverage',
      name: 'Apex Code Coverage',
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
        showToast('Open a Salesforce page to view Apex coverage.', { doc, kind: 'warning' });
        return;
      }
      await open();
    },
  };
}

export function _codeCoverageTestApi() {
  return { shapeCoverage, coverageBand };
}
