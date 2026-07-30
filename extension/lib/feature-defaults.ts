// The authoritative answer to "is feature X on when the user has never touched
// it?" — `manifest.enabledByDefault ?? true`.
//
// Two sources feed the same map, and they must agree:
//
//  1. `feature-manifests.json` — the checked-in, browser-runtime-free copy of
//     every feature's manifest, seeded at import time. This is what makes the
//     default correct in surfaces that never build a FeatureRegistry: the
//     service worker (entrypoints/background.ts gates context-menu-inspect
//     through isFeatureEnabled with no registry in sight) and anything else
//     reading settings before registration has run.
//  2. `registerFeatureDefault()`, called by the feature registry's `register()`
//     for the live manifest object. This keeps dynamically-constructed features
//     correct (ui/workspace-host.ts builds its tools from factories at runtime)
//     and means a newly-added feature is honoured the moment it registers, even
//     before the JSON is regenerated.
//
// test/feature-manifests.test.ts already pins (1) against the real factory
// manifests 1:1, so the two sources cannot silently diverge.

import manifests from './feature-manifests.json';

interface ManifestDefaultEntry {
  id: string;
  enabledByDefault?: boolean;
}

// An id we have never heard of resolves to enabled. That is deliberate: an
// unknown id is a legacy/stale storage key or a feature whose manifest has not
// been regenerated yet, and silently switching such a feature off would be a
// user-visible regression. Only an explicit `enabledByDefault: false` turns one
// off.
const UNKNOWN_FEATURE_DEFAULT = true;

const declaredDefaults = new Map<string, boolean>(
  (manifests as readonly ManifestDefaultEntry[]).map((m) => [
    m.id,
    m.enabledByDefault ?? UNKNOWN_FEATURE_DEFAULT,
  ]),
);

/**
 * Record a feature's manifest default. Called by the registry on `register()`;
 * an omitted `enabledByDefault` means enabled, matching the manifest contract.
 */
export function registerFeatureDefault(featureId: string, enabledByDefault?: boolean): void {
  declaredDefaults.set(featureId, enabledByDefault ?? UNKNOWN_FEATURE_DEFAULT);
}

/**
 * The feature's default enablement, ignoring any stored user preference and the
 * remote kill switch. Callers wanting the effective answer want
 * `isFeatureEnabled()` in settings.ts, which layers both on top of this.
 */
export function isEnabledByDefault(featureId: string): boolean {
  return declaredDefaults.get(featureId) ?? UNKNOWN_FEATURE_DEFAULT;
}

/** Every id with a recorded default — the manifest ids, plus any registered since. */
export function _knownFeatureDefaultIdsForTests(): string[] {
  return Array.from(declaredDefaults.keys());
}

/** Drops a runtime-registered default so a test cannot leak into the next one. */
export function _clearFeatureDefaultForTests(featureId: string): void {
  declaredDefaults.delete(featureId);
}
