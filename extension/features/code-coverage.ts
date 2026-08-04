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
import { button, toolbar } from '../lib/ui-controls.js';
import { meterCard, meterGrid, type MeterTone } from '../ui/meter-card.js';
import { emptyPanel } from '../ui/panels.js';

// Per-class coverage shaping/banding now lives in @sfdt/flow-core so the Chrome
// viewer, the GUI Coverage page, and `sfdt coverage` band identically. These
// aliases keep the historical local names (and this module's test) working.
export const shapeCoverage = shapeClassCoverage;
export const coverageBand = classCoverageBand;
export type RawCoverageRow = RawClassCoverageRow;
export type CoverageRow = ClassCoverageRow;

// Band → meter tone. Coverage INVERTS the usual reading: high is healthy here,
// where a high API-limit figure is an incident. That is why meterCard() takes a
// tone rather than deriving one — the shared usageTone() would paint 95%
// coverage red.
const BAND_TONE: Record<'green' | 'amber' | 'red' | 'none', MeterTone> = {
  green: 'ok',
  amber: 'warn',
  red: 'bad',
  none: 'idle',
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

      // Org-wide summary, as the same card as everything below it — the version
      // this replaces was a bespoke banner with its own border, radius and type
      // scale, so the headline number looked unrelated to the figures it summed.
      const orgFrac = typeof orgPct === 'number' ? orgPct / 100 : null;
      const summary = meterCard({
        doc,
        label: 'Org-wide Apex coverage',
        value: typeof orgPct === 'number' ? `${orgPct}%` : '—',
        sub: '· 75% required to deploy',
        pct: orgFrac ?? 0,
        tone: BAND_TONE[coverageBand(orgFrac)],
      });
      summary.classList.add('sfdt-below');
      results.appendChild(summary);

      if (rows.length === 0) {
        // Says WHY it is empty: ApexCodeCoverageAggregate only holds the last
        // test run's results, so no rows means nobody has run tests — not that
        // coverage is zero.
        results.appendChild(
          emptyPanel('No coverage data yet.', {
            hint: 'Salesforce only reports coverage from the last test run. Run Apex tests in this org first.',
            iconName: 'gauge',
            doc,
          }),
        );
        return;
      }

      const grid = meterGrid(doc);
      for (const r of rows) {
        grid.appendChild(
          meterCard({
            doc,
            label: r.name,
            value: pctLabel(r.pct),
            sub: `· ${r.covered}/${r.total} lines`,
            pct: r.pct ?? 0,
            tone: BAND_TONE[coverageBand(r.pct)],
          }),
        );
      }
      results.appendChild(grid);
    } catch (err) {
      const errorPanel = doc.createElement('div');
      errorPanel.classList.add('sfdt-console', 'sfdt-error');
      errorPanel.textContent = err instanceof Error ? err.message : String(err);
      results.appendChild(errorPanel);
      status.textContent = 'Failed';
    }
  }

  async function open(): Promise<void> {
    close();

    const body = doc.createElement('div');
    body.className = 'sfdt-view-body';
    // Toolbar (status + refresh) lives at the top of the body so it shows in both
    // the modal and the workspace tab — presentView's header is title + × only.
    const bar = toolbar(doc);
    const status = doc.createElement('span');
    status.className = 'sfdt-muted';
    const refreshBtn = button({ label: 'Refresh', iconName: 'refresh', small: true, doc });
    refreshBtn.classList.add('sfdt-toolbar-end');
    bar.appendChild(status);
    bar.appendChild(refreshBtn);
    body.appendChild(bar);
    const main = doc.createElement('div');
    main.className = 'sfdt-view-main';
    body.appendChild(main);

    const results = doc.createElement('div');
    main.appendChild(results);

    view = presentView({
      title: 'Apex Code Coverage',
      iconName: 'gauge',
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
