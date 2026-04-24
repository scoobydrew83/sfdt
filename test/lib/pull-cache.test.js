import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  initCache, getLastSync, getDelta, updateCache, getCacheStatus,
} from '../../src/lib/pull-cache.js';

let tmpDir, db;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'sfdt-cache-test-'));
  db = initCache(tmpDir, 'test-org');
});

afterEach(() => { db.close(); rmSync(tmpDir, { recursive: true }); });

describe('initCache', () => {
  it('creates components and sync_meta tables', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    expect(tables).toContain('components');
    expect(tables).toContain('sync_meta');
  });
});

describe('getLastSync', () => {
  it('returns null before any sync', () => expect(getLastSync(db)).toBeNull());
  it('returns ISO timestamp after updateCache', () => {
    updateCache(db, new Map([['ApexClass', new Map([['MyClass', '2026-04-01T00:00:00.000Z']])]]));
    expect(getLastSync(db)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('getDelta', () => {
  it('returns all components when cache is empty', () => {
    const inv = new Map([['ApexClass', new Map([['A', '2026-04-01T00:00:00.000Z'], ['B', '2026-04-02T00:00:00.000Z']])]]);
    const delta = getDelta(db, inv);
    expect(delta.get('ApexClass')).toEqual(new Set(['A', 'B']));
  });

  it('returns only changed/new components after a prior sync', () => {
    updateCache(db, new Map([['ApexClass', new Map([['A', '2026-04-01T00:00:00.000Z']])]]));
    const fresh = new Map([['ApexClass', new Map([['A', '2026-04-10T00:00:00.000Z'], ['B', '2026-04-05T00:00:00.000Z']])]]);
    const delta = getDelta(db, fresh);
    expect(delta.get('ApexClass')).toEqual(new Set(['A', 'B']));
  });

  it('returns an empty map when nothing changed', () => {
    const inv = new Map([['ApexClass', new Map([['A', '2026-04-01T00:00:00.000Z']])]]);
    updateCache(db, inv);
    expect(getDelta(db, inv).size).toBe(0);
  });

  it('handles dates with and without milliseconds correctly', () => {
    updateCache(db, new Map([['ApexClass', new Map([['A', '2026-04-01T00:00:00.000Z']])]]));
    // Same instant, no milliseconds — should NOT appear in delta
    const fresh = new Map([['ApexClass', new Map([['A', '2026-04-01T00:00:00Z']])]]);
    expect(getDelta(db, fresh).size).toBe(0);
  });
});

describe('updateCache', () => {
  it('upserts components and sets last_sync', () => {
    updateCache(db, new Map([['Flow', new Map([['MyFlow', '2026-04-01T00:00:00.000Z']])]]));
    const row = db.prepare('SELECT * FROM components WHERE type=? AND name=?').get('Flow', 'MyFlow');
    expect(row.last_modified).toBe('2026-04-01T00:00:00.000Z');
  });

  it('overwrites stale data on re-sync', () => {
    updateCache(db, new Map([['ApexClass', new Map([['A', '2026-04-01T00:00:00.000Z']])]]));
    updateCache(db, new Map([['ApexClass', new Map([['A', '2026-04-10T00:00:00.000Z']])]]));
    const row = db.prepare('SELECT last_modified FROM components WHERE name=?').get('A');
    expect(row.last_modified).toBe('2026-04-10T00:00:00.000Z');
  });
});

describe('getCacheStatus', () => {
  it('reports zero components on fresh cache', () => {
    expect(getCacheStatus(db, 'test-org')).toEqual({ orgAlias: 'test-org', componentCount: 0, lastSync: null });
  });

  it('reports accurate count after sync', () => {
    updateCache(db, new Map([['ApexClass', new Map([['A', '2026-04-01T00:00:00.000Z'], ['B', '2026-04-01T00:00:00.000Z']])]]));
    const s = getCacheStatus(db, 'test-org');
    expect(s.componentCount).toBe(2);
    expect(s.lastSync).not.toBeNull();
  });
});
