import { describe, it, expect, beforeEach } from 'vitest';
import { readKillSwitchCache, writeKillSwitchCache } from '../lib/killswitch-cache.js';

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
      'sfut.killswitch.cache': { disabled: ['canvas-search', 42, null], ts: 0 },
    } as any);
    expect(await readKillSwitchCache()).toEqual(['canvas-search']);
  });
});
