/**
 * A small, dependency-free TTL cache.
 *
 * ## Why the client caches at all
 *
 * The Trailhead profile API answers every request with
 * `Cache-Control: max-age=0, private, must-revalidate` (verified 2026-09-02).
 * That means **no shared cache in the path will store a response on its own** —
 * not a browser, not a CDN, not Cloudflare's edge cache. A caller who wants
 * profile data cached has to say so explicitly. Two knobs do that:
 *
 *  - `cacheTtlSeconds` on the client → passed to `fetch` as `cf.cacheTtl`,
 *    which is how a Cloudflare Worker overrides an origin's `Cache-Control`.
 *    Ignored (harmlessly) by Node and by browsers.
 *  - this cache → an in-process memo, which is what makes a burst of
 *    leaderboard renders for the same handle one request instead of N.
 *
 * Neither is enabled by default. A caching client that nobody asked for is a
 * stale-data bug waiting to happen, so both are opt-in.
 *
 * The cache is bounded (LRU-ish by insertion order) so a long-lived edge
 * isolate serving many handles cannot grow without limit.
 */

export interface TtlCacheOptions {
  /** Entry lifetime in milliseconds. */
  ttlMs: number;
  /** Maximum live entries; the oldest insertion is evicted past this. */
  maxEntries?: number;
  /** Injectable clock, in milliseconds. Defaults to `Date.now`. */
  now?: () => number;
}

interface Entry<V> {
  value: V;
  expiresAt: number;
}

const DEFAULT_MAX_ENTRIES = 500;

export class TtlCache<V> {
  readonly ttlMs: number;
  readonly maxEntries: number;
  readonly #now: () => number;
  readonly #entries = new Map<string, Entry<V>>();

  constructor(options: TtlCacheOptions) {
    this.ttlMs = options.ttlMs;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.#now = options.now ?? Date.now;
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: string): V | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.#now()) {
      this.#entries.delete(key);
      return undefined;
    }
    // Refresh recency so the bound evicts genuinely cold entries.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    if (this.ttlMs <= 0) return;
    this.#entries.delete(key);
    this.#entries.set(key, { value, expiresAt: this.#now() + this.ttlMs });
    while (this.#entries.size > this.maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
  }

  delete(key: string): void {
    this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }
}
