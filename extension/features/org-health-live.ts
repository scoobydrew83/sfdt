import {
  type Band,
  type CheckBody,
  type RawOrgWideCoverageRow,
  type RawUserRow,
  type RawLicenseRow,
  type RawApexVersionRow,
  coverageBand,
  usageBand,
  inactiveBand,
  worstBand,
  summariseCoverage,
  summariseInactiveUsers,
  summariseLicenses,
  summariseApiVersions,
  summariseLimits,
} from '@sfdt/flow-core';
import { detectContext, CONTEXTS } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import {
  getSalesforceApi,
  type SalesforceApiClient,
} from '../lib/salesforce-api.js';
import { showToast } from '../ui/toast.js';
import { presentView, type ViewHandle } from '../ui/present-view.js';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------
// Band/CheckBody, the band fns, the summarise* fns and the Raw* row types all
// live in the shared @sfdt/flow-core rulebook (imported above) so the CLI, GUI
// and this Chrome feature band findings from ONE set of thresholds. This file
// keeps only the fetch (salesforce-api), the checks[] descriptors and rendering.

/** One check's outcome plus the id/title attached by this feature. */
export interface CheckResult extends CheckBody {
  id: string;
  title: string;
}

const BAND_COLOUR: Record<Band, string> = {
  green: 'var(--sfdt-color-success)',
  amber: 'var(--sfdt-color-warning)',
  red: 'var(--sfdt-color-error)',
};

// ---------------------------------------------------------------------------
// Feature
// ---------------------------------------------------------------------------

export interface OrgHealthLiveOptions {
  doc?: Document;
  win?: Window;
  api?: SalesforceApiClient;
}

interface CheckDescriptor {
  id: string;
  title: string;
  run: () => Promise<CheckBody>;
}

export function createOrgHealthLiveFeature(options: OrgHealthLiveOptions = {}): Feature {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  const api = options.api ?? getSalesforceApi();

  let view: ViewHandle | null = null;

  function close(): void {
    view?.close();
    view = null;
  }

  // Each check owns its own query so one failing SOQL/Tooling call can't kill
  // the panel — Promise.allSettled turns a rejection into a red "could not run" row.
  const checks: CheckDescriptor[] = [
    {
      id: 'apex-coverage',
      title: 'Apex coverage',
      run: async () =>
        summariseCoverage(
          (await api.toolingQuery<RawOrgWideCoverageRow>('SELECT PercentCovered FROM ApexOrgWideCoverage')).records,
        ),
    },
    {
      id: 'inactive-users',
      title: 'Inactive users',
      run: async () =>
        summariseInactiveUsers(
          (
            await api.query<RawUserRow>(
              'SELECT Id, Name, LastLoginDate FROM User WHERE IsActive = true AND (LastLoginDate < LAST_N_DAYS:90 OR LastLoginDate = null) ORDER BY LastLoginDate NULLS FIRST LIMIT 50',
            )
          ).records,
        ),
    },
    {
      id: 'license-utilisation',
      title: 'License utilisation',
      run: async () =>
        summariseLicenses(
          (
            await api.query<RawLicenseRow>(
              "SELECT Name, TotalLicenses, UsedLicenses FROM UserLicense WHERE Status = 'Active'",
            )
          ).records,
        ),
    },
    {
      id: 'apex-api-version',
      title: 'Apex API-version spread',
      run: async () =>
        summariseApiVersions(
          (await api.toolingQuery<RawApexVersionRow>('SELECT ApiVersion FROM ApexClass')).records,
        ),
    },
    {
      id: 'org-limits',
      title: 'Org limits near cap',
      run: async () => summariseLimits(await api.limits()),
    },
  ];

  function renderRow(results: HTMLElement, check: CheckResult): void {
    const row = doc.createElement('div');
    row.style.cssText = 'border: 1px solid var(--sfdt-color-border); border-radius: 4px; padding: 8px 10px; margin-bottom: 6px;';

    const head = doc.createElement('div');
    head.style.cssText = 'display: flex; align-items: center; gap: 8px;';
    const dot = doc.createElement('span');
    dot.style.cssText = `width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; background: ${BAND_COLOUR[check.status]};`;
    const titleEl = doc.createElement('span');
    titleEl.style.cssText = 'font-weight: 600; font-size: 12px;';
    titleEl.textContent = check.title;
    const summaryEl = doc.createElement('span');
    summaryEl.style.cssText = 'color: var(--sfdt-color-text-weak); font-size: 11px;';
    summaryEl.textContent = check.summary;
    head.append(dot, titleEl, summaryEl);
    row.appendChild(head);

    if (check.findings.length > 0) {
      const list = doc.createElement('ul');
      list.style.cssText = 'margin: 6px 0 0; padding-left: 18px; color: var(--sfdt-color-text); font-size: 11px;';
      for (const f of check.findings.slice(0, 25)) {
        const li = doc.createElement('li');
        li.textContent = f;
        list.appendChild(li);
      }
      if (check.findings.length > 25) {
        const li = doc.createElement('li');
        li.style.fontStyle = 'italic';
        li.textContent = `… and ${check.findings.length - 25} more`;
        list.appendChild(li);
      }
      row.appendChild(list);
    }
    results.appendChild(row);
  }

  async function fetchAndRender(results: HTMLElement, status: HTMLSpanElement): Promise<void> {
    status.textContent = 'Running checks…';
    while (results.firstChild) results.removeChild(results.firstChild);
    try {
      const settled = await Promise.allSettled(checks.map((c) => c.run()));
      const rows: CheckResult[] = settled.map((s, i) => {
        const c = checks[i]!;
        if (s.status === 'fulfilled') return { id: c.id, title: c.title, ...s.value };
        const reason = s.reason instanceof Error ? s.reason.message : String(s.reason);
        return { id: c.id, title: c.title, status: 'red', summary: `Could not run: ${reason}`, findings: [] };
      });
      for (const r of rows) renderRow(results, r);
      const issues = rows.filter((r) => r.status !== 'green').length;
      status.textContent = `${issues} issue${issues === 1 ? '' : 's'}`;
    } catch (err) {
      const errorPanel = doc.createElement('div');
      errorPanel.style.cssText =
        'border: 1px solid var(--sfdt-color-error); background: var(--sfdt-color-error-bg); color: var(--sfdt-color-error-text); padding: 8px 12px; border-radius: 4px; font-size: 13px;';
      errorPanel.textContent = err instanceof Error ? err.message : String(err);
      results.appendChild(errorPanel);
      status.textContent = 'Failed';
    }
  }

  async function open(): Promise<void> {
    close();

    const body = doc.createElement('div');
    body.style.cssText = 'padding: 16px; overflow-y: auto; flex: 1; display: flex; flex-direction: column;';

    // Toolbar (status + refresh) at the top of the body so it shows in both the
    // modal and the workspace tab — presentView's header is title + × only.
    const toolbar = doc.createElement('div');
    toolbar.style.cssText = 'display: flex; align-items: center; gap: 10px; margin-bottom: 12px;';
    const status = doc.createElement('span');
    status.style.cssText = 'color: var(--sfdt-color-text-weak); font-size: 12px;';
    const refreshBtn = doc.createElement('button');
    refreshBtn.textContent = 'Refresh';
    refreshBtn.style.cssText =
      'margin-left: auto; padding: 4px 10px; border: 1px solid var(--sfdt-color-border); background: var(--sfdt-color-surface); border-radius: 4px; cursor: pointer; font-size: 12px;';
    toolbar.append(status, refreshBtn);
    body.appendChild(toolbar);

    const results = doc.createElement('div');
    body.appendChild(results);

    view = presentView({
      title: '🩺 Org Health (Live)',
      body,
      doc,
      width: '760px',
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
      id: 'org-health-live',
      name: 'Org Health (Live)',
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
        showToast('Open a Salesforce page to run live org health.', { doc, kind: 'warning' });
        return;
      }
      await open();
    },
  };
}

export function _orgHealthLiveTestApi() {
  return {
    coverageBand,
    usageBand,
    worstBand,
    inactiveBand,
    summariseCoverage,
    summariseInactiveUsers,
    summariseLicenses,
    summariseApiVersions,
    summariseLimits,
  };
}
