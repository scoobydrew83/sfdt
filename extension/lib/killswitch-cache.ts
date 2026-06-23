// The cache is a fallback for when the bridge ping fails. Entries are
// stamped with a storedAt timestamp (`ts`) at write time; reads treat
// anything older than 24h as stale and ignore it, falling back to the same
// safe default as "no cache" (nothing remotely disabled). This stops a
// bridge that has been offline since install — or a long-abandoned cache —
// from pinning features off (or on) forever. Records without a valid `ts`
// (pre-stamping writes, manual tampering) are treated as stale too: their
// age is unknowable, and the next successful ping rewrites a stamped record.

const STORAGE_KEY = 'sfdt.killswitch.cache';
// Legacy "SFUT"-era key; migrated forward on first read. Safe even for a stale
// record — the 24h staleness check below still discards it after migration.
const LEGACY_STORAGE_KEY = 'sfut.killswitch.cache';

/** Cache entries older than this are ignored on read. */
export const KILL_SWITCH_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface CacheRecord {
  disabled: string[];
  ts: number;
}

function readRecord(): Promise<CacheRecord | undefined> {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY, LEGACY_STORAGE_KEY], (result) => {
      const current = result?.[STORAGE_KEY] as CacheRecord | undefined;
      if (current !== undefined) return resolve(current);
      // One-time migration from the legacy sfut.* key.
      const legacy = result?.[LEGACY_STORAGE_KEY] as CacheRecord | undefined;
      if (legacy !== undefined) {
        chrome.storage.local.set({ [STORAGE_KEY]: legacy }, () => {
          chrome.storage.local.remove(LEGACY_STORAGE_KEY, () => resolve(legacy));
        });
        return;
      }
      resolve(undefined);
    });
  });
}

export async function readKillSwitchCache(now: number = Date.now()): Promise<readonly string[]> {
  const raw = await readRecord();
  if (!raw || !Array.isArray(raw.disabled)) return [];
  // Stale or un-stamped → behave exactly as if no cache existed.
  if (typeof raw.ts !== 'number' || now - raw.ts > KILL_SWITCH_CACHE_MAX_AGE_MS) {
    return [];
  }
  return raw.disabled.filter((v) => typeof v === 'string' && v.length > 0);
}

export async function writeKillSwitchCache(disabled: readonly string[]): Promise<void> {
  const record: CacheRecord = { disabled: [...disabled], ts: Date.now() };
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY]: record }, () => resolve());
  });
}
