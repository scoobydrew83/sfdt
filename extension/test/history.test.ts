// lib/history.ts replaced four hand-rolled recent-item rings. Two properties are
// worth pinning: the rings all called chrome.storage.local DIRECTLY, which throws
// synchronously in an orphaned tab; and Execute Anonymous's saved snippets are
// deliberately UNCAPPED, so a shared helper with one default would silently
// delete a user's saved work.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHistory, DEFAULT_HISTORY_CAP } from '../lib/history.js';
import { storageGet } from '../lib/storage.js';

const AREA = chrome.storage.local as unknown as Record<string, unknown>;

interface Entry {
  query: string;
  org?: string;
}

const sameQuery = (a: Entry, b: Entry): boolean => a.query === b.query && a.org === b.org;

describe('createHistory()', () => {
  it('keeps entries newest-first', async () => {
    const h = createHistory<Entry>('sfdt.test.history', { sameAs: sameQuery });
    await h.push({ query: 'SELECT Id FROM Account' });
    await h.push({ query: 'SELECT Id FROM Contact' });
    expect((await h.read()).map((e) => e.query)).toEqual([
      'SELECT Id FROM Contact',
      'SELECT Id FROM Account',
    ]);
  });

  it('drops the older copy when the same entry is pushed again', async () => {
    // Without this a re-run query fills the whole list with itself and the
    // history stops being a history.
    const h = createHistory<Entry>('sfdt.test.history', { sameAs: sameQuery });
    await h.push({ query: 'SELECT Id FROM Account' });
    await h.push({ query: 'SELECT Id FROM Contact' });
    await h.push({ query: 'SELECT Id FROM Account' });
    expect((await h.read()).map((e) => e.query)).toEqual([
      'SELECT Id FROM Account',
      'SELECT Id FROM Contact',
    ]);
  });

  it('compares every field that makes an entry distinct', async () => {
    // The same query text against a different org is NOT the same entry — this
    // is the part per-feature dedupe kept getting subtly wrong.
    const h = createHistory<Entry>('sfdt.test.history', { sameAs: sameQuery });
    await h.push({ query: 'SELECT Id FROM Account', org: 'prod' });
    await h.push({ query: 'SELECT Id FROM Account', org: 'sandbox' });
    expect(await h.read()).toHaveLength(2);
  });

  it('caps at twenty by default', async () => {
    const h = createHistory<Entry>('sfdt.test.history', { sameAs: sameQuery });
    for (let i = 0; i < 25; i++) await h.push({ query: `q${i}` });
    const entries = await h.read();
    expect(entries).toHaveLength(DEFAULT_HISTORY_CAP);
    // The cap drops the OLDEST, not the newest.
    expect(entries[0]!.query).toBe('q24');
  });

  it('does NOT cap a list the caller declared unbounded', async () => {
    // Execute Anonymous's saved snippets are keyed by name and are user-authored
    // work. Quietly applying the default cap here would delete saved code.
    const snippets = createHistory<Entry>('sfdt.test.snippets', {
      cap: Number.POSITIVE_INFINITY,
      sameAs: sameQuery,
    });
    for (let i = 0; i < 25; i++) await snippets.push({ query: `snippet-${i}` });
    expect(await snippets.read()).toHaveLength(25);
  });

  it('reads [] rather than throwing on a record written by an older build', async () => {
    await chrome.storage.local.set({ 'sfdt.test.history': { entries: 'not-an-array' } });
    const h = createHistory<Entry>('sfdt.test.history');
    await expect(h.read()).resolves.toEqual([]);
  });

  it('clear() empties the ring', async () => {
    const h = createHistory<Entry>('sfdt.test.history', { sameAs: sameQuery });
    await h.push({ query: 'SELECT Id FROM Account' });
    await h.clear();
    expect(await h.read()).toEqual([]);
  });

  it('stores under the key it was given', async () => {
    const h = createHistory<Entry>('sfdt.test.history', { sameAs: sameQuery });
    await h.push({ query: 'SELECT Id FROM Account' });
    await expect(storageGet('sfdt.test.history')).resolves.toEqual({
      entries: [{ query: 'SELECT Id FROM Account' }],
    });
  });
});

describe('createHistory() in an orphaned tab', () => {
  const saved: Record<string, unknown> = {};

  /** An extension updated under an open tab: every chrome.* call throws, synchronously. */
  function invalidateContext(): void {
    const boom = (): never => {
      throw new Error('Extension context invalidated.');
    };
    for (const method of ['get', 'set', 'remove', 'clear']) AREA[method] = boom;
  }

  beforeEach(() => {
    for (const method of ['get', 'set', 'remove', 'clear']) saved[method] = AREA[method];
  });

  afterEach(() => {
    for (const method of ['get', 'set', 'remove', 'clear']) AREA[method] = saved[method];
  });

  it('the harness genuinely throws — otherwise both cases below are vacuous', () => {
    invalidateContext();
    expect(() => chrome.storage.local.get('k', () => {})).toThrow(/context invalidated/i);
  });

  it('reads [] instead of throwing onto the Salesforce page', async () => {
    invalidateContext();
    const h = createHistory<Entry>('sfdt.test.history', { sameAs: sameQuery });
    await expect(h.read()).resolves.toEqual([]);
  });

  it('records a query quietly instead of throwing', async () => {
    // This is the whole point of routing through lib/storage.ts. The four
    // hand-rolled rings called chrome.storage.local directly, so running a query
    // in a tab whose extension had just updated threw an uncaught error into
    // Salesforce's own console.
    invalidateContext();
    const h = createHistory<Entry>('sfdt.test.history', { sameAs: sameQuery });
    await expect(h.push({ query: 'SELECT Id FROM Account' })).resolves.toBeUndefined();
  });
});
