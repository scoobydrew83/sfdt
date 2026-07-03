import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs-extra', () => ({
  default: {
    pathExists: vi.fn(),
    readdir: vi.fn(),
    readJson: vi.fn(),
  },
}));

vi.mock('../../src/lib/log-writer.js', () => ({
  readLatestLog: vi.fn(),
}));

import fs from 'fs-extra';
import { readLatestLog } from '../../src/lib/log-writer.js';
import {
  parseTestRunLines,
  parseQualityLines,
  readTestRuns,
  readPreflight,
  readQuality,
  readDrift,
} from '../../src/lib/gui-server/parsers.js';

beforeEach(() => vi.clearAllMocks());

// ─── parseTestRunLines ────────────────────────────────────────────────────────

describe('parseTestRunLines', () => {
  it('returns zero counts when no JSON line is present', () => {
    const result = parseTestRunLines(['[INFO] running tests', '[PASS] done']);
    expect(result).toEqual({
      passed: 0, failed: 0, errors: 0, skipped: 0,
      coverage: null, tests: [], classCoverage: [],
    });
  });

  it('parses a standard SF CLI result envelope', () => {
    const payload = {
      result: {
        summary: { passing: 10, failing: 2, skipped: 1, testRunCoverage: '85.5%' },
        tests: [
          { FullName: 'MyClass.testA', Outcome: 'Pass', RunTime: 123, Message: null },
          { FullName: 'MyClass.testB', Outcome: 'Fail', RunTime: 456, Message: 'Assert failed' },
        ],
        details: {
          runTestResult: {
            codeCoverage: [
              { name: 'OrderService', numLocations: 100, numLocationsNotCovered: 20 },
              { name: 'PaymentHandler', numLocations: 50, numLocationsNotCovered: 40 },
            ],
          },
        },
      },
    };
    const result = parseTestRunLines([JSON.stringify(payload)]);
    expect(result.passed).toBe(10);
    expect(result.failed).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.coverage).toBe(85.5);
    expect(result.tests).toHaveLength(2);
    expect(result.tests[0]).toEqual({
      name: 'MyClass.testA', status: 'pass', durationMs: 123, message: null,
    });
    expect(result.tests[1].status).toBe('fail');
  });

  it('extracts classCoverage sorted by percent ascending', () => {
    const payload = {
      result: {
        summary: { passing: 5, failing: 0, skipped: 0 },
        tests: [],
        details: {
          runTestResult: {
            codeCoverage: [
              { name: 'HighCoverage', numLocations: 100, numLocationsNotCovered: 5 },
              { name: 'LowCoverage', numLocations: 100, numLocationsNotCovered: 80 },
              { name: 'MidCoverage', numLocations: 100, numLocationsNotCovered: 40 },
            ],
          },
        },
      },
    };
    const { classCoverage } = parseTestRunLines([JSON.stringify(payload)]);
    expect(classCoverage).toHaveLength(3);
    expect(classCoverage[0].name).toBe('LowCoverage');
    expect(classCoverage[0].percent).toBe(20);
    expect(classCoverage[1].name).toBe('MidCoverage');
    expect(classCoverage[1].percent).toBe(60);
    expect(classCoverage[2].name).toBe('HighCoverage');
    expect(classCoverage[2].percent).toBe(95);
  });

  it('handles top-level codeCoverage field (aggregated output)', () => {
    const payload = {
      result: {
        summary: { passing: 3, failing: 0, skipped: 0 },
        tests: [],
        codeCoverage: [
          { name: 'SomeClass', numLocations: 20, numLocationsNotCovered: 4 },
        ],
      },
    };
    const { classCoverage } = parseTestRunLines([JSON.stringify(payload)]);
    expect(classCoverage).toHaveLength(1);
    expect(classCoverage[0].percent).toBe(80);
    expect(classCoverage[0].coveredLines).toBe(16);
    expect(classCoverage[0].totalLines).toBe(20);
  });

  it('parses classCoverage from a lines dict (totalLines/lines shape)', () => {
    // Covers the c.numLocations == null branch: coverage expressed as a
    // per-line dict where 1 = covered, 0 = not covered.
    const payload = {
      result: {
        summary: { passing: 1, failing: 0, skipped: 0 },
        tests: [],
        coverage: {
          coverage: [
            { name: 'LinesClass', lines: { '1': 1, '2': 0, '3': 1, '10': 0 } },
          ],
        },
      },
    };
    const { classCoverage } = parseTestRunLines([JSON.stringify(payload)]);
    expect(classCoverage).toHaveLength(1);
    expect(classCoverage[0].coveredLines).toBe(2);
    expect(classCoverage[0].totalLines).toBe(4);
    expect(classCoverage[0].percent).toBe(50);
    expect(classCoverage[0].uncoveredLines).toEqual([2, 10]);
  });

  it('returns zero percent when numLocations is 0', () => {
    const payload = {
      result: {
        summary: { passing: 1, failing: 0, skipped: 0 },
        tests: [],
        details: {
          runTestResult: {
            codeCoverage: [
              { name: 'EmptyClass', numLocations: 0, numLocationsNotCovered: 0 },
            ],
          },
        },
      },
    };
    const { classCoverage } = parseTestRunLines([JSON.stringify(payload)]);
    expect(classCoverage[0].percent).toBe(0);
  });

  it('skips non-JSON lines before finding the JSON payload', () => {
    const lines = [
      'Starting tests...',
      'Running batch 1...',
      JSON.stringify({ result: { summary: { passing: 7, failing: 0, skipped: 0 }, tests: [] } }),
      'Done.',
    ];
    const result = parseTestRunLines(lines);
    expect(result.passed).toBe(7);
  });

  it('normalises test field names from alternative SF CLI shapes', () => {
    const payload = {
      result: {
        summary: { passing: 1, failing: 0, skipped: 0 },
        tests: [{ methodName: 'myTest', outcome: 'Pass', runTime: 50, message: null }],
      },
    };
    const { tests } = parseTestRunLines([JSON.stringify(payload)]);
    expect(tests[0].name).toBe('myTest');
    expect(tests[0].status).toBe('pass');
    expect(tests[0].durationMs).toBe(50);
  });
});

// ─── parseQualityLines ────────────────────────────────────────────────────────

describe('parseQualityLines', () => {
  it('returns PASS with no violations when no JSON line found', () => {
    const result = parseQualityLines(['no json here']);
    expect(result.status).toBe('PASS');
    expect(result.violations).toHaveLength(0);
  });

  it('parses violations and sets FAIL status', () => {
    const payload = {
      result: [
        {
          fileName: 'src/MyClass.cls',
          violations: [
            { line: 10, ruleName: 'AvoidGlobalModifier', severity: 2, message: 'Use public' },
            { line: 25, ruleName: 'ApexDoc', severity: 3, message: 'Missing doc' },
          ],
        },
      ],
    };
    const result = parseQualityLines([JSON.stringify(payload)]);
    expect(result.status).toBe('FAIL');
    expect(result.violations).toHaveLength(2);
    expect(result.summary.high).toBe(1);
    expect(result.summary.medium).toBe(1);
  });

  it('accumulates summary counts across severity levels', () => {
    const payload = [
      {
        fileName: 'A.cls',
        violations: [
          { line: 1, severity: 1, ruleName: 'R', message: 'M' },
          { line: 2, severity: 2, ruleName: 'R', message: 'M' },
          { line: 3, severity: 3, ruleName: 'R', message: 'M' },
          { line: 4, severity: 4, ruleName: 'R', message: 'M' },
        ],
      },
    ];
    const result = parseQualityLines([JSON.stringify(payload)]);
    expect(result.summary).toEqual({ critical: 1, high: 1, medium: 1, low: 1 });
  });

  it('returns PASS when violations array is empty', () => {
    const payload = { result: [] };
    const result = parseQualityLines([JSON.stringify(payload)]);
    expect(result.status).toBe('PASS');
  });

  it('attaches unavailableMessage when _sfdt_unavailable is present', () => {
    const payload = { result: [], _sfdt_unavailable: 'Scanner CLI not installed' };
    const result = parseQualityLines([JSON.stringify(payload)]);
    expect(result.unavailableMessage).toBe('Scanner CLI not installed');
  });

  it('handles the labelled skipped stub (status "skipped" + reason) without crashing', () => {
    const payload = {
      status: 'skipped',
      reason: 'sf code-analyzer not installed',
      result: [],
      _sfdt_unavailable: 'sf scanner plugin not installed. Run: sf plugins install @salesforce/sfdx-scanner',
    };
    const result = parseQualityLines([JSON.stringify(payload)]);
    expect(result.violations).toEqual([]);
    expect(result.unavailableMessage).toContain('sf scanner plugin not installed');
    expect(result.summary).toEqual({ critical: 0, high: 0, medium: 0, low: 0 });
  });
});

// ─── readTestRuns ─────────────────────────────────────────────────────────────

describe('readTestRuns', () => {
  it('returns empty array when results directory does not exist', async () => {
    fs.pathExists.mockResolvedValue(false);
    expect(await readTestRuns('/logs')).toEqual([]);
  });

  it('returns empty array when readdir throws', async () => {
    fs.pathExists.mockResolvedValue(true);
    fs.readdir.mockRejectedValue(new Error('EACCES'));
    expect(await readTestRuns('/logs')).toEqual([]);
  });

  it('skips latest.json and non-json files', async () => {
    fs.pathExists.mockResolvedValue(true);
    fs.readdir.mockResolvedValue(['latest.json', 'README.txt', '20260509_120000.json']);
    fs.readJson.mockResolvedValue({
      schemaVersion: '1',
      type: 'test-run',
      timestamp: '2026-05-09T12:00:00Z',
      durationMs: 3000,
      data: { passed: 5, failed: 0, errors: 0, coverage: 80, classCoverage: [] },
    });
    const runs = await readTestRuns('/logs');
    expect(runs).toHaveLength(1);
  });

  it('skips files that fail to parse as JSON', async () => {
    // tryReadJson swallows the read/parse error and returns null, so the
    // file is skipped via the `if (!raw) continue` guard.
    fs.pathExists.mockResolvedValue(true);
    fs.readdir.mockResolvedValue(['corrupt.json']);
    fs.readJson.mockRejectedValue(new Error('Unexpected token'));
    expect(await readTestRuns('/logs')).toEqual([]);
  });

  it('parses schemaVersion 1 envelope and passes through classCoverage', async () => {
    fs.pathExists.mockResolvedValue(true);
    fs.readdir.mockResolvedValue(['20260509_120000.json']);
    const classCoverage = [
      { name: 'OrderService', coveredLines: 90, totalLines: 100, percent: 90 },
    ];
    fs.readJson.mockResolvedValue({
      schemaVersion: '1',
      type: 'test-run',
      timestamp: '2026-05-09T12:00:00Z',
      durationMs: 4000,
      data: { passed: 42, failed: 1, errors: 0, coverage: 83, classCoverage },
    });
    const runs = await readTestRuns('/logs');
    expect(runs).toHaveLength(1);
    expect(runs[0].passed).toBe(42);
    expect(runs[0].coverage).toBe(83);
    expect(runs[0].duration).toBe(4000);
    expect(runs[0].classCoverage).toEqual(classCoverage);
  });

  it('falls back to result.summary shape for legacy files', async () => {
    fs.pathExists.mockResolvedValue(true);
    fs.readdir.mockResolvedValue(['legacy.json']);
    fs.readJson.mockResolvedValue({
      result: {
        summary: {
          testStartTime: '2026-05-09T10:00:00Z',
          passing: 10,
          failing: 0,
          skipped: 0,
          testRunCoverage: '75.0%',
          testExecutionTimeInMs: 6000,
        },
      },
    });
    const runs = await readTestRuns('/logs');
    expect(runs).toHaveLength(1);
    expect(runs[0].passed).toBe(10);
    expect(runs[0].coverage).toBe(75.0);
    expect(runs[0].duration).toBe(6000);
  });

  it('falls back to raw.summary shape', async () => {
    fs.pathExists.mockResolvedValue(true);
    fs.readdir.mockResolvedValue(['flat.json']);
    fs.readJson.mockResolvedValue({
      summary: {
        testStartTime: '2026-05-08T10:00:00Z',
        passing: 3,
        failing: 1,
        skipped: 0,
        testRunCoverage: '60.0%',
        testExecutionTimeInMs: 1000,
      },
    });
    const runs = await readTestRuns('/logs');
    expect(runs[0].passed).toBe(3);
    expect(runs[0].failed).toBe(1);
  });

  it('falls back to array shape', async () => {
    fs.pathExists.mockResolvedValue(true);
    fs.readdir.mockResolvedValue(['array.json']);
    fs.readJson.mockResolvedValue([
      { outcome: 'Pass', testTimestamp: '2026-05-07T00:00:00Z' },
      { outcome: 'Fail', testTimestamp: '2026-05-07T00:00:00Z' },
    ]);
    const runs = await readTestRuns('/logs');
    expect(runs[0].passed).toBe(1);
    expect(runs[0].failed).toBe(1);
  });
});

// ─── readPreflight ────────────────────────────────────────────────────────────

describe('readPreflight', () => {
  it('returns shaped preflight data from log-writer envelope', async () => {
    readLatestLog.mockResolvedValue({
      timestamp: '2026-05-09T12:00:00Z',
      data: {
        status: 'PASS',
        checks: [
          { name: 'git', status: 'PASS', message: '' },
          { name: 'changelog', status: 'WARN', message: 'Missing entry' },
        ],
      },
    });
    const result = await readPreflight('/logs');
    expect(result.date).toBe('2026-05-09T12:00:00Z');
    expect(result.status).toBe('PASS');
    expect(result.checks).toHaveLength(2);
    expect(result.checks[0]).toEqual({ name: 'git', status: 'PASS', message: null });
    expect(result.checks[1]).toEqual({ name: 'changelog', status: 'WARN', message: 'Missing entry' });
  });

  it('returns null when no log exists and no legacy files', async () => {
    readLatestLog.mockResolvedValue(null);
    fs.readdir.mockResolvedValue([]);
    expect(await readPreflight('/logs')).toBeNull();
  });
});

// ─── readQuality ──────────────────────────────────────────────────────────────

describe('readQuality', () => {
  it('returns shaped quality data from log-writer envelope', async () => {
    readLatestLog.mockResolvedValue({
      timestamp: '2026-05-09T09:00:00Z',
      data: {
        status: 'FAIL',
        summary: { critical: 0, high: 1, medium: 2, low: 0 },
        violations: [{ file: 'A.cls', line: 5, rule: 'R', severity: 2, message: 'M' }],
        unavailableMessage: null,
      },
    });
    const result = await readQuality('/logs');
    expect(result.status).toBe('FAIL');
    expect(result.summary.high).toBe(1);
    expect(result.violations).toHaveLength(1);
    expect(result.unavailableMessage).toBeNull();
  });

  it('returns null when readLatestLog returns null', async () => {
    readLatestLog.mockResolvedValue(null);
    expect(await readQuality('/logs')).toBeNull();
  });
});

// ─── readDrift ────────────────────────────────────────────────────────────────

describe('readDrift', () => {
  it('returns shaped drift data from log-writer envelope', async () => {
    readLatestLog.mockResolvedValue({
      timestamp: '2026-05-08T08:00:00Z',
      data: {
        status: 'drift',
        components: [{ name: 'MyClass', type: 'ApexClass', drift: 'Modified' }],
      },
    });
    const result = await readDrift('/logs');
    expect(result.status).toBe('drift');
    expect(result.components).toHaveLength(1);
    expect(result.date).toBe('2026-05-08T08:00:00Z');
  });

  it('returns null when no log and no legacy files', async () => {
    readLatestLog.mockResolvedValue(null);
    fs.readdir.mockResolvedValue([]);
    expect(await readDrift('/logs')).toBeNull();
  });
});
