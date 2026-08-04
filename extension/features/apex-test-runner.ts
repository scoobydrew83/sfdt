// Apex Test Runner (DIRECT, Workspace tool). Submits an async Apex test run via
// the Tooling REST `runTestsAsynchronous` endpoint, then polls `ApexTestRunResult`
// until the run reaches a terminal state and renders pass/fail counts plus any
// failing methods. Pure result-shaping is exported via `_apexTestRunnerTestApi`.

import { detectContext, CONTEXTS } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import {
  getSalesforceApi,
  type SalesforceApiClient,
} from '../lib/salesforce-api.js';
import { showToast } from '../ui/toast.js';
import { presentView, type ViewHandle } from '../ui/present-view.js';
import { button, toolbar } from '../lib/ui-controls.js';

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Raw row from `ApexTestResult` (Tooling API). */
export interface RawApexTestResultRow {
  Outcome?: string | null;
  MethodName?: string | null;
  Message?: string | null;
  ApexClass?: { Name?: string | null } | null;
}

export interface ApexTestSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  /** Failing methods only, as `Class.method` + message. */
  failures: Array<{ name: string; message: string }>;
}

/** ApexTestRunResult.Status values that mean the run is finished. */
export function isTerminalStatus(status: string | null | undefined): boolean {
  return status === 'Completed' || status === 'Failed' || status === 'Aborted';
}

/** Collapse per-method ApexTestResult rows into counts + a failing-method list. */
export function shapeTestResults(rows: RawApexTestResultRow[]): ApexTestSummary {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const failures: Array<{ name: string; message: string }> = [];
  for (const r of rows) {
    const outcome = r.Outcome ?? '';
    if (outcome === 'Pass') {
      passed += 1;
    } else if (outcome === 'Skip') {
      skipped += 1;
    } else {
      // Fail, CompileFail, or anything non-passing.
      failed += 1;
      const cls = r.ApexClass?.Name ?? '(unknown)';
      const method = r.MethodName ?? '(unknown)';
      failures.push({ name: `${cls}.${method}`, message: r.Message ?? '' });
    }
  }
  failures.sort((a, b) => a.name.localeCompare(b.name));
  return { total: rows.length, passed, failed, skipped, failures };
}

// Pass/fail banner accent. The band→colour map that used to live here was the
// fifth copy in the codebase; the colours are in lib/ui-styles.ts now.
const BAND_CALLOUT = { green: 'sfdt-ok', red: 'sfdt-bad' } as const;

// Test levels that need no class selection — RunSpecifiedTests is omitted
// because it requires a class list the Workspace can't supply cleanly.
const TEST_LEVELS = ['RunLocalTests', 'RunAllTestsInOrg'] as const;
type TestLevel = (typeof TEST_LEVELS)[number];

// ---------------------------------------------------------------------------
// Feature
// ---------------------------------------------------------------------------

export interface ApexTestRunnerOptions {
  doc?: Document;
  win?: Window;
  api?: SalesforceApiClient;
  /** Poll cadence; set to 0 in tests so the loop runs without real delays. */
  pollIntervalMs?: number;
  /** Safety cap so a never-finishing run can't poll forever. */
  maxPolls?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createApexTestRunnerFeature(options: ApexTestRunnerOptions = {}): Feature {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  const api = options.api ?? getSalesforceApi();
  const pollIntervalMs = options.pollIntervalMs ?? 1500;
  const maxPolls = options.maxPolls ?? 40;
  const apiVersion = api.apiVersion;

  let view: ViewHandle | null = null;

  function close(): void {
    view?.close();
    view = null;
  }

  function renderError(results: HTMLElement, status: HTMLSpanElement, message: string): void {
    const panel = doc.createElement('div');
    panel.classList.add('sfdt-console', 'sfdt-error');
    panel.textContent = message;
    results.appendChild(panel);
    status.textContent = 'Failed';
  }

  function renderSummary(results: HTMLElement, summary: ApexTestSummary, complete: boolean): void {
    const banner = doc.createElement('div');
    const band = summary.failed > 0 ? 'red' : 'green';
    banner.className = `sfdt-callout sfdt-below sfdt-row sfdt-baseline ${BAND_CALLOUT[band]}`;
    const big = doc.createElement('span');
    big.classList.add('sfdt-subhead');
    big.textContent = `${summary.passed} passed · ${summary.failed} failed`;
    const cap = doc.createElement('span');
    cap.className = 'sfdt-muted';
    cap.textContent =
      `${summary.total} method${summary.total === 1 ? '' : 's'}` +
      (summary.skipped > 0 ? `, ${summary.skipped} skipped` : '') +
      (complete ? '' : ' (run still in progress)');
    banner.appendChild(big);
    banner.appendChild(cap);
    results.appendChild(banner);

    if (summary.failures.length > 0) {
      for (const f of summary.failures) {
        const card = doc.createElement('div');
        card.style.cssText =
          'border: 1px solid var(--sfdt-color-error-border); border-radius: 4px; padding: 8px 10px; margin-bottom: 6px; background: var(--sfdt-color-error-bg-3);';
        const title = doc.createElement('div');
        title.style.cssText = 'font-weight: 600; font-size: 12px; color: var(--sfdt-color-error-text); word-break: break-all;';
        title.textContent = f.name;
        card.appendChild(title);
        if (f.message) {
          const msg = doc.createElement('div');
          msg.style.cssText = 'font-size: 11px; color: var(--sfdt-color-text); margin-top: 4px; white-space: pre-wrap;';
          msg.textContent = f.message;
          card.appendChild(msg);
        }
        results.appendChild(card);
      }
    } else if (summary.total > 0) {
      const ok = doc.createElement('div');
      ok.classList.add('sfdt-prose');
      ok.textContent = 'All tests passed.';
      results.appendChild(ok);
    } else {
      const empty = doc.createElement('div');
      empty.classList.add('sfdt-prose', 'sfdt-muted');
      empty.textContent = 'No test results returned for this run.';
      results.appendChild(empty);
    }
  }

  async function run(
    testLevel: TestLevel,
    results: HTMLElement,
    status: HTMLSpanElement,
  ): Promise<void> {
    while (results.firstChild) results.removeChild(results.firstChild);
    status.textContent = 'Submitting tests…';
    try {
      const jobId = await api.apiRequest<string>(
        'POST',
        `/services/data/${apiVersion}/tooling/runTestsAsynchronous`,
        { testLevel },
      );
      if (!jobId) {
        renderError(results, status, 'Salesforce did not return a test run id.');
        return;
      }
      const parentJobId = String(jobId);
      // Defense-in-depth: parentJobId is interpolated into SOQL below. Salesforce
      // ids are always 15/18-char alphanumeric — reject anything else so an
      // unexpected response shape can't inject into the query.
      if (!/^[A-Za-z0-9]{15,18}$/.test(parentJobId)) {
        renderError(results, status, `Unexpected test run id from Salesforce: ${parentJobId}`);
        return;
      }

      status.textContent = 'Running tests…';
      let complete = false;
      for (let i = 0; i < maxPolls; i += 1) {
        const runResult = await api.toolingQuery<{ Status?: string | null }>(
          `SELECT Status, MethodsEnqueued, MethodsCompleted, MethodsFailed FROM ApexTestRunResult WHERE AsyncApexJobId = '${parentJobId}'`,
        );
        const st = runResult.records[0]?.Status;
        if (isTerminalStatus(st)) {
          complete = true;
          break;
        }
        if (pollIntervalMs > 0) await sleep(pollIntervalMs);
        else await sleep(0);
      }

      const detail = await api.toolingQuery<RawApexTestResultRow>(
        `SELECT Outcome, MethodName, Message, ApexClass.Name FROM ApexTestResult WHERE AsyncApexJobId = '${parentJobId}'`,
      );
      const summary = shapeTestResults(detail.records);
      renderSummary(results, summary, complete);
      status.textContent = complete
        ? `${summary.failed} failure${summary.failed === 1 ? '' : 's'}`
        : 'Timed out waiting for completion';
    } catch (err) {
      renderError(results, status, err instanceof Error ? err.message : String(err));
    }
  }

  async function open(): Promise<void> {
    close();

    const body = doc.createElement('div');
    body.className = 'sfdt-view-body';
    // Toolbar at the top of the body (presentView's header is title + × only).
    const bar = toolbar(doc);
    const levelSelect = doc.createElement('select');
    levelSelect.className = 'sfdt-field sfdt-auto';
    for (const level of TEST_LEVELS) {
      const opt = doc.createElement('option');
      opt.value = level;
      opt.textContent = level;
      levelSelect.appendChild(opt);
    }

    const runBtn = button({ label: 'Run', iconName: 'play', variant: 'primary', small: true, doc });

    const status = doc.createElement('span');
    status.style.cssText = 'color: var(--sfdt-color-text-weak); font-size: 12px; margin-left: auto;';

    bar.append(levelSelect, runBtn, status);
    body.appendChild(bar);
    const main = doc.createElement('div');
    main.className = 'sfdt-view-main';
    body.appendChild(main);

    const results = doc.createElement('div');
    main.appendChild(results);

    view = presentView({
      title: 'Apex Test Runner',
      iconName: 'flask',
      body,
      doc,
      width: '760px',
      onClose: () => { view = null; },
    });

    runBtn.addEventListener('click', async () => {
      runBtn.disabled = true;
      await run(levelSelect.value as TestLevel, results, status);
      runBtn.disabled = false;
    });
  }

  return {
    manifest: {
      id: 'apex-test-runner',
      name: 'Apex Test Runner',
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
        showToast('Open a Salesforce page to run Apex tests.', { doc, kind: 'warning' });
        return;
      }
      await open();
    },
  };
}

export function _apexTestRunnerTestApi() {
  return { shapeTestResults, isTerminalStatus };
}
