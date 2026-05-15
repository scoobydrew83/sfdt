// Feature registry.
//
// Ports the IIFE pattern at /Users/dkennedy/dev/2.0.2_0 copy/main.js:14-187
// into a typed contract. Each v2.0.2 feature implements three optional
// lifecycle hooks:
//
//   init()       — called once per page context. Sets up DOM observers,
//                  injects buttons, registers shortcuts. Idempotent.
//   onActivate() — called when the user clicks the feature in the side menu.
//                  Opens modals, runs ad-hoc actions.
//   refresh()    — called when the user picks "Refresh ..." in the side menu,
//                  or when the SPA route changes and the feature wants to
//                  re-run its setup.
//
// The registry tracks which features have been initialised for the current
// URL so a Salesforce SPA navigation does not double-init.

import type { Context } from './context-detector.js';

export type FeatureId = string;

export interface FeatureManifest {
  /** Stable kebab-case id, used as the registry key and the side-menu data-feature attribute. */
  id: FeatureId;
  /** Contexts the feature appears in. Empty means the feature is never shown by the side menu. */
  contexts: readonly Context[];
  /** Additional manifest permissions this feature needs beyond the shared baseline (storage, cookies). */
  permissions?: readonly chrome.runtime.ManifestPermissions[];
  /** Whether the feature is on by default when the user has no explicit `settings.features[id]` entry. Defaults to true. */
  enabledByDefault?: boolean;
}

export interface Feature {
  manifest: FeatureManifest;
  init?: () => void | Promise<void>;
  onActivate?: () => void | Promise<void>;
  refresh?: () => void | Promise<void>;
}

export type FeatureAction = 'activate' | 'refresh';

export interface FeatureRegistry {
  register(feature: Feature): void;
  has(id: FeatureId): boolean;
  list(): FeatureId[];
  /** Returns the full manifest for a registered feature, or undefined. */
  getManifest(id: FeatureId): FeatureManifest | undefined;
  /** Returns every registered feature's manifest in registration order. */
  listManifests(): readonly FeatureManifest[];
  initForCurrentRoute(availableIds: readonly FeatureId[]): Promise<void>;
  dispatch(id: FeatureId, action: FeatureAction): Promise<void>;
  // Resets the per-route initialisation state. Called by the SPA router
  // when the URL changes so features get a fresh init() pass.
  resetForRouteChange(routeKey: string): void;
}

export interface RegistryLogger {
  log: (msg: string, ...rest: unknown[]) => void;
  warn: (msg: string, ...rest: unknown[]) => void;
}

function readManifestPermissions(): readonly chrome.runtime.ManifestPermissions[] {
  // Guard for tests + non-extension surfaces where chrome.runtime is undefined.
  if (typeof chrome === 'undefined' || !chrome.runtime?.getManifest) return [];
  try {
    const m = chrome.runtime.getManifest();
    return (m.permissions ?? []) as readonly chrome.runtime.ManifestPermissions[];
  } catch {
    return [];
  }
}

export function createFeatureRegistry(options: {
  logger?: RegistryLogger;
  /**
   * The manifest permissions available to the extension. Used to validate
   * feature.manifest.permissions at registration. Defaults to reading
   * chrome.runtime.getManifest().permissions when chrome is available, or
   * an empty array (treats everything as missing) when not.
   */
  manifestPermissions?: readonly chrome.runtime.ManifestPermissions[];
} = {}): FeatureRegistry {
  const logger: RegistryLogger = options.logger ?? {
    log: (msg, ...rest) => console.log(`[SFUT] ${msg}`, ...rest),
    warn: (msg, ...rest) => console.warn(`[SFUT] ${msg}`, ...rest),
  };
  const log = (msg: string, ...rest: unknown[]): void => logger.log(msg, ...rest);
  const warn = (msg: string, ...rest: unknown[]): void => logger.warn(msg, ...rest);

  const manifestPermissions: ReadonlySet<string> = new Set(
    options.manifestPermissions ?? readManifestPermissions(),
  );

  const features = new Map<FeatureId, Feature>();
  // Tracks features that have been init()'d for the current route. The key
  // combines the route signature with the feature id so a route change can
  // reset just those entries.
  let initialisedKeys = new Set<string>();
  let currentRouteKey = '__initial__';

  return {
    register(feature) {
      const declared = feature.manifest.permissions ?? [];
      const missing = declared.filter((p) => !manifestPermissions.has(p));
      if (missing.length > 0) {
        warn(
          `Feature '${feature.manifest.id}' declares permission '${missing[0]}' which is not in the extension manifest. Skipping registration.`,
        );
        return;
      }
      features.set(feature.manifest.id, feature);
      log(`Feature '${feature.manifest.id}' registered.`);
    },

    has(id) {
      return features.has(id);
    },

    list() {
      return Array.from(features.keys());
    },

    getManifest(id) {
      return features.get(id)?.manifest;
    },

    listManifests() {
      return Array.from(features.values()).map((f) => f.manifest);
    },

    async initForCurrentRoute(availableIds) {
      for (const id of availableIds) {
        const feature = features.get(id);
        if (!feature) {
          log(`Feature '${id}' not yet registered, skipping.`);
          continue;
        }
        const key = `${currentRouteKey}::${id}`;
        if (initialisedKeys.has(key)) continue;
        if (typeof feature.init !== 'function') {
          initialisedKeys.add(key);
          continue;
        }
        try {
          await feature.init();
          initialisedKeys.add(key);
          log(`Feature '${id}' initialised successfully.`);
        } catch (err) {
          log(`Error initialising feature '${id}': ${(err as Error).message}`, err);
        }
      }
    },

    async dispatch(id, action) {
      const feature = features.get(id);
      if (!feature) {
        log(`Feature '${id}' not found in registry.`);
        return;
      }
      if (action === 'refresh') {
        if (typeof feature.refresh !== 'function') {
          log(`Feature '${id}' does not implement refresh().`);
          return;
        }
        try {
          await feature.refresh();
        } catch (err) {
          log(`Error refreshing feature '${id}': ${(err as Error).message}`, err);
        }
        return;
      }
      // activate
      if (typeof feature.onActivate !== 'function') {
        log(`Feature '${id}' does not implement onActivate().`);
        return;
      }
      try {
        await feature.onActivate();
      } catch (err) {
        log(`Error activating feature '${id}': ${(err as Error).message}`, err);
      }
    },

    resetForRouteChange(routeKey) {
      currentRouteKey = routeKey;
      initialisedKeys = new Set();
    },
  };
}
