// A small most-recently-used store for command-palette selections, kept in
// chrome.storage.local (same bucket + rationale as lib/settings.ts). Read by
// palette-sources for recent-first ordering; the ordering logic itself stays
// pure in palette-sources — this module only persists the id list.

const RECENTS_KEY = 'sfdt.palette.recents';
const MAX_RECENTS = 20;

/**
 * Pure MRU merge: put `id` at the front, drop any earlier occurrence, bound the
 * list to `max`. Exported so the dedupe/bound rule is testable without storage.
 */
export function mergeRecent(list: readonly string[], id: string, max = MAX_RECENTS): string[] {
  return [id, ...list.filter((x) => x !== id)].slice(0, max);
}

export async function loadRecents(): Promise<string[]> {
  return new Promise((resolve) => {
    chrome.storage.local.get(RECENTS_KEY, (result) => {
      const raw = result?.[RECENTS_KEY];
      resolve(Array.isArray(raw) ? (raw.filter((x) => typeof x === 'string') as string[]) : []);
    });
  });
}

export async function pushRecent(id: string): Promise<void> {
  const next = mergeRecent(await loadRecents(), id);
  return new Promise((resolve) => {
    chrome.storage.local.set({ [RECENTS_KEY]: next }, () => resolve());
  });
}
