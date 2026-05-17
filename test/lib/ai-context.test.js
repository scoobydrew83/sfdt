import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

vi.mock('fs-extra', () => ({
  default: {
    pathExists: vi.fn(),
    readdir: vi.fn(),
    readJson: vi.fn(),
  },
}));

import fs from 'fs-extra';
import {
  resolveLogDir,
  buildProjectContext,
  readLatestTestRuns,
  readLatestPreflight,
  readDeployHistory,
  buildContextBlock,
  formatTestRunsSection,
  formatPreflightSection,
  formatDeployHistorySection,
  formatMetadataTypesSection,
} from '../../src/lib/ai-context.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides = {}) {
  return { _projectRoot: '/project', ...overrides };
}

beforeEach(() => {
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// resolveLogDir
// ---------------------------------------------------------------------------

describe('resolveLogDir', () => {
  it('returns logDir as-is when it is an absolute path', () => {
    const config = makeConfig({ logDir: '/custom/logs' });
    expect(resolveLogDir(config)).toBe('/custom/logs');
  });

  it('joins logDir to _projectRoot when logDir is relative', () => {
    const config = makeConfig({ logDir: 'my-logs' });
    expect(resolveLogDir(config)).toBe(path.join('/project', 'my-logs'));
  });

  it('falls back to <projectRoot>/logs when logDir is absent', () => {
    const config = makeConfig();
    expect(resolveLogDir(config)).toBe('/project/logs');
  });
});

// ---------------------------------------------------------------------------
// buildProjectContext
// ---------------------------------------------------------------------------

describe('buildProjectContext', () => {
  it('returns empty string when config has no relevant fields', async () => {
    fs.readJson.mockRejectedValue(new Error('not found'));
    const result = await buildProjectContext(makeConfig());
    expect(result).toBe('');
  });

  it('returns formatted section with all fields present', async () => {
    fs.readJson.mockRejectedValue(new Error('not found'));
    const config = makeConfig({
      projectName: 'My Project',
      defaultOrg: 'my-org',
      sourceApiVersion: '59.0',
      defaultSourcePath: 'force-app/main/default',
      deployment: { coverageThreshold: 80 },
      testConfig: {
        testLevel: 'RunSpecifiedTests',
        testClasses: ['AccountTest', 'ContactTest'],
        apexClasses: ['AccountService'],
      },
    });

    const result = await buildProjectContext(config);
    expect(result).toContain('## PROJECT CONTEXT');
    expect(result).toContain('- Project: My Project');
    expect(result).toContain('- Org: my-org');
    expect(result).toContain('- API Version: 59.0');
    expect(result).toContain('- Source Path: force-app/main/default');
    expect(result).toContain('- Coverage Threshold: 80%');
    expect(result).toContain('- Test Level: RunSpecifiedTests');
    expect(result).toContain('- Test Classes: AccountTest, ContactTest');
    expect(result).toContain('- Apex Classes Under Test: AccountService');
  });

  it('reads namespace from sfdx-project.json when it exists', async () => {
    fs.readJson.mockResolvedValue({ namespace: 'mynamespace' });
    const config = makeConfig({ projectName: 'NS Project' });
    const result = await buildProjectContext(config);
    expect(result).toContain('- Namespace: mynamespace');
  });

  it('silently skips namespace when sfdx-project.json is missing', async () => {
    fs.readJson.mockRejectedValue(new Error('not found'));
    const config = makeConfig({ projectName: 'No NS Project' });
    const result = await buildProjectContext(config);
    expect(result).not.toContain('Namespace');
    expect(result).toContain('## PROJECT CONTEXT');
  });

  it('uses testConfig.coverageThreshold when deployment threshold is absent', async () => {
    fs.readJson.mockRejectedValue(new Error('not found'));
    const config = makeConfig({ testConfig: { coverageThreshold: 70 } });
    const result = await buildProjectContext(config);
    expect(result).toContain('- Coverage Threshold: 70%');
  });

  it('skips empty testClasses / apexClasses arrays', async () => {
    fs.readJson.mockRejectedValue(new Error('not found'));
    const config = makeConfig({ testConfig: { testClasses: [], apexClasses: [] } });
    const result = await buildProjectContext(config);
    expect(result).not.toContain('Test Classes');
    expect(result).not.toContain('Apex Classes');
  });
});

// ---------------------------------------------------------------------------
// readLatestTestRuns
// ---------------------------------------------------------------------------

describe('readLatestTestRuns', () => {
  it('returns [] when test-results dir does not exist', async () => {
    fs.pathExists.mockResolvedValue(false);
    const result = await readLatestTestRuns(makeConfig());
    expect(result).toEqual([]);
  });

  it('returns [] when readdir throws', async () => {
    fs.pathExists.mockResolvedValue(true);
    fs.readdir.mockRejectedValue(new Error('permission denied'));
    const result = await readLatestTestRuns(makeConfig());
    expect(result).toEqual([]);
  });

  it('parses new structured envelope format (schemaVersion=1, type=test-run)', async () => {
    fs.pathExists.mockResolvedValue(true);
    fs.readdir.mockResolvedValue(['2026-04-20T10-00-00.json']);
    fs.readJson.mockResolvedValue({
      schemaVersion: '1',
      type: 'test-run',
      timestamp: '2026-04-20T10:00:00.000Z',
      durationMs: 5000,
      data: { passed: 42, failed: 1, errors: 0, coverage: 88.5 },
    });

    const runs = await readLatestTestRuns(makeConfig());
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      date: '2026-04-20T10:00:00.000Z',
      passed: 42,
      failed: 1,
      errors: 0,
      coverage: 88.5,
      duration: 5000,
    });
  });

  it('parses SF CLI result.summary format', async () => {
    fs.pathExists.mockResolvedValue(true);
    fs.readdir.mockResolvedValue(['2026-04-19T09-00-00.json']);
    fs.readJson.mockResolvedValue({
      result: {
        summary: {
          testStartTime: '2026-04-19T09:00:00.000Z',
          passing: 30,
          failing: 2,
          skipped: 1,
          testRunCoverage: '75.5%',
          testExecutionTimeInMs: 3000,
        },
      },
    });

    const runs = await readLatestTestRuns(makeConfig());
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      date: '2026-04-19T09:00:00.000Z',
      passed: 30,
      failed: 2,
      errors: 1,
      coverage: 75.5,
      duration: 3000,
    });
  });

  it('parses SF CLI summary format (without result wrapper)', async () => {
    fs.pathExists.mockResolvedValue(true);
    fs.readdir.mockResolvedValue(['2026-04-18T08-00-00.json']);
    fs.readJson.mockResolvedValue({
      summary: {
        testStartTime: '2026-04-18T08:00:00.000Z',
        passing: 20,
        failing: 0,
        skipped: 0,
        testRunCoverage: '90.0%',
        testExecutionTimeInMs: 2000,
      },
    });

    const runs = await readLatestTestRuns(makeConfig());
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      date: '2026-04-18T08:00:00.000Z',
      passed: 20,
      failed: 0,
      coverage: 90.0,
    });
  });

  it('parses legacy array format', async () => {
    fs.pathExists.mockResolvedValue(true);
    fs.readdir.mockResolvedValue(['2026-04-17T07-00-00.json']);
    fs.readJson.mockResolvedValue([
      { outcome: 'Pass', testTimestamp: '2026-04-17T07:00:00.000Z', methodName: 'testA' },
      { outcome: 'Pass', testTimestamp: '2026-04-17T07:00:00.000Z', methodName: 'testB' },
      { outcome: 'Fail', testTimestamp: '2026-04-17T07:00:00.000Z', methodName: 'testC' },
    ]);

    const runs = await readLatestTestRuns(makeConfig());
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      date: '2026-04-17T07:00:00.000Z',
      passed: 2,
      failed: 1,
      errors: 0,
    });
  });

  it('respects the limit parameter', async () => {
    fs.pathExists.mockResolvedValue(true);
    fs.readdir.mockResolvedValue([
      'c.json',
      'b.json',
      'a.json',
    ]);
    // Each readJson call returns a valid envelope
    fs.readJson.mockResolvedValue({
      schemaVersion: '1',
      type: 'test-run',
      timestamp: '2026-04-20T10:00:00.000Z',
      data: { passed: 5, failed: 0, errors: 0 },
    });

    const runs = await readLatestTestRuns(makeConfig(), 2);
    expect(runs).toHaveLength(2);
  });

  it('skips latest.json in archive listing', async () => {
    fs.pathExists.mockResolvedValue(true);
    // latest.json must be filtered out; only one real archive file
    fs.readdir.mockResolvedValue(['latest.json', '2026-04-20T10-00-00.json']);
    fs.readJson.mockResolvedValue({
      schemaVersion: '1',
      type: 'test-run',
      timestamp: '2026-04-20T10:00:00.000Z',
      data: { passed: 1, failed: 0, errors: 0 },
    });

    const runs = await readLatestTestRuns(makeConfig());
    expect(runs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// readLatestPreflight
// ---------------------------------------------------------------------------

describe('readLatestPreflight', () => {
  it('returns null when no preflight files exist', async () => {
    fs.pathExists.mockResolvedValue(false);
    fs.readdir.mockResolvedValue([]);
    const result = await readLatestPreflight(makeConfig());
    expect(result).toBeNull();
  });

  it('reads preflight-latest.json using structured envelope', async () => {
    fs.pathExists.mockResolvedValue(true);
    fs.readJson.mockResolvedValue({
      schemaVersion: '1',
      timestamp: '2026-04-25T12:00:00.000Z',
      data: { status: 'PASS', checks: [{ name: 'git', status: 'PASS' }] },
    });

    const result = await readLatestPreflight(makeConfig());
    expect(result).toMatchObject({
      date: '2026-04-25T12:00:00.000Z',
      status: 'PASS',
      checks: [{ name: 'git', status: 'PASS' }],
    });
  });

  it('returns raw object when preflight-latest.json has no schemaVersion', async () => {
    fs.pathExists.mockResolvedValue(true);
    fs.readJson.mockResolvedValue({
      date: '2026-04-25',
      status: 'WARN',
      checks: [],
    });

    const result = await readLatestPreflight(makeConfig());
    expect(result).toMatchObject({ date: '2026-04-25', status: 'WARN' });
  });

  it('falls back to preflight_*.json legacy files when primary does not exist', async () => {
    // pathExists returns false so primary is skipped
    fs.pathExists.mockResolvedValue(false);
    fs.readdir.mockResolvedValue(['preflight_2026-04-24.json', 'preflight_2026-04-23.json']);
    fs.readJson.mockResolvedValue({
      date: '2026-04-24',
      status: 'FAIL',
      checks: [{ name: 'branch', status: 'FAIL', message: 'invalid name' }],
    });

    const result = await readLatestPreflight(makeConfig());
    expect(result).not.toBeNull();
    expect(result.status).toBe('FAIL');
  });

  it('returns null when readdir for fallback also yields no candidates', async () => {
    fs.pathExists.mockResolvedValue(false);
    fs.readdir.mockResolvedValue(['some-other.json']);
    const result = await readLatestPreflight(makeConfig());
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// readDeployHistory
// ---------------------------------------------------------------------------

describe('readDeployHistory', () => {
  it('returns [] when deploy-history.json is missing', async () => {
    fs.readJson.mockRejectedValue(new Error('ENOENT'));
    const result = await readDeployHistory(makeConfig());
    expect(result).toEqual([]);
  });

  it('returns [] when file content is not an array', async () => {
    fs.readJson.mockResolvedValue({ not: 'an array' });
    const result = await readDeployHistory(makeConfig());
    expect(result).toEqual([]);
  });

  it('returns sliced array up to limit', async () => {
    const history = [
      { date: '2026-04-25', org: 'prod', exitCode: 0 },
      { date: '2026-04-24', org: 'staging', exitCode: 0 },
      { date: '2026-04-23', org: 'dev', exitCode: 1 },
      { date: '2026-04-22', org: 'dev', exitCode: 0 },
    ];
    fs.readJson.mockResolvedValue(history);

    const result = await readDeployHistory(makeConfig(), 2);
    expect(result).toHaveLength(2);
    expect(result[0].org).toBe('prod');
    expect(result[1].org).toBe('staging');
  });

  it('returns all entries when limit is larger than history length', async () => {
    fs.readJson.mockResolvedValue([{ date: '2026-04-25', org: 'prod', exitCode: 0 }]);
    const result = await readDeployHistory(makeConfig(), 10);
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// buildContextBlock
// ---------------------------------------------------------------------------

describe('buildContextBlock', () => {
  it('joins non-empty sections with two newlines', () => {
    const result = buildContextBlock(['section one', 'section two', 'section three']);
    expect(result).toBe('section one\n\nsection two\n\nsection three');
  });

  it('filters out falsy sections (null, empty string, undefined)', () => {
    const result = buildContextBlock(['first', null, '', undefined, 'last']);
    expect(result).toBe('first\n\nlast');
  });

  it('returns empty string when all sections are falsy', () => {
    expect(buildContextBlock([null, '', undefined])).toBe('');
  });

  it('returns single section without trailing separator', () => {
    expect(buildContextBlock(['only'])).toBe('only');
  });
});

// ---------------------------------------------------------------------------
// formatTestRunsSection
// ---------------------------------------------------------------------------

describe('formatTestRunsSection', () => {
  it('returns empty string for empty array', () => {
    expect(formatTestRunsSection([])).toBe('');
  });

  it('includes date, passed, and failed counts', () => {
    const runs = [{ date: '2026-04-20T10:00:00Z', passed: 15, failed: 2 }];
    const result = formatTestRunsSection(runs);
    expect(result).toContain('## RECENT TEST RUNS');
    expect(result).toContain('2026-04-20');
    expect(result).toContain('15 passed');
    expect(result).toContain('2 failed');
  });

  it('includes coverage when present', () => {
    const runs = [{ date: '2026-04-20', passed: 10, failed: 0, coverage: 92.123 }];
    const result = formatTestRunsSection(runs);
    expect(result).toContain('92.1% coverage');
  });

  it('omits coverage when not present', () => {
    const runs = [{ date: '2026-04-20', passed: 10, failed: 0 }];
    const result = formatTestRunsSection(runs);
    expect(result).not.toContain('coverage');
  });

  it('strips time portion from ISO date strings', () => {
    const runs = [{ date: '2026-04-20T15:30:00.000Z', passed: 5, failed: 0 }];
    const result = formatTestRunsSection(runs);
    expect(result).toContain('2026-04-20');
    expect(result).not.toContain('T15:30');
  });

  it('formats multiple runs', () => {
    const runs = [
      { date: '2026-04-20', passed: 10, failed: 0 },
      { date: '2026-04-19', passed: 8, failed: 1 },
    ];
    const result = formatTestRunsSection(runs);
    const lines = result.split('\n');
    expect(lines).toHaveLength(3); // header + 2 run lines
  });
});

// ---------------------------------------------------------------------------
// formatPreflightSection
// ---------------------------------------------------------------------------

describe('formatPreflightSection', () => {
  it('returns empty string for null input', () => {
    expect(formatPreflightSection(null)).toBe('');
  });

  it('includes date and status in header', () => {
    const preflight = { date: '2026-04-25T12:00:00Z', status: 'PASS', checks: [] };
    const result = formatPreflightSection(preflight);
    expect(result).toContain('## LATEST PREFLIGHT');
    expect(result).toContain('2026-04-25');
    expect(result).toContain('PASS');
  });

  it('returns header-only when checks array is empty', () => {
    const preflight = { date: '2026-04-25', status: 'PASS', checks: [] };
    const result = formatPreflightSection(preflight);
    expect(result).not.toContain('\n-');
  });

  it('formats checks array with status and name', () => {
    const preflight = {
      date: '2026-04-25T12:00:00Z',
      status: 'WARN',
      checks: [
        { name: 'git', status: 'PASS', message: 'Clean' },
        { name: 'changelog', status: 'WARN', message: 'Missing entry' },
      ],
    };
    const result = formatPreflightSection(preflight);
    expect(result).toContain('git');
    expect(result).toContain('PASS');
    expect(result).toContain('changelog');
    expect(result).toContain('WARN');
    expect(result).toContain('Missing entry');
  });

  it('handles missing checks property gracefully', () => {
    const preflight = { date: '2026-04-25', status: 'PASS' };
    const result = formatPreflightSection(preflight);
    expect(result).toContain('## LATEST PREFLIGHT');
  });

  it('handles missing date gracefully', () => {
    const preflight = { status: 'PASS', checks: [] };
    const result = formatPreflightSection(preflight);
    expect(result).toContain('unknown');
  });
});

// ---------------------------------------------------------------------------
// formatDeployHistorySection
// ---------------------------------------------------------------------------

describe('formatDeployHistorySection', () => {
  it('returns empty string for empty array', () => {
    expect(formatDeployHistorySection([])).toBe('');
  });

  it('formats date, org, and success outcome', () => {
    const history = [{ date: '2026-04-25T10:00:00Z', org: 'prod', exitCode: 0 }];
    const result = formatDeployHistorySection(history);
    expect(result).toContain('## RECENT DEPLOY HISTORY');
    expect(result).toContain('2026-04-25');
    expect(result).toContain('prod');
    expect(result).toContain('SUCCESS');
  });

  it('formats failed outcome with exit code', () => {
    const history = [{ date: '2026-04-24', org: 'staging', exitCode: 1 }];
    const result = formatDeployHistorySection(history);
    expect(result).toContain('FAILED (exit 1)');
  });

  it('includes dry-run flag when set', () => {
    const history = [{ date: '2026-04-23', org: 'dev', exitCode: 0, dryRun: true }];
    const result = formatDeployHistorySection(history);
    expect(result).toContain('[dry-run]');
  });

  it('includes skip-preflight flag when set', () => {
    const history = [{ date: '2026-04-23', org: 'dev', exitCode: 0, skipPreflight: true }];
    const result = formatDeployHistorySection(history);
    expect(result).toContain('[skip-preflight]');
  });

  it('includes both flags when both are set', () => {
    const history = [{ date: '2026-04-23', org: 'dev', exitCode: 0, dryRun: true, skipPreflight: true }];
    const result = formatDeployHistorySection(history);
    expect(result).toContain('dry-run');
    expect(result).toContain('skip-preflight');
  });

  it('omits brackets when no flags are set', () => {
    const history = [{ date: '2026-04-25', org: 'prod', exitCode: 0 }];
    const result = formatDeployHistorySection(history);
    expect(result).not.toContain('[');
  });

  it('uses "unknown org" when org is absent', () => {
    const history = [{ date: '2026-04-25', exitCode: 0 }];
    const result = formatDeployHistorySection(history);
    expect(result).toContain('unknown org');
  });
});

// ---------------------------------------------------------------------------
// formatMetadataTypesSection
// ---------------------------------------------------------------------------

describe('formatMetadataTypesSection', () => {
  it('returns empty string when no types present', () => {
    expect(formatMetadataTypesSection({ additive: {}, destructive: {} })).toBe('');
  });

  it('returns empty string for empty members arrays', () => {
    expect(formatMetadataTypesSection({ additive: { ApexClass: [] }, destructive: {} })).toBe('');
  });

  it('lists additive types', () => {
    const parsed = { additive: { ApexClass: ['AccountService', 'ContactService'] }, destructive: {} };
    const result = formatMetadataTypesSection(parsed);
    expect(result).toContain('## AFFECTED METADATA TYPES');
    expect(result).toContain('- ApexClass: AccountService, ContactService');
  });

  it('lists destructive types with (deleted) suffix', () => {
    const parsed = { additive: {}, destructive: { CustomObject: ['OldObj__c'] } };
    const result = formatMetadataTypesSection(parsed);
    expect(result).toContain('- CustomObject (deleted): OldObj__c');
  });

  it('lists both additive and destructive types', () => {
    const parsed = {
      additive: { ApexClass: ['NewClass'] },
      destructive: { ApexClass: ['OldClass'] },
    };
    const result = formatMetadataTypesSection(parsed);
    expect(result).toContain('- ApexClass: NewClass');
    expect(result).toContain('- ApexClass (deleted): OldClass');
  });

  it('handles missing additive or destructive keys gracefully', () => {
    const result = formatMetadataTypesSection({ additive: { ApexClass: ['A'] } });
    expect(result).toContain('## AFFECTED METADATA TYPES');
    expect(result).toContain('ApexClass');
  });
});
