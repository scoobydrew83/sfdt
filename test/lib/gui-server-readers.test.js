import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { writeLog, readLatestLog } from '../../src/lib/log-writer.js';

let tmpDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sfdt-readers-test-'));
});

afterEach(async () => {
  await fs.remove(tmpDir);
});

describe('preflight log round-trip', () => {
  it('writeLog then readLatestLog returns shaped preflight data', async () => {
    const data = {
      status: 'PASS',
      checks: [
        { name: 'git', status: 'PASS', message: 'Clean' },
        { name: 'changelog', status: 'WARN', message: '' },
      ],
    };
    await writeLog(tmpDir, 'preflight', data, { org: 'dev', projectName: 'Proj', exitCode: 0, durationMs: 100 });

    const log = await readLatestLog(tmpDir, 'preflight');
    expect(log).not.toBeNull();
    expect(log.type).toBe('preflight');
    expect(log.data.status).toBe('PASS');
    expect(log.data.checks).toHaveLength(2);
    expect(log.data.checks[0]).toEqual({ name: 'git', status: 'PASS', message: 'Clean' });
    // Empty message is stored as-is in the log; normalization to null happens in readPreflight
    expect(log.data.checks[1].message).toBe('');
  });
});

describe('drift log round-trip', () => {
  it('writeLog then readLatestLog returns shaped drift data', async () => {
    const data = {
      status: 'drift',
      components: [
        { name: 'MyClass', type: 'Unknown', drift: 'Modified' },
        { name: 'MyTrigger', type: 'Unknown', drift: 'Added' },
      ],
    };
    await writeLog(tmpDir, 'drift', data, { org: 'staging', projectName: 'Proj', exitCode: 0, durationMs: 200 });

    const log = await readLatestLog(tmpDir, 'drift');
    expect(log).not.toBeNull();
    expect(log.type).toBe('drift');
    expect(log.data.status).toBe('drift');
    expect(log.data.components).toHaveLength(2);
    expect(log.data.components[0]).toEqual({ name: 'MyClass', type: 'Unknown', drift: 'Modified' });
  });
});

describe('test-run log round-trip', () => {
  it('writeLog then readLatestLog returns shaped test-run data', async () => {
    const data = {
      passed: 42,
      failed: 1,
      errors: 0,
      skipped: 2,
      coverage: 87.5,
      tests: [{ name: 'MyClass_Test', status: 'Pass', durationMs: 150, message: null }],
    };
    await writeLog(tmpDir, 'test-run', data, { exitCode: 1, durationMs: 5000 });

    const log = await readLatestLog(tmpDir, 'test-run');
    expect(log).not.toBeNull();
    expect(log.type).toBe('test-run');
    expect(log.data.passed).toBe(42);
    expect(log.data.failed).toBe(1);
    expect(log.data.coverage).toBe(87.5);
    expect(log.data.tests).toHaveLength(1);
  });

  it('latest.json in test-results is not a duplicate when reading archive files', async () => {
    // Simulate what writeLog does: creates both latest.json and a timestamped archive
    await writeLog(tmpDir, 'test-run', { passed: 5, failed: 0, errors: 0, skipped: 0, coverage: 90, tests: [] }, {});
    await new Promise((r) => setTimeout(r, 2));
    await writeLog(tmpDir, 'test-run', { passed: 7, failed: 0, errors: 0, skipped: 0, coverage: 92, tests: [] }, {});

    const testResultsDir = path.join(tmpDir, 'test-results');
    const entries = await fs.readdir(testResultsDir);
    const archiveFiles = entries.filter((f) => f.endsWith('.json') && f !== 'latest.json');

    // Should have exactly 2 archive files (not 3 counting latest.json)
    expect(archiveFiles).toHaveLength(2);
  });
});

describe('readLatestLog returns null for legacy/missing files', () => {
  it('returns null when no log file exists', async () => {
    expect(await readLatestLog(tmpDir, 'preflight')).toBeNull();
  });

  it('returns null for a file without schemaVersion', async () => {
    // Simulate a legacy raw log file
    await fs.outputJson(path.join(tmpDir, 'preflight-latest.json'), {
      date: '2026-04-25T00:00:00Z',
      command: 'preflight',
      exitCode: 0,
      lines: ['[PASS] git', '[WARN] changelog'],
    });
    expect(await readLatestLog(tmpDir, 'preflight')).toBeNull();
  });
});
