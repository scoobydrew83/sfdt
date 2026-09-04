import { describe, expect, it } from 'vitest';
import { TtlCache } from '../src/cache.js';

/** A hand-cranked clock, so no cache test needs a real timer. */
function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('TtlCache', () => {
  it('returns a value inside its TTL and drops it after', () => {
    const { now, advance } = clock();
    const cache = new TtlCache<string>({ ttlMs: 1000, now });

    cache.set('k', 'v');
    expect(cache.get('k')).toBe('v');

    advance(999);
    expect(cache.get('k')).toBe('v');

    advance(1);
    expect(cache.get('k')).toBeUndefined();
    // The expired entry is evicted on read, not merely hidden.
    expect(cache.size).toBe(0);
  });

  it('misses cleanly on an unknown key', () => {
    const cache = new TtlCache<string>({ ttlMs: 1000 });
    expect(cache.get('nope')).toBeUndefined();
  });

  it('evicts the coldest entry past maxEntries', () => {
    const { now } = clock();
    const cache = new TtlCache<number>({ ttlMs: 10_000, maxEntries: 2, now });

    cache.set('a', 1);
    cache.set('b', 2);
    // Touching "a" makes "b" the coldest.
    expect(cache.get('a')).toBe(1);
    cache.set('c', 3);

    expect(cache.size).toBe(2);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
  });

  it('stores nothing when the TTL is zero or negative', () => {
    const cache = new TtlCache<string>({ ttlMs: 0 });
    cache.set('k', 'v');
    expect(cache.size).toBe(0);
    expect(cache.get('k')).toBeUndefined();
  });

  it('supports explicit delete and clear', () => {
    const cache = new TtlCache<string>({ ttlMs: 1000 });
    cache.set('a', '1');
    cache.set('b', '2');

    cache.delete('a');
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(1);

    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('refreshes a re-set key rather than duplicating it', () => {
    const cache = new TtlCache<string>({ ttlMs: 1000 });
    cache.set('k', 'first');
    cache.set('k', 'second');
    expect(cache.size).toBe(1);
    expect(cache.get('k')).toBe('second');
  });
});
