// The in-browser half of Org Health.
//
// This was a separate registered feature, "Org Health (Live)", sitting beside
// "Org Health" in the tool list. Two entries with near-identical names, and
// nothing on screen said that one ran 5 checks and the other 17 — so the only
// way to learn the difference was to open both and count.
//
// It is now the no-setup half of ONE tool: features/org-health.ts always runs
// these five, then adds the CLI's twelve on top when the bridge answers. This
// module owns the checks and the row renderer; it presents nothing itself.

import {
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
import {
  getSalesforceApi,
  type SalesforceApiClient,
} from '../lib/salesforce-api.js';
import { BAND_CLASS } from './org-limits.js';

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

/**
 * The five checks that run entirely in the browser.
 *
 * Extracted from what used to be a separate "Org Health (Live)" feature. It is
 * not a separate TOOL — it is the subset of Org Health that needs no CLI, and
 * presenting it as its own entry meant a user saw two near-identical items and
 * could not tell that one ran 5 checks and the other 17.
 */
export function buildLiveChecks(options: OrgHealthLiveOptions = {}): {
  checks: CheckDescriptor[];
  run: () => Promise<CheckResult[]>;
} {
  const api = options.api ?? getSalesforceApi();

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

  // Settle each check independently so one failing SOQL/Tooling call degrades to
  // a red row instead of taking the panel down with it.
  async function run(): Promise<CheckResult[]> {
    const settled = await Promise.allSettled(checks.map((c) => c.run()));
    return settled.map((s, i) => {
      const c = checks[i]!;
      if (s.status === 'fulfilled') return { id: c.id, title: c.title, ...s.value };
      const reason = s.reason instanceof Error ? s.reason.message : String(s.reason);
      return { id: c.id, title: c.title, status: 'red' as const, summary: `Could not run: ${reason}`, findings: [] };
    });
  }

  return { checks, run };
}


/**
 * One check row. Shared so the in-browser checks and the CLI's render
 * identically — they are the same kind of finding and must not look like two
 * different reports stacked on top of each other.
 */
export function renderCheckRow(doc: Document, results: HTMLElement, check: CheckResult): void {
    const row = doc.createElement('div');
    row.classList.add('sfdt-panel', 'sfdt-below');
    const head = doc.createElement('div');
    head.classList.add('sfdt-row');
    const dot = doc.createElement('span');
    dot.className = `sfdt-dot ${BAND_CLASS[check.status]}`;
    const titleEl = doc.createElement('span');
    titleEl.className = 'sfdt-subhead';
    titleEl.textContent = check.title;
    const summaryEl = doc.createElement('span');
    summaryEl.className = 'sfdt-muted';
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
        li.classList.add('sfdt-italic');
        li.textContent = `… and ${check.findings.length - 25} more`;
        list.appendChild(li);
      }
      row.appendChild(list);
    }
    results.appendChild(row);
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
