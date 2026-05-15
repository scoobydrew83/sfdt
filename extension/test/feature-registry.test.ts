import { describe, it, expect, vi } from 'vitest';
import { createFeatureRegistry, type Feature } from '../lib/feature-registry.js';

function makeLogger() {
  return {
    log: vi.fn(),
    warn: vi.fn(),
  };
}

function makeFeature(id: string, overrides: Partial<Feature> = {}): Feature {
  return {
    manifest: { id, contexts: [] },
    ...overrides,
  };
}

describe('extension/lib/feature-registry', () => {
  it('registers and lists features', () => {
    const reg = createFeatureRegistry({ logger: makeLogger() });
    reg.register(makeFeature('alpha'));
    reg.register(makeFeature('beta'));
    expect(reg.list()).toEqual(['alpha', 'beta']);
    expect(reg.has('alpha')).toBe(true);
    expect(reg.has('gamma')).toBe(false);
  });

  it('init is called once per route per feature', async () => {
    const reg = createFeatureRegistry({ logger: makeLogger() });
    const initSpy = vi.fn();
    reg.register(makeFeature('alpha', { init: initSpy }));
    await reg.initForCurrentRoute(['alpha']);
    await reg.initForCurrentRoute(['alpha']);
    expect(initSpy).toHaveBeenCalledTimes(1);
  });

  it('resetForRouteChange clears init state so init runs again on the next route', async () => {
    const reg = createFeatureRegistry({ logger: makeLogger() });
    const initSpy = vi.fn();
    reg.register(makeFeature('alpha', { init: initSpy }));
    await reg.initForCurrentRoute(['alpha']);
    reg.resetForRouteChange('https://example.lightning.force.com/flow/2');
    await reg.initForCurrentRoute(['alpha']);
    expect(initSpy).toHaveBeenCalledTimes(2);
  });

  it('dispatch activate calls onActivate', async () => {
    const reg = createFeatureRegistry({ logger: makeLogger() });
    const onActivate = vi.fn();
    reg.register(makeFeature('alpha', { onActivate }));
    await reg.dispatch('alpha', 'activate');
    expect(onActivate).toHaveBeenCalledOnce();
  });

  it('dispatch refresh calls refresh()', async () => {
    const reg = createFeatureRegistry({ logger: makeLogger() });
    const refresh = vi.fn();
    reg.register(makeFeature('alpha', { refresh }));
    await reg.dispatch('alpha', 'refresh');
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('dispatch logs a warning when the feature is missing the requested hook', async () => {
    const logger = makeLogger();
    const reg = createFeatureRegistry({ logger });
    reg.register(makeFeature('alpha'));
    await reg.dispatch('alpha', 'activate');
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining("does not implement onActivate()"),
    );
  });

  it('a thrown error in init is logged but does not stop subsequent inits', async () => {
    const logger = makeLogger();
    const reg = createFeatureRegistry({ logger });
    const beta = vi.fn();
    reg.register(
      makeFeature('alpha', {
        init: () => {
          throw new Error('boom');
        },
      }),
    );
    reg.register(makeFeature('beta', { init: beta }));
    await reg.initForCurrentRoute(['alpha', 'beta']);
    expect(beta).toHaveBeenCalledOnce();
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining("Error initialising feature 'alpha'"),
      expect.any(Error),
    );
  });

  it('a thrown error in onActivate is logged, not propagated', async () => {
    const logger = makeLogger();
    const reg = createFeatureRegistry({ logger });
    reg.register(
      makeFeature('alpha', {
        onActivate: () => {
          throw new Error('boom');
        },
      }),
    );
    await expect(reg.dispatch('alpha', 'activate')).resolves.toBeUndefined();
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining("Error activating feature 'alpha'"),
      expect.any(Error),
    );
  });

  it('skips unregistered feature ids when initialising a route', async () => {
    const logger = makeLogger();
    const reg = createFeatureRegistry({ logger });
    await reg.initForCurrentRoute(['nothing-here']);
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining("Feature 'nothing-here' not yet registered, skipping."),
    );
  });

  it('exposes the feature manifest via list and getManifest', () => {
    const reg = createFeatureRegistry({ logger: makeLogger() });
    reg.register({
      manifest: { id: 'alpha', contexts: ['flow_builder'] as const },
      init: () => {},
    });
    expect(reg.list()).toEqual(['alpha']);
    expect(reg.getManifest('alpha')).toEqual({
      id: 'alpha',
      contexts: ['flow_builder'],
    });
  });

  it('skips a feature whose declared permissions are not in the manifest, with a warn', () => {
    const logger = makeLogger();
    const reg = createFeatureRegistry({
      logger,
      manifestPermissions: ['storage', 'clipboardWrite'],
    });
    reg.register({
      manifest: {
        id: 'rogue',
        contexts: [],
        permissions: ['tabs' as chrome.runtime.ManifestPermissions],
      },
    });
    expect(reg.has('rogue')).toBe(false);
    expect(reg.list()).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("'rogue' declares permission 'tabs' which is not in the extension manifest"),
    );
  });

  it('registers a feature whose declared permissions are a subset of the manifest', () => {
    const logger = makeLogger();
    const reg = createFeatureRegistry({
      logger,
      manifestPermissions: ['storage', 'clipboardWrite'],
    });
    reg.register({
      manifest: {
        id: 'good',
        contexts: [],
        permissions: ['clipboardWrite'],
      },
    });
    expect(reg.has('good')).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
