// Pure logic. No DOM, no API, no chrome.*, no Node.
// Shared release-detection used by both the CLI (`src/lib/org-release.js`) and
// the Chrome extension's release badge — so both compute "preview instance"
// identically from an org's REST version list.

/** One entry from Salesforce's `/services/data` REST version list. */
export interface OrgApiVersionEntry {
  version: string; // e.g. "63.0"
  label: string; // e.g. "Summer '26"
  url?: string;
}

export interface OrgReleaseInfo {
  /** Release label, e.g. "Summer '26" (falls back to `API v${n}`). */
  release: string;
  /** Newest REST API version the org supports, e.g. 63. */
  apiVersion: number;
  /** True when the org is ahead of the currently-GA release (a preview instance). */
  preview: boolean;
}

/**
 * The API version Salesforce's currently-GA release should expose, derived from
 * the fixed three-releases-a-year cadence (Spring GA ~Feb, Summer GA ~June,
 * Winter GA ~Oct; anchor: Spring '23 = v57.0). A preview org's max supported
 * REST API version is ahead of the GA release.
 */
export function expectedGaApiVersion(date: Date = new Date()): number {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1;
  const spring = 57 + (y - 2023) * 3; // Spring '23 = v57
  if (m >= 10) return spring + 2; // Winter '(y+1)'
  if (m >= 6) return spring + 1; // Summer 'y'
  if (m >= 2) return spring; // Spring 'y'
  return spring - 1; // January: still the prior year's Winter release
}

/**
 * Reduce a `/services/data` version list to the current release info, or `null`
 * when the input isn't a usable version array. Best-effort: release info is
 * informational and must degrade gracefully.
 */
export function releaseFromVersionList(
  versions: unknown,
  now: Date = new Date(),
): OrgReleaseInfo | null {
  if (!Array.isArray(versions) || versions.length === 0) return null;
  const latest = versions.reduce((a, b) =>
    Number.parseFloat((b as OrgApiVersionEntry)?.version) >
    Number.parseFloat((a as OrgApiVersionEntry)?.version)
      ? b
      : a,
  ) as OrgApiVersionEntry;
  const apiVersion = Number.parseFloat(latest?.version);
  if (!Number.isFinite(apiVersion)) return null;
  return {
    release: latest?.label ?? `API v${apiVersion}`,
    apiVersion,
    preview: apiVersion > expectedGaApiVersion(now),
  };
}
