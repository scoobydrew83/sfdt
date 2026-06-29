// Flow Quality Scan — DIRECT (no bridge). Fetches a Flow's Metadata via the
// Tooling API and runs the shared @sfdt/flow-core quality pipeline in the
// browser, so it works for any user on any org without `sfdt ui` running. Same
// flow-core code the CLI bridge and GUI use → byte-identical scores.

import { detectContext, CONTEXTS } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import { getSalesforceApi, type SalesforceApiClient } from '../lib/salesforce-api.js';
import { showToast } from '../ui/toast.js';
import { presentView, type ViewHandle } from '../ui/present-view.js';
import { runFlowQuality, type FlowQualityReport } from '@sfdt/flow-core';

function bandColour(score: number | null): string {
  if (score === null) return '#b0adab';
  if (score >= 80) return '#04844b';
  if (score >= 60) return '#fe9339';
  return '#c23934';
}

export interface FlowQualityFeatureOptions {
  doc?: Document;
  win?: Window;
  api?: SalesforceApiClient;
}

export function createFlowQualityFeature(options: FlowQualityFeatureOptions = {}): Feature {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  const api = options.api ?? getSalesforceApi();

  let view: ViewHandle | null = null;
  function close(): void {
    view?.close();
    view = null;
  }

  function renderScore(results: HTMLElement, report: FlowQualityReport): void {
    const score = typeof report.summary.overallScore === 'number' ? report.summary.overallScore : null;
    const banner = doc.createElement('div');
    banner.style.cssText = `margin-bottom: 14px; padding: 12px 14px; border-radius: 6px; border: 1px solid #d8dde6; border-left: 4px solid ${bandColour(score)}; display: flex; align-items: baseline; gap: 10px;`;
    const big = doc.createElement('span');
    big.style.cssText = 'font-size: 22px; font-weight: 700;';
    big.textContent = score === null ? '—' : String(score);
    const cap = doc.createElement('span');
    cap.style.cssText = 'font-size: 12px; color: #54698d;';
    const fams = report.issueFamilies.length;
    cap.textContent = `${report.summary.rating ?? 'quality score'} · ${fams} issue famil${fams === 1 ? 'y' : 'ies'}`;
    banner.append(big, cap);
    results.appendChild(banner);

    const counts = (report.summary.severityCounts ?? {}) as Record<string, number>;
    const entries = Object.entries(counts);
    if (entries.length > 0) {
      const list = doc.createElement('ul');
      list.style.cssText = 'margin: 0; padding-left: 18px; color: #3e3e3c; font-size: 12px;';
      for (const [sev, n] of entries) {
        const li = doc.createElement('li');
        li.textContent = `${sev}: ${n}`;
        list.appendChild(li);
      }
      results.appendChild(list);
    }
  }

  async function open(): Promise<void> {
    close();

    const body = doc.createElement('div');
    body.style.cssText = 'padding: 16px; overflow-y: auto; flex: 1; display: flex; flex-direction: column;';

    const toolbar = doc.createElement('div');
    toolbar.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-bottom: 12px;';
    const input = doc.createElement('input');
    input.type = 'text';
    input.placeholder = 'Flow API name, e.g. My_Flow';
    input.style.cssText =
      'flex: 1; min-width: 180px; padding: 5px 8px; border: 1px solid #d8dde6; border-radius: 4px; font-size: 13px;';
    const runBtn = doc.createElement('button');
    runBtn.textContent = 'Scan';
    runBtn.style.cssText =
      'padding: 5px 14px; border: 1px solid #0070d2; background: #0070d2; color: #fff; border-radius: 4px; cursor: pointer; font-size: 13px;';
    const status = doc.createElement('span');
    status.style.cssText = 'color: #54698d; font-size: 12px;';
    toolbar.append(input, runBtn, status);
    body.appendChild(toolbar);

    const results = doc.createElement('div');
    body.appendChild(results);

    view = presentView({
      title: '✅ Flow Quality Scan',
      body,
      doc,
      width: '720px',
      onClose: () => { view = null; },
    });

    const run = async (): Promise<void> => {
      const name = input.value.trim();
      while (results.firstChild) results.removeChild(results.firstChild);
      if (!name) {
        status.textContent = 'Enter a Flow API name.';
        return;
      }
      status.textContent = 'Scanning…';
      runBtn.disabled = true;
      try {
        const record = (await api.getFlowMetadata(name)) as { Metadata?: unknown };
        // Cast to runFlowQuality's input type (not `as never`) so a future signature
        // change surfaces as a compile error here instead of an opaque runtime throw.
        const metadata = (record.Metadata ?? record) as Parameters<typeof runFlowQuality>[0];
        renderScore(results, runFlowQuality(metadata, { flowApiName: name }));
        status.textContent = 'Done';
      } catch (err) {
        const panel = doc.createElement('div');
        panel.style.cssText =
          'border: 1px solid #c23934; background: #fef2f1; color: #c23934; padding: 8px 12px; border-radius: 4px; font-size: 13px;';
        panel.textContent = err instanceof Error ? err.message : String(err);
        results.appendChild(panel);
        status.textContent = 'Failed';
      } finally {
        runBtn.disabled = false;
      }
    };
    runBtn.addEventListener('click', run);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void run();
    });
  }

  return {
    manifest: {
      id: 'flow-quality',
      name: 'Flow Quality Scan',
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
        showToast('Open a Salesforce page to scan a Flow.', { doc, kind: 'warning' });
        return;
      }
      await open();
    },
  };
}

export function _flowQualityTestApi() {
  return { runFlowQuality, bandColour };
}
