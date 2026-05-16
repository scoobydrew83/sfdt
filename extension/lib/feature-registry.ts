import type { Context } from './context-detector.js';
export type FeatureId = string;
export interface FeatureManifest {
  id: FeatureId;
  name: string;
  contexts: readonly Context[];
  permissions?: readonly chrome.runtime.ManifestPermissions[];
  enabledByDefault?: boolean;
  settingsSchema?: import('zod').ZodTypeAny;
}
export interface Feature {
  manifest: FeatureManifest;
  init?: () => void | Promise<void>;
  onActivate?: () => void | Promise<void>;
  refresh?: () => void | Promise<void>;
  teardown?: () => void | Promise<void>;
}
export type FeatureAction = 'activate' | 'refresh';
export interface InitGate {
  disabledRemote: ReadonlySet<string>;
  isUserEnabled: (id: FeatureId) => boolean;
}
export interface FeatureRegistry {
  register(feature: Feature): void;
  has(id: FeatureId): boolean;
  list(): FeatureId[];
  getManifest(id: FeatureId): FeatureManifest | undefined;
  listManifests(): readonly FeatureManifest[];
  initForCurrentRoute(availableIds: readonly FeatureId[], gate?: InitGate): Promise<void>;
  dispatch(id: FeatureId, action: FeatureAction): Promise<void>;
  resetForRouteChange(routeKey: string): void;
}
export interface RegistryLogger {
  log: (msg: string, ...rest: unknown[]) => void;
  warn: (msg: string, ...rest: unknown[]) => void;
}
export type TrackFn = (
  event: 'feature.activated' | 'feature.errored' | 'feature.disabled.remote',
  data: { featureId: string },
) => void | Promise<void>;
function readManifestPermissions(): readonly chrome.runtime.ManifestPermissions[] {
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
  manifestPermissions?: readonly chrome.runtime.ManifestPermissions[];
  track?: TrackFn;
} = {}): FeatureRegistry {
  const logger: RegistryLogger = options.logger ?? {
    log: (msg, ...rest) => console.log(`[SFUT] ${msg}`, ...rest),
    warn: (msg, ...rest) => console.warn(`[SFUT] ${msg}`, ...rest),
  };
  const log = (msg: string, ...rest: unknown[]): void => logger.log(msg, ...rest);
  const warn = (msg: string, ...rest: unknown[]): void => logger.warn(msg, ...rest);
  const track: TrackFn = options.track ?? (() => {});
  const manifestPermissions: ReadonlySet<string> = new Set(
    options.manifestPermissions ?? readManifestPermissions(),
  );
  const features = new Map<FeatureId, Feature>();
  let initialisedKeys = new Set<string>();
  let currentRouteKey = '__initial__';
  const activeFeatureIds = new Set<FeatureId>();
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
    async initForCurrentRoute(availableIds, gate) {
      for (const id of availableIds) {
        const feature = features.get(id);
        if (!feature) {
          log(`Feature '${id}' not yet registered, skipping.`);
          continue;
        }
        const allowed = !gate || (!gate.disabledRemote.has(id) && gate.isUserEnabled(id));
        const key = `${currentRouteKey}::${id}`;
        if (!allowed) {
          if (activeFeatureIds.has(id)) {
            if (typeof feature.teardown === 'function') {
              try {
                await feature.teardown();
                log(`Feature '${id}' torn down.`);
              } catch (err) {
                log(`Error tearing down feature '${id}': ${(err as Error).message}`, err);
              }
            }
            activeFeatureIds.delete(id);
            if (gate && gate.disabledRemote.has(id)) {
              void track('feature.disabled.remote', { featureId: id });
            }
          }
          continue;
        }
        if (initialisedKeys.has(key)) continue;
        if (typeof feature.init !== 'function') {
          initialisedKeys.add(key);
          activeFeatureIds.add(id);
          continue;
        }
        try {
          await feature.init();
          initialisedKeys.add(key);
          activeFeatureIds.add(id);
          log(`Feature '${id}' initialised successfully.`);
        } catch (err) {
          log(`Error initialising feature '${id}': ${(err as Error).message}`, err);
          void track('feature.errored', { featureId: id });
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
          void track('feature.errored', { featureId: id });
        }
        return;
      }
      if (typeof feature.onActivate !== 'function') {
        log(`Feature '${id}' does not implement onActivate().`);
        return;
      }
      try {
        await feature.onActivate();
        void track('feature.activated', { featureId: id });
      } catch (err) {
        log(`Error activating feature '${id}': ${(err as Error).message}`, err);
        void track('feature.errored', { featureId: id });
      }
    },
    resetForRouteChange(routeKey) {
      currentRouteKey = routeKey;
      initialisedKeys = new Set();
    },
  };
}
