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

export type Band = 'green' | 'amber' | 'red';

/** One health check's outcome. id/title are attached by the running feature. */
export interface CheckBody {
  status: Band;
  summary: string;
  findings: string[];
}

export interface CheckResult extends CheckBody {
  id: string;
  title: string;
}

const BAND_COLOUR: Record<Band, string> = {
  green: '#04844b',
  amber: '#fe9339',
  red: '#c23934',
};

// Versions slip ~3 per year; ~10 behind the newest is roughly 3 years stale.
const API_VERSION_LAG = 10;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Salesforce requires 75% org-wide to deploy, so red = below that line. */
export function coverageBand(pct: number): Band {
  if (pct >= 90) return 'green';
  if (pct >= 75) return 'amber';
  return 'red';
}

/** Usage fraction 0..1 where higher = worse (licenses, limits). */
export function usageBand(fraction: number): Band {
  if (fraction >= 0.9) return 'red';
  if (fraction >= 0.75) return 'amber';
  return 'green';
}

/** Worst wins: any red → red, any amber → amber, else green. */
export function worstBand(bands: Band[]): Band {
  if (bands.includes('red')) return 'red';
  if (bands.includes('amber')) return 'amber';
  return 'green';
}

function pctText(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

export interface RawCoverageRow {
  PercentCovered?: number | null;
}

export function summariseCoverage(records: RawCoverageRow[]): CheckBody {
  const pct = records[0]?.PercentCovered;
  if (typeof pct !== 'number') {
    return { status: 'amber', summary: 'No coverage data — run Apex tests in this org', findings: [] };
  }
  const status = coverageBand(pct);
  return {
    status,
    summary: `${pct}% org-wide Apex coverage`,
    findings: status === 'green' ? [] : ['Salesforce requires 75% to deploy'],
  };
}

export interface RawUserRow {
  Name?: string | null;
  LastLoginDate?: string | null;
}

export function inactiveBand(count: number): Band {
  if (count === 0) return 'green';
  if (count < 10) return 'amber';
  return 'red';
}

export function summariseInactiveUsers(records: RawUserRow[]): CheckBody {
  const count = records.length;
  const status = inactiveBand(count);
  return {
    status,
    summary:
      count === 0
        ? 'No active users idle for 90+ days'
        : `${count} active user${count === 1 ? '' : 's'} not logged in for 90+ days`,
    findings: records.map(
      (u) => `${u.Name ?? '(unknown)'} — last login ${u.LastLoginDate ?? 'never'}`,
    ),
  };
}

export interface RawLicenseRow {
  Name?: string | null;
  TotalLicenses?: number | null;
  UsedLicenses?: number | null;
}

export function summariseLicenses(records: RawLicenseRow[]): CheckBody {
  // TotalLicenses can be -1 (unlimited) or 0 (none provisioned); skip those.
  const rows = records
    .filter((r) => (r.TotalLicenses ?? 0) > 0)
    .map((r) => {
      const total = r.TotalLicenses ?? 0;
      const used = Math.max(0, r.UsedLicenses ?? 0);
      const fraction = used / total;
      return { name: r.Name ?? '(unknown)', used, total, fraction, band: usageBand(fraction) };
    });
  const flagged = rows.filter((r) => r.band !== 'green');
  return {
    status: worstBand(rows.map((r) => r.band)),
    summary:
      flagged.length === 0
        ? `All ${rows.length} license type${rows.length === 1 ? '' : 's'} under 75% used`
        : `${flagged.length} of ${rows.length} license type${rows.length === 1 ? '' : 's'} near capacity`,
    findings: rows.map((r) => `${r.name}: ${r.used}/${r.total} (${pctText(r.fraction)})`),
  };
}

export interface RawApexVersionRow {
  ApiVersion?: number | null;
}

export function summariseApiVersions(records: RawApexVersionRow[]): CheckBody {
  const versions = records
    .map((r) => r.ApiVersion)
    .filter((v): v is number => typeof v === 'number');
  if (versions.length === 0) {
    return { status: 'green', summary: 'No Apex classes', findings: [] };
  }
  const max = Math.max(...versions);
  const buckets = new Map<number, number>();
  for (const v of versions) buckets.set(v, (buckets.get(v) ?? 0) + 1);
  const lagging = [...buckets.entries()]
    .filter(([v]) => max - v >= API_VERSION_LAG)
    .sort((a, b) => a[0] - b[0]);
  const laggingClasses = lagging.reduce((n, [, c]) => n + c, 0);
  return {
    status: lagging.length > 0 ? 'amber' : 'green',
    summary: `${versions.length} class${versions.length === 1 ? '' : 'es'} across ${buckets.size} API version${buckets.size === 1 ? '' : 's'}; newest v${max}` +
      (laggingClasses > 0 ? `, ${laggingClasses} stale` : ''),
    findings: lagging.map(([v, c]) => `${c} class${c === 1 ? '' : 'es'} on v${v} (newest v${max})`),
  };
}

export type RawLimits = Record<string, { Max?: number | null; Remaining?: number | null }>;

export function summariseLimits(limits: RawLimits): CheckBody {
  const rows = Object.entries(limits)
    .filter(([, l]) => (l.Max ?? 0) > 0)
    .map(([name, l]) => {
      const max = l.Max ?? 0;
      const used = max - (l.Remaining ?? 0);
      const fraction = used / max;
      return { name, used, max, fraction, band: usageBand(fraction) };
    });
  const flagged = rows.filter((r) => r.band !== 'green').sort((a, b) => b.fraction - a.fraction);
  return {
    status: worstBand(rows.map((r) => r.band)),
    summary:
      flagged.length === 0
        ? `All ${rows.length} org limits under 75% used`
        : `${flagged.length} of ${rows.length} org limits near cap`,
    findings: flagged.map((r) => `${r.name}: ${r.used}/${r.max} (${pctText(r.fraction)})`),
  };
}

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
          (await api.toolingQuery<RawCoverageRow>('SELECT PercentCovered FROM ApexOrgWideCoverage')).records,
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
    row.style.cssText = 'border: 1px solid #d8dde6; border-radius: 4px; padding: 8px 10px; margin-bottom: 6px;';

    const head = doc.createElement('div');
    head.style.cssText = 'display: flex; align-items: center; gap: 8px;';
    const dot = doc.createElement('span');
    dot.style.cssText = `width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; background: ${BAND_COLOUR[check.status]};`;
    const titleEl = doc.createElement('span');
    titleEl.style.cssText = 'font-weight: 600; font-size: 12px;';
    titleEl.textContent = check.title;
    const summaryEl = doc.createElement('span');
    summaryEl.style.cssText = 'color: #54698d; font-size: 11px;';
    summaryEl.textContent = check.summary;
    head.append(dot, titleEl, summaryEl);
    row.appendChild(head);

    if (check.findings.length > 0) {
      const list = doc.createElement('ul');
      list.style.cssText = 'margin: 6px 0 0; padding-left: 18px; color: #3e3e3c; font-size: 11px;';
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
        'border: 1px solid #c23934; background: #fef2f1; color: #c23934; padding: 8px 12px; border-radius: 4px; font-size: 13px;';
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
    status.style.cssText = 'color: #54698d; font-size: 12px;';
    const refreshBtn = doc.createElement('button');
    refreshBtn.textContent = 'Refresh';
    refreshBtn.style.cssText =
      'margin-left: auto; padding: 4px 10px; border: 1px solid #d8dde6; background: #fff; border-radius: 4px; cursor: pointer; font-size: 12px;';
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
