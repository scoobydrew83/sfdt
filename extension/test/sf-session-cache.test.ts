import { describe, it, expect } from 'vitest';
import { createSessionCache, type StorageAreaLike } from '../lib/sf-session-cache.js';
import type { SessionCacheEntry } from '../lib/sf-api-proxy.js';

// In-memory stand-in for chrome.storage.session's promise API. Records every
// key it's asked to write so tests can assert the `sfData_<host>` key format.
function fakeArea(): StorageAreaLike & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    store,
    async get(key: string) {
      return store.has(key) ? { [key]: store.get(key) } : {};
    },
    async set(items: Record<string, unknown>) {
      for (const [k, v] of Object.entries(items)) store.set(k, v);
    },
    async remove(key: string) {
      store.delete(key);
    },
  };
}

const ENTRY: SessionCacheEntry = { baseUrl: 'https://acme.my.salesforce.com', orgId: '00Dxx0000001' };

describe('createSessionCache', () => {
  it('keys entries per host as sfData_<host>', async () => {
    const area = fakeArea();
    const cache = createSessionCache(area);
    await cache.set('acme.lightning.force.com', ENTRY);
    expect([...area.store.keys()]).toEqual(['sfData_acme.lightning.force.com']);
  });

  it('round-trips set → get for a host', async () => {
    const cache = createSessionCache(fakeArea());
    await cache.set('acme.lightning.force.com', ENTRY);
    expect(await cache.get('acme.lightning.force.com')).toEqual(ENTRY);
  });

  it('returns null for a missing host (cleared cache re-resolves)', async () => {
    const cache = createSessionCache(fakeArea());
    expect(await cache.get('never.seen.com')).toBeNull();
  });

  it('delete removes the entry so the next get misses', async () => {
    const cache = createSessionCache(fakeArea());
    await cache.set('acme.lightning.force.com', ENTRY);
    await cache.delete('acme.lightning.force.com');
    expect(await cache.get('acme.lightning.force.com')).toBeNull();
  });

  it('ignores a malformed stored value', async () => {
    const area = fakeArea();
    area.store.set('sfData_acme.lightning.force.com', { nope: true });
    expect(await createSessionCache(area).get('acme.lightning.force.com')).toBeNull();
  });

  it('never throws on a storage failure — treats it as a miss', async () => {
    const throwing: StorageAreaLike = {
      get: async () => {
        throw new Error('storage unavailable');
      },
      set: async () => {
        throw new Error('storage unavailable');
      },
      remove: async () => {
        throw new Error('storage unavailable');
      },
    };
    const cache = createSessionCache(throwing);
    await expect(cache.set('h', ENTRY)).resolves.toBeUndefined();
    await expect(cache.get('h')).resolves.toBeNull();
    await expect(cache.delete('h')).resolves.toBeUndefined();
  });
});
