import semver from 'semver';

const NPM_REGISTRY_BASE = 'https://registry.npmjs.org';

/**
 * True only when `latest` is a strictly-greater semver than `installed`, so a
 * local/pre-release build that is *ahead* of the published version is never
 * flagged for a (downgrade) update. Falls back to inequality for non-semver
 * version strings. Returns false if either version is missing.
 *
 * Shared by `sfdt update`, the GUI CLI self-update check (`/api/check-updates`),
 * and the Flow Core panel (`/api/flow-core/info`).
 */
export function isUpdateAvailable(latest, installed) {
  if (!latest || !installed) return false;
  if (semver.valid(latest) && semver.valid(installed)) return semver.gt(latest, installed);
  return latest !== installed;
}

export async function fetchLatestVersion(pkg = '@sfdt/cli') {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${NPM_REGISTRY_BASE}/${pkg}/latest`, { signal: controller.signal });
    if (!res.ok) throw new Error(`npm registry responded with ${res.status}`);
    const data = await res.json();
    return data.version;
  } finally {
    clearTimeout(timeout);
  }
}
