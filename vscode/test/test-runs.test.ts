import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  isTestRunFile,
  shapeTestRun,
  readTestRuns,
  testRunStatus,
  testRunCounts,
  formatRunDate,
  testRunsSection,
  testResultsDir,
} from '../src/lib/test-runs.js';

describe('isTestRunFile', () => {
  it('accepts archived run files and rejects the GUI-excluded set', () => {
    expect(isTestRunFile('2026-07-01T10-00-00-000Z-ab1cd.json')).toBe(true);
    expect(isTestRunFile('latest.json')).toBe(false);
    expect(isTestRunFile('batch_1.json')).toBe(false);
    expect(isTestRunFile('local_run.json')).toBe(false);
    expect(isTestRunFile('notes.md')).toBe(false);
  });
});

describe('shapeTestRun', () => {
  it('shapes the schemaVersion-1 log envelope (including org)', () => {
    const raw = {
      schemaVersion: '1',
      type: 'test-run',
      timestamp: '2026-07-01T10:00:00.000Z',
      durationMs: 12345,
      org: 'devhub',
      data: { passed: 10, failed: 2, errors: 1, coverage: 81 },
    };
    expect(shapeTestRun('a.json', raw)).toEqual({
      file: 'a.json',
      date: '2026-07-01T10:00:00.000Z',
      passed: 10,
      failed: 2,
      errors: 1,
      coverage: 81,
      duration: 12345,
      org: 'devhub',
    });
  });

  it('shapes a raw sf apex run test capture ({ result: { summary } })', () => {
    const raw = {
      result: {
        summary: {
          passing: 5,
          failing: 0,
          skipped: 1,
          testStartTime: '2026-06-30T09:00:00.000Z',
          testRunCoverage: '88%',
          testExecutionTimeInMs: 4200,
        },
      },
    };
    const run = shapeTestRun('b.json', raw)!;
    expect(run.passed).toBe(5);
    expect(run.failed).toBe(0);
    expect(run.skipped).toBe(1);
    expect(run.coverage).toBe(88);
    expect(run.duration).toBe(4200);
    expect(run.date).toBe('2026-06-30T09:00:00.000Z');
    expect(run.org).toBeUndefined();
  });

  it('shapes a bare { summary } capture', () => {
    const run = shapeTestRun('c.json', { summary: { passing: 3, failing: 1 } })!;
    expect(run.passed).toBe(3);
    expect(run.failed).toBe(1);
    expect(run.date).toBe('c.json'); // filename fallback, mirroring the GUI
  });

  it('shapes a bare array of per-test rows', () => {
    const raw = [
      { outcome: 'Pass', testTimestamp: '2026-06-29T08:00:00Z' },
      { outcome: 'Pass' },
      { outcome: 'Fail' },
    ];
    expect(shapeTestRun('d.json', raw)).toEqual({
      file: 'd.json',
      date: '2026-06-29T08:00:00Z',
      passed: 2,
      failed: 1,
      errors: 0,
    });
  });

  it('returns null for unknown shapes and non-objects', () => {
    expect(shapeTestRun('x.json', { something: 'else' })).toBeNull();
    expect(shapeTestRun('x.json', 'text')).toBeNull();
    expect(shapeTestRun('x.json', null)).toBeNull();
  });
});

describe('readTestRuns', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'sfdt-test-runs-'));
    await mkdir(path.join(root, 'logs', 'test-results'), { recursive: true });
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  const write = (name: string, content: unknown) =>
    writeFile(path.join(root, 'logs', 'test-results', name), JSON.stringify(content));

  it('returns [] when the directory does not exist', async () => {
    expect(await readTestRuns(path.join(root, 'nope'))).toEqual([]);
  });

  it('reads runs newest-first, skipping excluded and corrupt files', async () => {
    await write('2026-07-01T10-00-00.json', {
      schemaVersion: '1',
      type: 'test-run',
      timestamp: '2026-07-01T10:00:00Z',
      data: { passed: 8, failed: 0, errors: 0 },
    });
    await write('2026-06-30T10-00-00.json', { summary: { passing: 4, failing: 2 } });
    await write('latest.json', { summary: { passing: 8, failing: 0 } });
    await write('batch_1.json', { summary: { passing: 1, failing: 0 } });
    await writeFile(path.join(root, 'logs', 'test-results', '2026-06-29T10-00-00.json'), 'not json');

    const runs = await readTestRuns(root);
    expect(runs.map((r) => r.file)).toEqual(['2026-07-01T10-00-00.json', '2026-06-30T10-00-00.json']);
    expect(runs[0].passed).toBe(8);
    expect(runs[1].failed).toBe(2);
  });

  it('honours the limit', async () => {
    for (let i = 0; i < 5; i++) {
      await write(`2026-07-0${i + 1}.json`, { summary: { passing: i, failing: 0 } });
    }
    const runs = await readTestRuns(root, 2);
    expect(runs).toHaveLength(2);
    expect(runs[0].file).toBe('2026-07-05.json');
  });
});

describe('testRunStatus / testRunCounts / formatRunDate', () => {
  it('fails on failed or errored tests, passes otherwise', () => {
    expect(testRunStatus({ file: 'a', passed: 3, failed: 0, errors: 0 })).toBe('ok');
    expect(testRunStatus({ file: 'a', passed: 3, failed: 1, errors: 0 })).toBe('fail');
    expect(testRunStatus({ file: 'a', passed: 3, failed: 0, errors: 2 })).toBe('fail');
  });

  it('omits zero categories in counts (except passed)', () => {
    expect(testRunCounts({ file: 'a', passed: 3, failed: 0, errors: 0 })).toBe('3 passed');
    expect(testRunCounts({ file: 'a', passed: 3, failed: 1, errors: 2, skipped: 4 })).toBe(
      '3 passed · 1 failed · 2 errored · 4 skipped',
    );
  });

  it('formats parseable dates compactly and passes through the rest', () => {
    expect(formatRunDate('2026-07-01T10:30:00.000Z')).toBe('2026-07-01 10:30');
    expect(formatRunDate('weird-filename.json')).toBe('weird-filename.json');
    expect(formatRunDate(undefined)).toBe('unknown time');
  });
});

describe('testRunsSection', () => {
  it('renders an empty state offering to run sfdt test', () => {
    const section = testRunsSection([]);
    expect(section.description).toBe('none yet');
    expect(section.children?.[0].command).toEqual(['test']);
  });

  it('summarises the latest run and opens run files via the __open sentinel', () => {
    const section = testRunsSection(
      [
        { file: 'b.json', date: '2026-07-01T10:00:00Z', passed: 5, failed: 1, errors: 0, org: 'dev', coverage: 77 },
        { file: 'a.json', date: '2026-06-30T10:00:00Z', passed: 6, failed: 0, errors: 0 },
      ],
      '/proj/logs/test-results',
    );
    expect(section.status).toBe('fail');
    expect(section.description).toContain('last: FAIL');
    const [latest, previous] = section.children!;
    expect(latest.label).toBe('FAIL · 5 passed · 1 failed');
    expect(latest.description).toContain('dev');
    expect(latest.description).toContain('77% cov');
    expect(latest.command).toEqual(['__open', path.join('/proj/logs/test-results', 'b.json')]);
    expect(previous.label).toBe('PASS · 6 passed');
    expect(previous.status).toBe('ok');
  });

  it('omits click-to-open when no results dir is provided', () => {
    const section = testRunsSection([{ file: 'a.json', passed: 1, failed: 0, errors: 0 }]);
    expect(section.children?.[0].command).toBeUndefined();
  });
});

describe('testResultsDir', () => {
  it('resolves logs/test-results under the project root', () => {
    expect(testResultsDir('/proj')).toBe(path.join('/proj', 'logs', 'test-results'));
  });
});
