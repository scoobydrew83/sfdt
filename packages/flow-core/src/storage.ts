// Pluggable async key-value storage so flow-core stays free of chrome.* and Node fs.
// The extension wraps chrome.storage.local; sfdt CLI wraps a JSON file under
// ~/.sfdt/flow-core/; tests use the in-memory adapter below.

export interface KeyValueStorage {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
}

export function createMemoryStorage(seed: Record<string, unknown> = {}): KeyValueStorage {
  const store = new Map<string, unknown>(Object.entries(seed));
  return {
    async get<T = unknown>(key: string): Promise<T | null> {
      return (store.has(key) ? (store.get(key) as T) : null);
    },
    async set<T = unknown>(key: string, value: T): Promise<void> {
      store.set(key, value);
    },
    async remove(key: string): Promise<void> {
      store.delete(key);
    },
  };
}
