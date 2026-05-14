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

export type FeatureId = string;

export interface Feature {
  id: FeatureId;
  init?: () => void | Promise<void>;
  onActivate?: () => void | Promise<void>;
  refresh?: () => void | Promise<void>;
}

export type FeatureAction = 'activate' | 'refresh';

export interface FeatureRegistry {
  register(feature: Feature): void;
  has(id: FeatureId): boolean;
  list(): FeatureId[];
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

export function createFeatureRegistry(options: { logger?: RegistryLogger } = {}): FeatureRegistry {
  const logger: RegistryLogger = options.logger ?? {
    log: (msg, ...rest) => console.log(`[SFUT] ${msg}`, ...rest),
    warn: (msg, ...rest) => console.warn(`[SFUT] ${msg}`, ...rest),
  };
  const log = (msg: string, ...rest: unknown[]): void => logger.log(msg, ...rest);

  const features = new Map<FeatureId, Feature>();
  // Tracks features that have been init()'d for the current route. The key
  // combines the route signature with the feature id so a route change can
  // reset just those entries.
  let initialisedKeys = new Set<string>();
  let currentRouteKey = '__initial__';

  return {
    register(feature) {
      features.set(feature.id, feature);
      log(`Feature '${feature.id}' registered.`);
    },

    has(id) {
      return features.has(id);
    },

    list() {
      return Array.from(features.keys());
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
