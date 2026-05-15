// Persistent fallback for the remote kill-switch list. Written on every
// successful ping; read on boot when the ping fails / times out.
//
// Stored under chrome.storage.local['sfut.killswitch.cache'] with a timestamp
// so future work can age out very-stale caches. Today we honour the cached
// list indefinitely — better to keep a known-broken feature disabled than
// have it suddenly reappear when the bridge is offline.

const STORAGE_KEY = 'sfut.killswitch.cache';

interface CacheRecord {
  disabled: string[];
  ts: number;
}

export async function readKillSwitchCache(): Promise<readonly string[]> {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEY, (result) => {
      const raw = result?.[STORAGE_KEY] as CacheRecord | undefined;
      if (!raw || !Array.isArray(raw.disabled)) return resolve([]);
      resolve(raw.disabled.filter((v) => typeof v === 'string' && v.length > 0));
    });
  });
}

export async function writeKillSwitchCache(disabled: readonly string[]): Promise<void> {
  const record: CacheRecord = { disabled: [...disabled], ts: Date.now() };
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY]: record }, () => resolve());
  });
}
