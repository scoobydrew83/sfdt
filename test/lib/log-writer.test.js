import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import {
  writeLog,
  readLatestLog,
  validateLogSchema,
  parseSfdtLogLines,
} from '../../src/lib/log-writer.js';

let tmpDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sfdt-log-test-'));
});

afterEach(async () => {
  await fs.remove(tmpDir);
});

// ── parseSfdtLogLines ─────────────────────────────────────────────────────────

describe('parseSfdtLogLines', () => {
  it('parses check lines into checks array', () => {
    const lines = [
      'SFDT_LOG:check:branch-naming:PASS:Branch follows convention',
      'SFDT_LOG:check:coverage:FAIL:Coverage 62% below threshold 75%',
      '[PASS] branch-naming - Branch follows convention',
    ];
    const result = parseSfdtLogLines(lines);
    expect(result.checks).toEqual([
      { name: 'branch-naming', status: 'PASS', message: 'Branch follows convention' },
      { name: 'coverage', status: 'FAIL', message: 'Coverage 62% below threshold 75%' },
    ]);
    expect(result.components).toEqual([]);
  });

  it('parses component lines into components array', () => {
    const lines = [
      'SFDT_LOG:component:MyClass:ApexClass:Modified',
      'SFDT_LOG:component:MyTrigger:ApexTrigger:Added',
    ];
    const result = parseSfdtLogLines(lines);
    expect(result.components).toEqual([
      { name: 'MyClass', type: 'ApexClass', drift: 'Modified' },
      { name: 'MyTrigger', type: 'ApexTrigger', drift: 'Added' },
    ]);
    expect(result.checks).toEqual([]);
  });

  it('handles message field containing colons', () => {
    const lines = ['SFDT_LOG:check:coverage:WARN:Coverage: 70% (threshold: 75%)'];
    const result = parseSfdtLogLines(lines);
    expect(result.checks[0].message).toBe('Coverage: 70% (threshold: 75%)');
  });

  it('ignores non-SFDT_LOG lines', () => {
    const lines = ['normal output', '', 'SFDT_LOG:unknown:x:y:z'];
    const result = parseSfdtLogLines(lines);
    expect(result.checks).toEqual([]);
    expect(result.components).toEqual([]);
  });

  it('returns empty arrays for empty input', () => {
    const result = parseSfdtLogLines([]);
    expect(result.checks).toEqual([]);
    expect(result.components).toEqual([]);
  });

  it('returns empty arrays for null or undefined input', () => {
    expect(parseSfdtLogLines(null)).toEqual({ checks: [], components: [] });
    expect(parseSfdtLogLines(undefined)).toEqual({ checks: [], components: [] });
  });
});

// ── validateLogSchema ─────────────────────────────────────────────────────────

describe('validateLogSchema', () => {
  it('returns true for a valid preflight log', () => {
    const log = {
      schemaVersion: '1',
      type: 'preflight',
      timestamp: '2026-04-25T14:00:00.000Z',
      durationMs: 1000,
      exitCode: 0,
      org: 'my-org',
      projectName: 'My Project',
      data: { status: 'PASS', checks: [] },
    };
    expect(validateLogSchema(log)).toBe(true);
  });

  it('returns false for missing schemaVersion', () => {
    expect(validateLogSchema({ type: 'preflight', timestamp: 'x', data: {} })).toBe(false);
  });

  it('returns false for unknown type', () => {
    expect(validateLogSchema({ schemaVersion: '1', type: 'unknown', timestamp: 'x', data: {} })).toBe(false);
  });

  it('returns false for null', () => {
    expect(validateLogSchema(null)).toBe(false);
  });

  it('returns false for missing data', () => {
    expect(validateLogSchema({ schemaVersion: '1', type: 'preflight', timestamp: 'x' })).toBe(false);
  });
});

// ── writeLog ──────────────────────────────────────────────────────────────────

describe('writeLog', () => {
  it('writes preflight-latest.json with correct envelope', async () => {
    const data = { status: 'PASS', checks: [{ name: 'git', status: 'PASS', message: 'Clean' }] };
    await writeLog(tmpDir, 'preflight', data, { org: 'dev-org', projectName: 'TestProj', exitCode: 0, durationMs: 500 });

    const written = await fs.readJson(path.join(tmpDir, 'preflight-latest.json'));
    expect(written.schemaVersion).toBe('1');
    expect(written.type).toBe('preflight');
    expect(written.org).toBe('dev-org');
    expect(written.projectName).toBe('TestProj');
    expect(written.exitCode).toBe(0);
    expect(written.durationMs).toBe(500);
    expect(written.data).toEqual(data);
    expect(typeof written.timestamp).toBe('string');
  });

  it('archives a timestamped copy in preflight-results/', async () => {
    await writeLog(tmpDir, 'preflight', { status: 'PASS', checks: [] }, {});
    const archiveDir = path.join(tmpDir, 'preflight-results');
    expect(await fs.pathExists(archiveDir)).toBe(true);
    const files = await fs.readdir(archiveDir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/\.json$/);
  });

  it('prunes archive to logRetention count', async () => {
    for (let i = 0; i < 5; i++) {
      await writeLog(tmpDir, 'drift', { status: 'clean', components: [] }, { retention: 3 });
      await new Promise((r) => setTimeout(r, 2)); // ensure distinct ms timestamps in archive filenames
    }
    const archiveDir = path.join(tmpDir, 'drift-results');
    const files = await fs.readdir(archiveDir);
    expect(files.length).toBe(3);
  });

  it('writes test-results/latest.json for test-run type', async () => {
    const data = { passed: 10, failed: 0, errors: 0, skipped: 0, coverage: 85, tests: [] };
    await writeLog(tmpDir, 'test-run', data, {});
    expect(await fs.pathExists(path.join(tmpDir, 'test-results', 'latest.json'))).toBe(true);
  });

  it('archives test-run into test-results/ directory', async () => {
    await writeLog(tmpDir, 'test-run', { passed: 1, failed: 0, errors: 0, skipped: 0, coverage: 90, tests: [] }, {});
    const archiveDir = path.join(tmpDir, 'test-results');
    const files = (await fs.readdir(archiveDir)).filter((f) => f !== 'latest.json');
    expect(files.length).toBe(1);
  });
});

// ── readLatestLog ─────────────────────────────────────────────────────────────

describe('readLatestLog', () => {
  it('returns null when file does not exist', async () => {
    expect(await readLatestLog(tmpDir, 'preflight')).toBeNull();
  });

  it('returns null for corrupt JSON', async () => {
    await fs.outputFile(path.join(tmpDir, 'preflight-latest.json'), 'not json');
    expect(await readLatestLog(tmpDir, 'preflight')).toBeNull();
  });

  it('returns null for file with wrong schemaVersion', async () => {
    await fs.outputJson(path.join(tmpDir, 'preflight-latest.json'), {
      schemaVersion: '99',
      type: 'preflight',
      timestamp: 'x',
      data: {},
    });
    expect(await readLatestLog(tmpDir, 'preflight')).toBeNull();
  });

  it('returns the envelope for a valid file', async () => {
    const data = { status: 'PASS', checks: [] };
    const envelope = await writeLog(tmpDir, 'preflight', data, { org: 'x', projectName: 'y', exitCode: 0, durationMs: 1 });
    const result = await readLatestLog(tmpDir, 'preflight');
    expect(result).toEqual(envelope);
  });
});
