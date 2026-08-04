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
//
// SIZE — deliberate, measured, revisit-if. Importing the whole manifest array
// to read one boolean per feature inlines it into every entrypoint that reaches
// settings: ~+9 kB each to background.js (74.3 → 83 kB) and content.js
// (544 → 552.7 kB). A derived id→boolean map was measured at 1,002 B vs the
// 11,778 B source — ~8 kB/bundle recoverable, and the gap grows with each new
// feature. Kept as-is anyway: that is 0.65% of the 1.22 MB extension for no
// user-perceptible effect, and the alternative is a SECOND generated artifact
// deriving from the first, i.e. another regenerate-both step and another drift
// guard to maintain, purely for bytes. Revisit if the manifest grows materially
// or a bundle budget lands — at which point generate the compact map from
// collectEntries() in the same SFDT_WRITE_MANIFESTS pass and assert it in the
// same parity describe, so authoring stays single-source.
//
// Do NOT "optimise" this by seeding only the ids that are false. Today that
// list is empty, which would make a completely dead seed indistinguishable from
// a correct one — the exact hole the membership + value fixtures exist to close
// (test/feature-defaults.test.ts, test/feature-manifests.test.ts).

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
//
// Failing OPEN is only safe because of the parity test: the residual risk is a
// feature that declares `enabledByDefault: false` in code, is gated from a
// registry-free surface, and whose entry has not been regenerated into
// feature-manifests.json — it would ship on. `feature-manifests.json parity` in
// test/feature-manifests.test.ts fails on exactly that skew, and it runs in the
// standard suite (not behind a flag). The two are coupled; do not weaken one
// without re-reading the other.
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

/**
 * Features that cannot function without the CLI bridge (`sfdt ui` running).
 *
 * Not derivable from a manifest — it is a statement about what each feature
 * DOES, so it is maintained by hand and baked into lib/feature-manifests.json
 * by the parity test.
 *
 * It lived in that test until the options page needed it to badge the feature
 * list. A test is the wrong home for a fact the product has to act on: the UI
 * could not reach it, so the page either duplicated the list or said nothing.
 *
 * - flow-deploy: deploy/rollback runs entirely through the bridge.
 * - org-health: the CLI-only DEPTH. The five in-browser checks always run
 *   without it (features/org-health-checks.ts); the bridge adds `sfdt audit`'s
 *   twelve on top. Listed because the deeper half is what the entry promises.
 * - drift-check / metadata-scan / org-compare: bridge-tools.ts — they need
 *   `sfdt ui` running to answer the bridge at all.
 *
 * NOT listed: ai-assistant (metadata clean/summarise/copy works in-browser;
 * only the optional AI run uses the bridge) and trigger-conflicts (detection is
 * a live Tooling query; only the rollback action uses the bridge).
 */
export const BRIDGE_REQUIRED: ReadonlySet<string> = new Set([
  'flow-deploy',
  'org-health',
  'drift-check',
  'metadata-scan',
  'org-compare',
]);
