import { execa } from 'execa';
import { expectedGaApiVersion, releaseFromVersionList } from '@sfdt/flow-core';
import { safeParse } from './org-query.js';

// The pure release-detection logic lives in @sfdt/flow-core so the CLI and the
// Chrome extension's release badge compute "preview instance" identically.
export { expectedGaApiVersion };

/**
 * Best-effort release detection for an org: read its REST version list
 * (`/services/data` via `sf api request rest` — no auth plumbing or new
 * dependencies needed) and reduce it via the shared flow-core helper. Its
 * `label` is the release name (e.g. "Summer '26") and its version, compared
 * against the expected GA version, tells us whether the instance is on a
 * preview release. Returns null on any failure — release info is informational
 * and must degrade gracefully (older sf CLIs lack `sf api request`, orgs may be
 * unreachable, etc.).
 *
 * @param {string} orgAlias
 * @param {object} [options]
 * @param {number} [options.timeoutMs] - Optional execa subprocess timeout;
 *   unset preserves prior (no-timeout) behavior.
 */
export async function detectOrgRelease(orgAlias, { timeoutMs } = {}) {
  try {
    const args = ['api', 'request', 'rest', '/services/data', '--target-org', orgAlias];
    const resp = timeoutMs ? await execa('sf', args, { timeout: timeoutMs }) : await execa('sf', args);
    return releaseFromVersionList(safeParse(resp.stdout));
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
