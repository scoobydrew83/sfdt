import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs-extra';
import { recordRun, queryRuns } from '../../src/lib/run-history.js';

let dir;
beforeEach(async () => {
  dir = path.join(os.tmpdir(), `sfdt-rh-${process.pid}-${Math.random().toString(36).slice(2)}`);
  await fs.ensureDir(dir);
});
afterEach(async () => {
  await fs.remove(dir);
});

describe('run-history', () => {
  it('records and queries runs newest-first', async () => {
    await recordRun(dir, { type: 'audit', org: 'dev', exitCode: 0, durationMs: 1200, status: 'warn', summary: { ok: 3, warn: 1 } });
    await recordRun(dir, { type: 'monitor', org: 'qa', status: 'fail' });

    const all = queryRuns(dir, { limit: 10 });
    expect(all).toHaveLength(2);
    expect(all[0].type).toBe('monitor'); // newest first
    expect(all[1]).toMatchObject({ type: 'audit', org: 'dev', exitCode: 0, durationMs: 1200, status: 'warn' });
    expect(all[1].summary).toEqual({ ok: 3, warn: 1 });
  });

  it('filters by type', async () => {
    await recordRun(dir, { type: 'audit', status: 'ok' });
    await recordRun(dir, { type: 'monitor', status: 'ok' });
    await recordRun(dir, { type: 'audit', status: 'fail' });

    const audits = queryRuns(dir, { type: 'audit' });
    expect(audits).toHaveLength(2);
    expect(audits.every((r) => r.type === 'audit')).toBe(true);
  });

  it('honours the limit', async () => {
    for (let i = 0; i < 5; i++) await recordRun(dir, { type: 'quality', status: 'pass' });
    expect(queryRuns(dir, { limit: 2 })).toHaveLength(2);
  });

  it('prunes beyond the per-type retention cap (200)', async () => {
    for (let i = 0; i < 205; i++) await recordRun(dir, { type: 'test-run', status: 'pass' });
    expect(queryRuns(dir, { type: 'test-run', limit: 1000 })).toHaveLength(200);
  });

  it('returns [] when no history db exists', () => {
    expect(queryRuns(path.join(dir, 'nope'), {})).toEqual([]);
  });

  it('is best-effort: recordRun never throws on bad input', async () => {
    await expect(recordRun(dir, { type: undefined })).resolves.toBeUndefined();
    await expect(recordRun(null, { type: 'audit' })).resolves.toBeUndefined();
  });
});
