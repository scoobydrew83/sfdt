// Cache is honoured indefinitely — better to keep a known-broken feature
// disabled than have it reappear when the bridge is offline. ts is stored
// for a future age-out pass.

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
