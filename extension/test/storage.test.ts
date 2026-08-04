import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { storageGet, storageSet, storageRemove, onStorageChange } from '../lib/storage.js';
import { loadSettings, _clearSettingsCacheForTests } from '../lib/settings.js';
import { readKillSwitchCache, writeKillSwitchCache } from '../lib/killswitch-cache.js';
import { loadRecents, pushRecent } from '../lib/palette-recents.js';
import { loadActivity, recordActivity, clearActivity } from '../lib/activity-log.js';

const AREA = chrome.storage.local as unknown as Record<string, unknown>;
const ON_CHANGED = chrome.storage.onChanged as unknown as Record<string, unknown>;

/**
 * Reproduces an orphaned content script: after the extension reloads or updates
 * under an open tab, every chrome.storage entry point throws SYNCHRONOUSLY with
 * this exact message. Restores the real shims on teardown.
 */
function invalidateContext(): void {
  const boom = (): never => {
    throw new Error('Extension context invalidated.');
  };
  for (const method of ['get', 'set', 'remove', 'clear']) AREA[method] = boom;
  ON_CHANGED.addListener = boom;
  ON_CHANGED.removeListener = boom;
}

describe('lib/storage — invalidated-context guard', () => {
  const saved: Record<string, unknown> = {};

  beforeEach(() => {
    for (const method of ['get', 'set', 'remove', 'clear']) saved[method] = AREA[method];
    saved.addListener = ON_CHANGED.addListener;
    saved.removeListener = ON_CHANGED.removeListener;
    _clearSettingsCacheForTests();
  });

  afterEach(() => {
    for (const method of ['get', 'set', 'remove', 'clear']) AREA[method] = saved[method];
    ON_CHANGED.addListener = saved.addListener;
    ON_CHANGED.removeListener = saved.removeListener;
    _clearSettingsCacheForTests();
  });

  it('the harness genuinely throws — otherwise every case below is vacuous', () => {
    invalidateContext();
    expect(() => chrome.storage.local.get('k', () => {})).toThrow(/context invalidated/i);
    expect(() => chrome.storage.onChanged.addListener(() => {})).toThrow(/context invalidated/i);
  });

  it('resolves undefined from a read instead of throwing', async () => {
    invalidateContext();
    await expect(storageGet('sfdt.anything')).resolves.toBeUndefined();
  });

  it('reports false from a write instead of throwing', async () => {
    invalidateContext();
    await expect(storageSet('sfdt.anything', { a: 1 })).resolves.toBe(false);
    await expect(storageRemove('sfdt.anything')).resolves.toBe(false);
  });

  it('reports true for a write that actually lands', async () => {
    // The false above has to mean something — a guard that always reported
    // failure would pass the previous case for the wrong reason.
    await expect(storageSet('sfdt.anything', { a: 1 })).resolves.toBe(true);
    await expect(storageRemove('sfdt.anything')).resolves.toBe(true);
  });

  it('reports false when the write fails asynchronously via lastError', async () => {
    // Quota exceeded: the callback still fires, so only lastError distinguishes
    // this from success. A try/catch alone would call it a successful save.
    AREA.set = (_items: unknown, cb: () => void) => {
      (chrome.runtime as unknown as Record<string, unknown>).lastError = {
        message: 'QUOTA_BYTES quota exceeded',
      };
      queueMicrotask(() => {
        cb();
        (chrome.runtime as unknown as Record<string, unknown>).lastError = undefined;
      });
    };
    await expect(storageSet('sfdt.anything', { a: 1 })).resolves.toBe(false);
  });

  it('hands back a working no-op unsubscribe when the listener cannot register', () => {
    invalidateContext();
    let unsubscribe: (() => void) | null = null;
    expect(() => {
      unsubscribe = onStorageChange('sfdt.settings', () => {});
    }).not.toThrow();
    expect(() => unsubscribe!()).not.toThrow();
  });

  it('survives unsubscribing after the context dies mid-session', () => {
    // The real ordering: the page registers while healthy, then teardown runs
    // during the same window that killed the context.
    const unsubscribe = onStorageChange('sfdt.settings', () => {});
    invalidateContext();
    expect(() => unsubscribe()).not.toThrow();
  });

  it('delivers only changes to its own key', async () => {
    const seen = vi.fn();
    onStorageChange('sfdt.settings', seen);

    await storageSet('sfdt.other', 1);
    expect(seen).not.toHaveBeenCalled();

    await storageSet('sfdt.settings', { theme: 'dark' });
    expect(seen).toHaveBeenCalledWith({ theme: 'dark' });
  });
});

describe('storage consumers degrade to defaults on an invalidated context', () => {
  const saved: Record<string, unknown> = {};

  beforeEach(() => {
    for (const method of ['get', 'set', 'remove', 'clear']) saved[method] = AREA[method];
    _clearSettingsCacheForTests();
    invalidateContext();
  });

  afterEach(() => {
    for (const method of ['get', 'set', 'remove', 'clear']) AREA[method] = saved[method];
    _clearSettingsCacheForTests();
  });

  // Each of these runs on a Salesforce page, so each is reachable from an
  // orphaned content script after a Web Store auto-update.

  it('loadSettings returns schema defaults', async () => {
    const settings = await loadSettings();
    expect(settings.theme).toBe('auto');
    expect(settings.features).toEqual({});
  });

  it('readKillSwitchCache reports nothing disabled', async () => {
    // Failing open matters here: failing CLOSED would silently disable every
    // feature in the tab rather than just stopping the cache read.
    await expect(readKillSwitchCache()).resolves.toEqual([]);
    await expect(writeKillSwitchCache(['soql-runner'])).resolves.toBeUndefined();
  });

  it('palette recents read empty and pushes quietly', async () => {
    await expect(loadRecents()).resolves.toEqual([]);
    await expect(pushRecent('soql-runner')).resolves.toBeUndefined();
  });

  it('activity log reads empty, records nothing, clears quietly', async () => {
    await expect(loadActivity()).resolves.toEqual([]);
    await expect(
      recordActivity({ featureId: 'soql-runner', action: 'SOQL Query', status: 'success' }),
    ).resolves.toBeUndefined();
    await expect(clearActivity()).resolves.toBeUndefined();
  });
});
