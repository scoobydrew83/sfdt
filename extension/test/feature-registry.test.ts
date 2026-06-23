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
    manifest: { id, name: id, contexts: [] },
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
      manifest: { id: 'alpha', name: 'alpha', contexts: ['flow_builder'] as const },
      init: () => {},
    });
    expect(reg.list()).toEqual(['alpha']);
    expect(reg.getManifest('alpha')).toEqual({
      id: 'alpha',
      name: 'alpha',
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
        name: 'rogue',
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
        name: 'good',
        contexts: [],
        permissions: ['clipboardWrite'],
      },
    });
    expect(reg.has('good')).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('skips init for features whose id is in the kill-switch list', async () => {
    const reg = createFeatureRegistry({ logger: makeLogger() });
    const initSpy = vi.fn();
    reg.register({
      manifest: { id: 'alpha', name: 'alpha', contexts: [] },
      init: initSpy,
    });
    await reg.initForCurrentRoute(['alpha'], {
      disabledRemote: new Set(['alpha']),
      isUserEnabled: () => true,
    });
    expect(initSpy).not.toHaveBeenCalled();
  });

  it('skips init for features the user has disabled', async () => {
    const reg = createFeatureRegistry({ logger: makeLogger() });
    const initSpy = vi.fn();
    reg.register({
      manifest: { id: 'alpha', name: 'alpha', contexts: [] },
      init: initSpy,
    });
    await reg.initForCurrentRoute(['alpha'], {
      disabledRemote: new Set(),
      isUserEnabled: (id) => id !== 'alpha',
    });
    expect(initSpy).not.toHaveBeenCalled();
  });

  it('calls teardown() when a previously-initialised feature is newly remote-disabled', async () => {
    const reg = createFeatureRegistry({ logger: makeLogger() });
    const init = vi.fn();
    const teardown = vi.fn();
    reg.register({
      manifest: { id: 'alpha', name: 'alpha', contexts: [] },
      init,
      teardown,
    });
    await reg.initForCurrentRoute(['alpha'], {
      disabledRemote: new Set(),
      isUserEnabled: () => true,
    });
    expect(init).toHaveBeenCalledOnce();

    reg.resetForRouteChange('https://x.lightning.force.com/page/2');
    await reg.initForCurrentRoute(['alpha'], {
      disabledRemote: new Set(['alpha']),
      isUserEnabled: () => true,
    });
    expect(teardown).toHaveBeenCalledOnce();
    expect(init).toHaveBeenCalledOnce(); // not re-inited
  });

  it('resetForRouteChange does not clear active features (teardown still fires after a route change)', async () => {
    const reg = createFeatureRegistry({ logger: makeLogger() });
    const teardown = vi.fn();
    reg.register({
      manifest: { id: 'alpha', name: 'alpha', contexts: [] },
      init: () => {},
      teardown,
    });
    // Init the feature
    await reg.initForCurrentRoute(['alpha'], {
      disabledRemote: new Set(),
      isUserEnabled: () => true,
    });
    // Three route changes go by without any gate change
    reg.resetForRouteChange('r2');
    reg.resetForRouteChange('r3');
    reg.resetForRouteChange('r4');
    // Now disable the feature — teardown MUST still fire even after 3 resets
    await reg.initForCurrentRoute(['alpha'], {
      disabledRemote: new Set(['alpha']),
      isUserEnabled: () => true,
    });
    expect(teardown).toHaveBeenCalledOnce();
  });

  it('a thrown error in teardown is logged and does not halt other features', async () => {
    const logger = makeLogger();
    const reg = createFeatureRegistry({ logger });
    reg.register({
      manifest: { id: 'alpha', name: 'alpha', contexts: [] },
      init: () => {},
      teardown: () => {
        throw new Error('teardown boom');
      },
    });
    await reg.initForCurrentRoute(['alpha'], {
      disabledRemote: new Set(),
      isUserEnabled: () => true,
    });
    reg.resetForRouteChange('r2');
    await reg.initForCurrentRoute(['alpha'], {
      disabledRemote: new Set(['alpha']),
      isUserEnabled: () => true,
    });
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining("Error tearing down feature 'alpha': teardown boom"),
      expect.anything(),
    );
  });

  it('tracks feature.activated when dispatch activate succeeds', async () => {
    const track = vi.fn();
    const reg = createFeatureRegistry({ logger: makeLogger(), track });
    reg.register({
      manifest: { id: 'alpha', name: 'alpha', contexts: [] },
      onActivate: () => {},
    });
    await reg.dispatch('alpha', 'activate');
    expect(track).toHaveBeenCalledWith('feature.activated', { featureId: 'alpha' });
  });

  it('tracks feature.errored when onActivate throws', async () => {
    const track = vi.fn();
    const reg = createFeatureRegistry({ logger: makeLogger(), track });
    reg.register({
      manifest: { id: 'alpha', name: 'alpha', contexts: [] },
      onActivate: () => {
        throw new Error('boom');
      },
    });
    await reg.dispatch('alpha', 'activate');
    expect(track).toHaveBeenCalledWith('feature.errored', { featureId: 'alpha' });
  });

  it('notifies once per feature per page load when init throws (no spam on route changes)', async () => {
    const notify = vi.fn();
    const reg = createFeatureRegistry({ logger: makeLogger(), notify });
    reg.register({
      manifest: { id: 'alpha', name: 'Alpha Feature', contexts: [] },
      init: () => {
        throw new Error('boom');
      },
    });
    await reg.initForCurrentRoute(['alpha'], {
      disabledRemote: new Set(),
      isUserEnabled: () => true,
    });
    reg.resetForRouteChange('r2');
    await reg.initForCurrentRoute(['alpha'], {
      disabledRemote: new Set(),
      isUserEnabled: () => true,
    });
    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Alpha Feature'));
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('failed to start'));
  });

  it('does not notify for teardown errors (console-only)', async () => {
    const notify = vi.fn();
    const reg = createFeatureRegistry({ logger: makeLogger(), notify });
    reg.register({
      manifest: { id: 'alpha', name: 'alpha', contexts: [] },
      init: () => {},
      teardown: () => {
        throw new Error('teardown boom');
      },
    });
    await reg.initForCurrentRoute(['alpha'], {
      disabledRemote: new Set(),
      isUserEnabled: () => true,
    });
    reg.resetForRouteChange('r2');
    await reg.initForCurrentRoute(['alpha'], {
      disabledRemote: new Set(['alpha']),
      isUserEnabled: () => true,
    });
    expect(notify).not.toHaveBeenCalled();
  });

  it('default notify renders a toast into the document on init failure', async () => {
    const reg = createFeatureRegistry({ logger: makeLogger() });
    reg.register({
      manifest: { id: 'alpha', name: 'Alpha Feature', contexts: [] },
      init: () => {
        throw new Error('boom');
      },
    });
    await reg.initForCurrentRoute(['alpha'], {
      disabledRemote: new Set(),
      isUserEnabled: () => true,
    });
    const container = document.getElementById('sfdt-toast-container');
    expect(container?.textContent).toContain('Alpha Feature');
    container?.remove();
  });

  it('tracks feature.disabled.remote when a running feature is newly kill-switched', async () => {
    const track = vi.fn();
    const reg = createFeatureRegistry({ logger: makeLogger(), track });
    reg.register({
      manifest: { id: 'alpha', name: 'alpha', contexts: [] },
      init: () => {},
      teardown: () => {},
    });
    await reg.initForCurrentRoute(['alpha'], {
      disabledRemote: new Set(),
      isUserEnabled: () => true,
    });
    reg.resetForRouteChange('r2');
    await reg.initForCurrentRoute(['alpha'], {
      disabledRemote: new Set(['alpha']),
      isUserEnabled: () => true,
    });
    expect(track).toHaveBeenCalledWith('feature.disabled.remote', { featureId: 'alpha' });
  });
});
