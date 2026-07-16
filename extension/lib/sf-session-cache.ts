// Per-host session-resolution cache for the worker's Salesforce API proxy.
//
// It stores ONLY the resolved API base URL + the org id (both non-secret and
// already present in URLs) — never the sid. The sid is always re-read fresh
// from the cookie inside the worker on every request; caching it would violate
// the "sid never leaves the worker" guarantee. What we cache is the *result* of
// resolution (which of the candidate base domains actually served the org), so
// repeat calls skip the multi-cookie candidate scan and read a single cookie.
//
// background.ts backs this with `chrome.storage.session` (memory-only, cleared
// when the browser closes, and — at its default TRUSTED_CONTEXTS access level —
// unreadable by content scripts). It is NEVER backed by chrome.storage.local.
// The storage area is injected so the logic is unit-testable without chrome.

import type { SessionCache, SessionCacheEntry } from './sf-api-proxy.js';

// Minimal shape of the chrome.storage area we depend on (promise form, MV3).
export interface StorageAreaLike {
  get(keys: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string): Promise<void>;
}

// SF Spotlight keys its per-host session blob `sfData_<host>`; we mirror that.
const KEY_PREFIX = 'sfData_';

function keyFor(host: string): string {
  return `${KEY_PREFIX}${host}`;
}

function isEntry(value: unknown): value is SessionCacheEntry {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as SessionCacheEntry).baseUrl === 'string' &&
    typeof (value as SessionCacheEntry).orgId === 'string'
  );
}

export function createSessionCache(area: StorageAreaLike): SessionCache {
  return {
    async get(host: string): Promise<SessionCacheEntry | null> {
      const key = keyFor(host);
      try {
        const raw = await area.get(key);
        const value = raw?.[key];
        return isEntry(value) ? value : null;
      } catch {
        return null; // storage hiccup — treat as a cache miss, re-resolve.
      }
    },
    async set(host: string, entry: SessionCacheEntry): Promise<void> {
      try {
        await area.set({ [keyFor(host)]: entry });
      } catch {
        // Best-effort cache; a write failure just means the next call re-resolves.
      }
    },
    async delete(host: string): Promise<void> {
      try {
        await area.remove(keyFor(host));
      } catch {
        // Best-effort; nothing to do.
      }
    },
  };
}
