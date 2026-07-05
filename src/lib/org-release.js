import { execa } from 'execa';
import { safeParse } from './org-query.js';

/**
 * The API version Salesforce's currently-GA release should expose, derived from
 * the fixed three-releases-a-year cadence (Spring GA ~Feb, Summer GA ~June,
 * Winter GA ~Oct; anchor: Spring '23 = v57.0). Used to spot preview instances:
 * a preview org's max supported REST API version is ahead of the GA release.
 */
export function expectedGaApiVersion(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1;
  const spring = 57 + (y - 2023) * 3; // Spring '23 = v57
  if (m >= 10) return spring + 2; // Winter '(y+1)'
  if (m >= 6) return spring + 1; // Summer 'y'
  if (m >= 2) return spring; // Spring 'y'
  return spring - 1; // January: still the prior year's Winter release
}

/**
 * Best-effort release detection for an org: read its REST version list
 * (`/services/data` via `sf api request rest` — no auth plumbing or new
 * dependencies needed) and take the newest entry. Its `label` is the release
 * name (e.g. "Summer '26") and its version, compared against the expected GA
 * version, tells us whether the instance is on a preview release. Returns null
 * on any failure — release info is informational and must degrade gracefully
 * (older sf CLIs lack `sf api request`, orgs may be unreachable, etc.).
 */
export async function detectOrgRelease(orgAlias) {
  try {
    const resp = await execa('sf', ['api', 'request', 'rest', '/services/data', '--target-org', orgAlias]);
    const versions = safeParse(resp.stdout);
    if (!Array.isArray(versions) || versions.length === 0) return null;
    const latest = versions.reduce((a, b) =>
      Number.parseFloat(b?.version) > Number.parseFloat(a?.version) ? b : a);
    const apiVersion = Number.parseFloat(latest?.version);
    if (!Number.isFinite(apiVersion)) return null;
    return {
      release: latest.label ?? `API v${apiVersion}`,
      apiVersion,
      preview: apiVersion > expectedGaApiVersion(),
    };
  } catch {
    return null;
  }
}

/**
 * Compare the release versions of two orgs. Returns:
 *   - `null` when the comparison is not applicable (missing/identical aliases,
 *     or either alias is the sentinel `"local"`);
 *   - `{ source, target, differ }` otherwise, where `source`/`target` are the
 *     `detectOrgRelease` results (either may be `null` when undetectable) and
 *     `differ` is `true`/`false` when both releases are known, or `null` when
 *     either could not be detected (so callers don't warn on unknowns).
 *
 * Best-effort and non-fatal: a release mismatch between a retrofit/compare
 * source and target is a heads-up (metadata valid on one release may not deploy
 * cleanly to another), never a hard failure.
 */
export async function compareOrgReleases(sourceAlias, targetAlias) {
  if (!sourceAlias || !targetAlias) return null;
  if (sourceAlias === 'local' || targetAlias === 'local') return null;
  if (sourceAlias === targetAlias) return null;
  const [source, target] = await Promise.all([
    detectOrgRelease(sourceAlias),
    detectOrgRelease(targetAlias),
  ]);
  const differ = source && target ? source.apiVersion !== target.apiVersion : null;
  return { source, target, differ };
}

/**
 * Human-readable one-line warning for a `compareOrgReleases` result, or null
 * when there is nothing to warn about (comparison N/A, releases match, or a
 * release could not be determined). Shared by `compare` and `retrofit` so the
 * wording stays identical.
 */
export function releaseMismatchWarning(cmp, sourceAlias, targetAlias) {
  if (!cmp || cmp.differ !== true) return null;
  return (
    `Release mismatch: ${sourceAlias} is on ${cmp.source.release} (API v${cmp.source.apiVersion}) ` +
    `but ${targetAlias} is on ${cmp.target.release} (API v${cmp.target.apiVersion}). ` +
    `Metadata valid on one release may not deploy cleanly to the other.`
  );
}
