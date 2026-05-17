// Vitest setup: install a minimal in-memory shim for chrome.storage and
// chrome.runtime so settings.ts and feature-registry.ts can run unmodified
// under happy-dom. Production code uses the real chrome.* APIs.

import { vi } from 'vitest';

type StorageBucket = Record<string, unknown>;
type ChangeListener = (
  changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
  area: 'local' | 'sync' | 'managed' | 'session',
) => void;

const localBucket: StorageBucket = {};
const changeListeners = new Set<ChangeListener>();

function makeStorageArea(bucket: StorageBucket, areaName: 'local' | 'sync') {
  return {
    get: (keys: string | string[] | null, cb: (items: StorageBucket) => void) => {
      let out: StorageBucket;
      if (keys === null || keys === undefined) {
        out = { ...bucket };
      } else if (typeof keys === 'string') {
        out = { [keys]: bucket[keys] };
      } else {
        out = {};
        for (const k of keys) out[k] = bucket[k];
      }
      queueMicrotask(() => cb(out));
    },
    set: (items: StorageBucket, cb?: () => void) => {
      const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { oldValue: bucket[k], newValue: v };
        bucket[k] = v;
      }
      queueMicrotask(() => {
        for (const listener of changeListeners) listener(changes, areaName);
        cb?.();
      });
    },
    remove: (keys: string | string[], cb?: () => void) => {
      const list = typeof keys === 'string' ? [keys] : keys;
      for (const k of list) delete bucket[k];
      queueMicrotask(() => cb?.());
    },
    clear: (cb?: () => void) => {
      for (const k of Object.keys(bucket)) delete bucket[k];
      queueMicrotask(() => cb?.());
    },
  };
}

(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: {
    local: makeStorageArea(localBucket, 'local'),
    sync: makeStorageArea({}, 'sync'),
    onChanged: {
      addListener: (listener: ChangeListener) => changeListeners.add(listener),
      removeListener: (listener: ChangeListener) => changeListeners.delete(listener),
    },
  },
  runtime: {
    sendMessage: vi.fn(),
    lastError: undefined,
    onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    openOptionsPage: vi.fn(),
  },
  cookies: {
    get: vi.fn((details: { url: string; name: string }, cb: (cookie: unknown) => void) => {
      queueMicrotask(() => cb({ value: `sid-for-${details.url}` }));
    }),
  },
};

// Reset between test files so storage state doesn't leak.
import { beforeEach } from 'vitest';
beforeEach(() => {
  for (const k of Object.keys(localBucket)) delete localBucket[k];
  changeListeners.clear();
});
