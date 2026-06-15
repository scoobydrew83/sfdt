import { describe, it, expect, beforeEach } from 'vitest';
import {
  readKillSwitchCache,
  writeKillSwitchCache,
  KILL_SWITCH_CACHE_MAX_AGE_MS,
} from '../lib/killswitch-cache.js';

describe('killswitch-cache', () => {
  beforeEach(() => {
    chrome.storage.local.clear();
  });

  it('returns [] when nothing has been written', async () => {
    expect(await readKillSwitchCache()).toEqual([]);
  });

  it('round-trips an array of feature ids', async () => {
    await writeKillSwitchCache(['canvas-search', 'flow-deploy']);
    expect(await readKillSwitchCache()).toEqual(['canvas-search', 'flow-deploy']);
  });

  it('overwrites the previous list on each write', async () => {
    await writeKillSwitchCache(['a', 'b']);
    await writeKillSwitchCache(['c']);
    expect(await readKillSwitchCache()).toEqual(['c']);
  });

  it('filters non-string entries on read (defensive)', async () => {
    chrome.storage.local.set({
      'sfut.killswitch.cache': { disabled: ['canvas-search', 42, null], ts: Date.now() },
    } as any);
    expect(await readKillSwitchCache()).toEqual(['canvas-search']);
  });

  it('honours a fresh cache (younger than 24h)', async () => {
    const now = Date.now();
    chrome.storage.local.set({
      'sfut.killswitch.cache': {
        disabled: ['canvas-search'],
        ts: now - (KILL_SWITCH_CACHE_MAX_AGE_MS - 60_000), // 23h59m old
      },
    } as any);
    expect(await readKillSwitchCache(now)).toEqual(['canvas-search']);
  });

  it('treats a cache older than 24h as stale and falls back to the default ([])', async () => {
    const now = Date.now();
    chrome.storage.local.set({
      'sfut.killswitch.cache': {
        disabled: ['canvas-search'],
        ts: now - (KILL_SWITCH_CACHE_MAX_AGE_MS + 60_000), // 24h01m old
      },
    } as any);
    expect(await readKillSwitchCache(now)).toEqual([]);
  });

  it('treats an un-stamped legacy record (missing ts) as stale', async () => {
    chrome.storage.local.set({
      'sfut.killswitch.cache': { disabled: ['canvas-search'] },
    } as any);
    expect(await readKillSwitchCache()).toEqual([]);
  });
});
