// A capped, de-duplicating recent-items ring.
//
// Four features had their own: SOQL Runner, Execute Anonymous, REST Explorer
// and SOAP Explorer. Each declared `HISTORY_CAP = 20` and each wrote the same
// read → drop-duplicate → unshift → slice → write sequence over
// `chrome.storage.local`.
//
// Two things that made the copies worth collapsing beyond the line count:
//
//   1. They called `chrome.storage.local` DIRECTLY. That throws synchronously
//      once the extension is updated under an open tab — the invalidated-context
//      trap lib/storage.ts exists to absorb. Routing history through it means
//      recording a query in an orphaned tab fails quietly instead of throwing
//      onto the Salesforce page.
//   2. De-duplication was per-feature and easy to get subtly wrong: dropping an
//      older identical entry is what keeps a re-run query from filling the list
//      with itself, and the comparison has to cover every field that makes an
//      entry distinct.

import { storageGet, storageSet } from './storage.js';

/** Twenty is the historical cap in all four call sites. */
export const DEFAULT_HISTORY_CAP = 20;

interface HistoryRecord<T> {
  entries?: T[];
}

export interface HistoryStore<T> {
  /** Newest first. Resolves `[]` for unset, malformed, or dead-context reads. */
  read(): Promise<T[]>;
  /** Replace wholesale, capped. */
  write(entries: readonly T[]): Promise<void>;
  /** Add to the front, dropping any equal entry, capped. */
  push(entry: T): Promise<void>;
  clear(): Promise<void>;
}

export interface HistoryOpts<T> {
  /**
   * Maximum entries kept. `Number.POSITIVE_INFINITY` for an uncapped list —
   * Execute Anonymous's saved snippets are keyed by name and deliberately
   * unbounded, and silently capping them would delete a user's saved work.
   */
  cap?: number;
  /**
   * True when the two entries are "the same thing" and the older should go.
   * Omit for identity — which is almost never what you want for a record type,
   * so every current caller supplies one.
   */
  sameAs?: (a: T, b: T) => boolean;
}

export function createHistory<T>(storageKey: string, opts: HistoryOpts<T> = {}): HistoryStore<T> {
  const cap = opts.cap ?? DEFAULT_HISTORY_CAP;
  const sameAs = opts.sameAs;

  async function read(): Promise<T[]> {
    const raw = await storageGet<HistoryRecord<T>>(storageKey);
    // Tolerate a malformed record rather than throwing: this is user-visible
    // history, not state anything depends on, and a bad write from an older
    // build should not brick the feature that reads it.
    return Array.isArray(raw?.entries) ? raw.entries : [];
  }

  async function write(entries: readonly T[]): Promise<void> {
    await storageSet(storageKey, { entries: entries.slice(0, cap) });
  }

  return {
    read,
    write,
    async push(entry: T): Promise<void> {
      const existing = await read();
      const deduped = sameAs ? existing.filter((e) => !sameAs(e, entry)) : existing;
      await write([entry, ...deduped]);
    },
    async clear(): Promise<void> {
      await write([]);
    },
  };
}
