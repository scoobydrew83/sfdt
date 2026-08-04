import { describe, it, expect, beforeEach } from 'vitest';
import {
  mergeEntry,
  truncateResource,
  loadActivity,
  recordActivity,
  clearActivity,
  MAX_ENTRIES,
  RESOURCE_MAX,
  type ActivityEntry,
} from '../lib/activity-log.js';
import { _clearSettingsCacheForTests } from '../lib/settings.js';

function entry(over: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    ts: 1_000,
    featureId: 'soql-runner',
    action: 'SOQL Query',
    status: 'success',
    ...over,
  };
}

/** Minimal chrome.storage.local double backed by a plain object. */
function installStorage(seed: Record<string, unknown> = {}): Record<string, unknown> {
  const store: Record<string, unknown> = { ...seed };
  (globalThis as any).chrome = {
    runtime: { lastError: undefined },
    storage: {
      local: {
        get: (key: string, cb: (r: Record<string, unknown>) => void) =>
          cb({ [key]: store[key] }),
        set: (patch: Record<string, unknown>, cb: () => void) => {
          Object.assign(store, patch);
          cb();
        },
        remove: (key: string, cb: () => void) => {
          delete store[key];
          cb();
        },
      },
    },
  };
  return store;
}

describe('lib/activity-log', () => {
  beforeEach(() => {
    _clearSettingsCacheForTests();
    installStorage();
  });

  describe('truncateResource', () => {
    it('collapses whitespace so a multi-line statement reads as one row', () => {
      expect(truncateResource('SELECT Id\n  FROM   Account')).toBe('SELECT Id FROM Account');
    });

    it('caps at the privacy bound', () => {
      const long = 'x'.repeat(500);
      const out = truncateResource(long);
      expect(out.length).toBe(RESOURCE_MAX);
      expect(out.endsWith('…')).toBe(true);
    });

    it('cannot be padded past the cap with whitespace', () => {
      // Newlines collapse BEFORE the slice, so padding can't smuggle extra
      // characters of a WHERE clause into storage.
      const padded = `${'a'.repeat(200)}\n\n\n${'b'.repeat(200)}`;
      expect(truncateResource(padded).length).toBe(RESOURCE_MAX);
    });

    it('leaves a short value untouched', () => {
      expect(truncateResource('BatchLeadScoring.cls')).toBe('BatchLeadScoring.cls');
    });
  });

  describe('mergeEntry', () => {
    it('puts the newest entry first', () => {
      const older = entry({ ts: 1 });
      const newer = entry({ ts: 2 });
      expect(mergeEntry([older], newer)).toEqual([newer, older]);
    });

    it('bounds the list, dropping the oldest', () => {
      const list = Array.from({ length: MAX_ENTRIES }, (_, i) => entry({ ts: i }));
      const merged = mergeEntry(list, entry({ ts: 9_999 }));
      expect(merged.length).toBe(MAX_ENTRIES);
      expect(merged[0]?.ts).toBe(9_999);
      // The oldest (ts: MAX_ENTRIES - 1, last in the array) fell off the end.
      expect(merged.at(-1)?.ts).toBe(MAX_ENTRIES - 2);
    });

    it('does not dedupe — running the same query twice is two events', () => {
      const a = entry({ ts: 1 });
      const b = entry({ ts: 2 });
      expect(mergeEntry([a], b).length).toBe(2);
    });
  });

  describe('loadActivity', () => {
    it('returns [] when nothing is stored', async () => {
      expect(await loadActivity()).toEqual([]);
    });

    it('drops corrupt or foreign-shaped rows rather than rendering them', async () => {
      installStorage({
        'sfdt.activity': [
          entry(),
          null,
          'nope',
          { ts: 'not-a-number', featureId: 'x', action: 'y', status: 'success' },
          { ts: 1, featureId: 'x', action: 'y', status: 'bogus' },
          { ts: 1, featureId: 'x', action: 'y', status: 'failed', resource: 42 },
        ],
      });
      const loaded = await loadActivity();
      expect(loaded).toEqual([entry()]);
    });

    it('survives a storage throw', async () => {
      (globalThis as any).chrome = {
        storage: {
          local: {
            get: () => {
              throw new Error('storage exploded');
            },
          },
        },
      };
      await expect(loadActivity()).resolves.toEqual([]);
    });
  });

  describe('recordActivity', () => {
    it('stamps the time and truncates the resource on the way in', async () => {
      const store = installStorage();
      await recordActivity(
        { featureId: 'soql-runner', action: 'SOQL Query', status: 'success', resource: 'y'.repeat(400) },
        4_242,
      );
      const [written] = store['sfdt.activity'] as ActivityEntry[];
      expect(written?.ts).toBe(4_242);
      expect(written?.resource?.length).toBe(RESOURCE_MAX);
    });

    it('omits resource entirely when the caller passes none', async () => {
      const store = installStorage();
      await recordActivity({ featureId: 'org-limits', action: 'Limits', status: 'success' });
      const [written] = store['sfdt.activity'] as ActivityEntry[];
      expect('resource' in (written as object)).toBe(false);
    });

    it('writes nothing when the user has switched the log off', async () => {
      const store = installStorage({ 'sfdt.settings': { activityLog: { enabled: false } } });
      await recordActivity({ featureId: 'soql-runner', action: 'SOQL Query', status: 'success' });
      expect(store['sfdt.activity']).toBeUndefined();
    });

    it('records by default (the panel it backs must not ship empty)', async () => {
      const store = installStorage();
      await recordActivity({ featureId: 'soql-runner', action: 'SOQL Query', status: 'success' });
      expect((store['sfdt.activity'] as ActivityEntry[]).length).toBe(1);
    });

    it('never throws into the caller — a failed write cannot break a successful run', async () => {
      (globalThis as any).chrome = {
        storage: {
          local: {
            get: (_k: string, cb: (r: Record<string, unknown>) => void) => cb({}),
            set: () => {
              throw new Error('quota exceeded');
            },
          },
        },
      };
      await expect(
        recordActivity({ featureId: 'soql-runner', action: 'SOQL Query', status: 'failed' }),
      ).resolves.toBeUndefined();
    });

    it('keeps the ring bounded across many writes', async () => {
      const store = installStorage();
      for (let i = 0; i < MAX_ENTRIES + 25; i++) {
        await recordActivity({ featureId: 'soql-runner', action: `run ${i}`, status: 'success' }, i);
      }
      expect((store['sfdt.activity'] as ActivityEntry[]).length).toBe(MAX_ENTRIES);
    });
  });

  describe('clearActivity', () => {
    it('removes the key', async () => {
      const store = installStorage({ 'sfdt.activity': [entry()] });
      await clearActivity();
      expect(store['sfdt.activity']).toBeUndefined();
    });

    it('survives a storage throw', async () => {
      (globalThis as any).chrome = {
        storage: {
          local: {
            remove: () => {
              throw new Error('nope');
            },
          },
        },
      };
      await expect(clearActivity()).resolves.toBeUndefined();
    });
  });
});
