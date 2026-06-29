// Shared, browser-safe org-health rulebook. Pure logic only — no DOM, no chrome.*,
// no Node APIs — so the CLI (audit/monitor runners), the GUI, and the Chrome
// `org-health-live` feature all band findings from ONE set of thresholds. Each
// surface keeps its own fetch layer (CLI: sf CLI; Chrome: salesforce-api) and
// passes already-fetched rows to these summarisers.

export type Band = 'green' | 'amber' | 'red';

/** One health check's outcome. id/title are attached by the running surface. */
export interface CheckBody {
  status: Band;
  summary: string;
  findings: string[];
}

/**
 * Canonical thresholds — the single source of truth that resolves the historical
 * CLI↔Chrome divergence (CLI used license≥0.9 / limit≥0.8; Chrome used 0.75/0.9
 * bands). Usage now bands uniformly at amber≥75% / red≥90% everywhere.
 */
export const ORG_HEALTH_THRESHOLDS = {
  /** Usage fraction (licenses, limits): amber at/above this. */
  usageAmber: 0.75,
  /** Usage fraction: red at/above this. */
  usageRed: 0.9,
  /** Org-wide Apex coverage % required to deploy (red below). */
  coverageDeployFloor: 75,
  /** Org-wide Apex coverage % considered healthy (green at/above). */
  coverageHealthy: 90,
  /** Active users idle this many days count as inactive. */
  inactiveUserDays: 90,
  /** Inactive-user count: amber at/above this, red at/above inactiveRedAt. */
  inactiveAmberAt: 1,
  inactiveRedAt: 10,
  /** Apex classes this many versions behind the newest are "stale" (Chrome relative check). */
  apiVersionLag: 10,
  /** Absolute API-version floor for the CLI audit check. */
  minApiVersionFloor: 45,
  /** Security health-check minimum score (CLI monitor). */
  healthMinScore: 80,
} as const;

// ── Band functions (pure) ───────────────────────────────────────────────────

/** Org-wide Apex coverage %, e.g. 82 → band. */
export function coverageBand(pct: number): Band {
  if (pct >= ORG_HEALTH_THRESHOLDS.coverageHealthy) return 'green';
  if (pct >= ORG_HEALTH_THRESHOLDS.coverageDeployFloor) return 'amber';
  return 'red';
}

/** Usage fraction 0..1 where higher = worse (licenses, limits). */
export function usageBand(fraction: number): Band {
  if (fraction >= ORG_HEALTH_THRESHOLDS.usageRed) return 'red';
  if (fraction >= ORG_HEALTH_THRESHOLDS.usageAmber) return 'amber';
  return 'green';
}

/** Inactive-user count → band. */
export function inactiveBand(count: number): Band {
  if (count >= ORG_HEALTH_THRESHOLDS.inactiveRedAt) return 'red';
  if (count >= ORG_HEALTH_THRESHOLDS.inactiveAmberAt) return 'amber';
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

// ── Pure summarisers (already-fetched rows → CheckBody) ──────────────────────

export interface RawOrgWideCoverageRow {
  PercentCovered?: number | null;
}

export function summariseCoverage(records: RawOrgWideCoverageRow[]): CheckBody {
  const pct = records[0]?.PercentCovered;
  if (typeof pct !== 'number') {
    return { status: 'amber', summary: 'No coverage data — run Apex tests in this org', findings: [] };
  }
  const status = coverageBand(pct);
  return {
    status,
    summary: `${pct}% org-wide Apex coverage`,
    findings: status === 'green' ? [] : [`Salesforce requires ${ORG_HEALTH_THRESHOLDS.coverageDeployFloor}% to deploy`],
  };
}

export interface RawUserRow {
  Name?: string | null;
  LastLoginDate?: string | null;
}

export function summariseInactiveUsers(records: RawUserRow[]): CheckBody {
  const count = records.length;
  const status = inactiveBand(count);
  const days = ORG_HEALTH_THRESHOLDS.inactiveUserDays;
  return {
    status,
    summary:
      count === 0
        ? `No active users idle for ${days}+ days`
        : `${count} active user${count === 1 ? '' : 's'} not logged in for ${days}+ days`,
    findings: records.map((u) => `${u.Name ?? '(unknown)'} — last login ${u.LastLoginDate ?? 'never'}`),
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
        ? `All ${rows.length} license type${rows.length === 1 ? '' : 's'} under ${pctText(ORG_HEALTH_THRESHOLDS.usageAmber)} used`
        : `${flagged.length} of ${rows.length} license type${rows.length === 1 ? '' : 's'} near capacity`,
    findings: rows.map((r) => `${r.name}: ${r.used}/${r.total} (${pctText(r.fraction)})`),
  };
}

export interface RawApexVersionRow {
  ApiVersion?: number | null;
}

export function summariseApiVersions(records: RawApexVersionRow[]): CheckBody {
  const versions = records.map((r) => r.ApiVersion).filter((v): v is number => typeof v === 'number');
  if (versions.length === 0) {
    return { status: 'green', summary: 'No Apex classes', findings: [] };
  }
  const max = Math.max(...versions);
  const buckets = new Map<number, number>();
  for (const v of versions) buckets.set(v, (buckets.get(v) ?? 0) + 1);
  const lagging = [...buckets.entries()]
    .filter(([v]) => max - v >= ORG_HEALTH_THRESHOLDS.apiVersionLag)
    .sort((a, b) => a[0] - b[0]);
  const laggingClasses = lagging.reduce((n, [, c]) => n + c, 0);
  return {
    status: lagging.length > 0 ? 'amber' : 'green',
    summary:
      `${versions.length} class${versions.length === 1 ? '' : 'es'} across ${buckets.size} API version${buckets.size === 1 ? '' : 's'}; newest v${max}` +
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
        ? `All ${rows.length} org limits under ${pctText(ORG_HEALTH_THRESHOLDS.usageAmber)} used`
        : `${flagged.length} of ${rows.length} org limits near cap`,
    findings: flagged.map((r) => `${r.name}: ${r.used}/${r.max} (${pctText(r.fraction)})`),
  };
}
