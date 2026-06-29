import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('execa', () => ({ execa: vi.fn() }));
vi.mock('../../src/lib/org-query.js', () => ({
  query: vi.fn(),
  // checkLimits parses `sf org list limits` output with safeParse; provide the
  // real (trivial) implementation so the mock doesn't break JSON parsing.
  safeParse: (t) => { try { return JSON.parse(t); } catch { return null; } },
  toSoqlDate: (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z'),
}));
vi.mock('../../src/lib/org-inventory.js', () => ({ fetchOrgInventory: vi.fn() }));
vi.mock('../../src/lib/parallel-retrieve.js', () => ({ parallelRetrieve: vi.fn() }));
// runBackup dynamically imports fs-extra for ensureDir; mock it so the unit test
// never touches the real filesystem (the timestamped backup dir is an absolute
// path like /project/backups/... that is unwritable in CI -> EACCES).
vi.mock('fs-extra', () => ({ default: { ensureDir: vi.fn() } }));

import { execa } from 'execa';
import { query } from '../../src/lib/org-query.js';
import { fetchOrgInventory } from '../../src/lib/org-inventory.js';
import { parallelRetrieve } from '../../src/lib/parallel-retrieve.js';
import {
  checkLimits,
  checkErrors,
  checkHealth,
  checkOrgInfo,
  checkDeployHistory,
  checkDeprecatedApi,
  checkFlowErrors,
  runBackup,
  runMonitor,
  CHECK_IDS,
  MONITOR_DEFAULTS,
} from '../../src/lib/monitor-runner.js';

beforeEach(() => vi.resetAllMocks());

describe('checkLimits', () => {
  it('flags limits at or above the warn threshold', async () => {
    execa.mockResolvedValueOnce({
      stdout: JSON.stringify({
        result: [
          { name: 'DailyApiRequests', max: 100, remaining: 5 }, // 95% used
          { name: 'DataStorageMB', max: 100, remaining: 90 }, // 10% used
        ],
      }),
    });
    const r = await checkLimits('dev', { warnThreshold: 0.8 });
    expect(r.status).toBe('warn');
    expect(r.findings.map((f) => f.name)).toEqual(['DailyApiRequests']);
  });

  it('returns ok when all limits have headroom', async () => {
    execa.mockResolvedValueOnce({ stdout: JSON.stringify({ result: [{ name: 'X', max: 100, remaining: 90 }] }) });
    const r = await checkLimits('dev');
    expect(r.status).toBe('ok');
  });

  it('returns error status when sf org list limits throws', async () => {
    execa.mockRejectedValueOnce(new Error('auth failure'));
    const r = await checkLimits('dev');
    expect(r.status).toBe('error');
    expect(r.summary).toMatch(/auth failure/);
  });

  it('prefers the structured sf error message over the opaque execa error', async () => {
    const err = new Error('Command failed with exit code 1: sf org list limits');
    err.stdout = JSON.stringify({ status: 1, message: 'No authorization information found for dev.' });
    execa.mockRejectedValueOnce(err);
    const r = await checkLimits('dev');
    expect(r.status).toBe('error');
    expect(r.summary).toMatch(/No authorization information found for dev\./);
    expect(r.summary).not.toMatch(/Command failed with exit code/);
  });

  it('falls back to the structured message on stderr when stdout is empty', async () => {
    const err = new Error('Command failed with exit code 1: sf org list limits');
    err.stdout = '';
    err.stderr = JSON.stringify({ status: 1, message: 'No authorization information found for dev.' });
    execa.mockRejectedValueOnce(err);
    const r = await checkLimits('dev');
    expect(r.status).toBe('error');
    expect(r.summary).toMatch(/No authorization information found for dev\./);
    expect(r.summary).not.toMatch(/Command failed with exit code/);
  });
});

describe('checkErrors', () => {
  it('reports failed async Apex jobs as fail status', async () => {
    query.mockResolvedValueOnce([
      { JobType: 'BatchApex', ApexClass: { Name: 'NightlyJob' }, NumberOfErrors: 3, ExtendedStatus: 'err', CompletedDate: '2026-06-20T00:00:00Z' },
    ]);
    const r = await checkErrors('dev', { lookbackDays: 7 });
    expect(r.status).toBe('fail');
    expect(r.findings[0].job).toBe('NightlyJob');
  });

  it('returns ok when there are no failures', async () => {
    query.mockResolvedValueOnce([]);
    const r = await checkErrors('dev');
    expect(r.status).toBe('ok');
  });
});

describe('checkHealth', () => {
  it('warns when score is below the floor', async () => {
    query.mockResolvedValueOnce([{ Score: 62.4 }]);
    const r = await checkHealth('dev', { minScore: 80 });
    expect(r.status).toBe('warn');
    expect(r.findings[0]).toEqual({ score: 62, floor: 80 });
  });

  it('is ok when score meets the floor', async () => {
    query.mockResolvedValueOnce([{ Score: 91 }]);
    const r = await checkHealth('dev', { minScore: 80 });
    expect(r.status).toBe('ok');
  });

  it('warns when the score is unavailable (no rows)', async () => {
    query.mockResolvedValueOnce([]);
    const r = await checkHealth('dev');
    expect(r.status).toBe('warn');
    expect(r.summary).toMatch(/unavailable/);
  });
});

describe('checkOrgInfo', () => {
  it('is ok for a sandbox with no trial', async () => {
    query.mockResolvedValueOnce([
      { Name: 'Acme', InstanceName: 'NA123', OrganizationType: 'Developer Edition', IsSandbox: true, TrialExpirationDate: null },
    ]);
    const r = await checkOrgInfo('dev');
    expect(r.status).toBe('ok');
    expect(r.findings[0].instance).toBe('NA123');
  });

  it('warns when the trial expires within the window', async () => {
    const soon = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    query.mockResolvedValueOnce([
      { Name: 'Acme', InstanceName: 'NA1', OrganizationType: 'Trial', IsSandbox: false, TrialExpirationDate: soon },
    ]);
    const r = await checkOrgInfo('dev', { trialWarnDays: 14 });
    expect(r.status).toBe('warn');
    expect(r.summary).toMatch(/Trial\/expiration/);
  });

  it('warns when no Organization record is returned', async () => {
    query.mockResolvedValueOnce([]);
    const r = await checkOrgInfo('dev');
    expect(r.status).toBe('warn');
  });
});

describe('checkDeployHistory', () => {
  it('fails when the most recent deployment failed', async () => {
    query.mockResolvedValueOnce([
      { Status: 'Failed', CompletedDate: '2026-06-20T00:00:00Z', NumberComponentErrors: 2, CreatedBy: { Name: 'Dev' } },
      { Status: 'Succeeded', CompletedDate: '2026-06-19T00:00:00Z', NumberComponentErrors: 0 },
    ]);
    const r = await checkDeployHistory('dev', { lookback: 20 });
    expect(r.status).toBe('fail');
    expect(r.findings.length).toBeGreaterThan(0);
  });

  it('warns when an older deployment failed but the latest succeeded', async () => {
    query.mockResolvedValueOnce([
      { Status: 'Succeeded', CompletedDate: '2026-06-20T00:00:00Z', NumberComponentErrors: 0 },
      { Status: 'Failed', CompletedDate: '2026-06-19T00:00:00Z', NumberComponentErrors: 1 },
    ]);
    const r = await checkDeployHistory('dev');
    expect(r.status).toBe('warn');
  });

  it('is ok with no deployments', async () => {
    query.mockResolvedValueOnce([]);
    const r = await checkDeployHistory('dev');
    expect(r.status).toBe('ok');
  });

  it('degrades to warn (not error) when DeployRequest is rejected', async () => {
    query.mockRejectedValueOnce(new Error('DeployRequest requires a filter'));
    const r = await checkDeployHistory('dev');
    expect(r.status).toBe('warn');
    expect(r.summary).toMatch(/unavailable/);
  });
});

describe('checkDeprecatedApi', () => {
  it('warns when ApiTotalUsage logs are present', async () => {
    query.mockResolvedValueOnce([{ LogDate: '2026-06-20T00:00:00Z', EventType: 'ApiTotalUsage', LogFileLength: 1024 }]);
    const r = await checkDeprecatedApi('dev', { lookbackDays: 7 });
    expect(r.status).toBe('warn');
    expect(r.findings).toHaveLength(1);
  });

  it('is ok when there are no legacy API logs', async () => {
    query.mockResolvedValueOnce([]);
    const r = await checkDeprecatedApi('dev');
    expect(r.status).toBe('ok');
  });

  it('degrades to warn (not error) when EventLogFile is inaccessible', async () => {
    query.mockRejectedValueOnce(new Error('No such column EventLogFile'));
    const r = await checkDeprecatedApi('dev');
    expect(r.status).toBe('warn');
    expect(r.summary).toMatch(/unavailable/);
  });
});

describe('checkFlowErrors', () => {
  it('warns when there are paused interviews', async () => {
    query.mockResolvedValueOnce([
      { InterviewLabel: 'Onboarding 123', CurrentElement: 'Wait_1', CreatedDate: '2026-06-01T00:00:00Z' },
    ]);
    const r = await checkFlowErrors('dev');
    expect(r.status).toBe('warn');
    expect(r.findings[0].name).toBe('Onboarding 123');
  });

  it('is ok with no paused interviews', async () => {
    query.mockResolvedValueOnce([]);
    const r = await checkFlowErrors('dev');
    expect(r.status).toBe('ok');
  });

  it('degrades to warn (not error) when FlowInterview is rejected', async () => {
    query.mockRejectedValueOnce(new Error('No such column InterviewStatus'));
    const r = await checkFlowErrors('dev');
    expect(r.status).toBe('warn');
    expect(r.summary).toMatch(/unavailable/);
  });
});

describe('runBackup', () => {
  const config = { _projectRoot: '/project', monitoring: { backupDir: 'backups' } };

  it('retrieves the full inventory into a timestamped dir', async () => {
    fetchOrgInventory.mockResolvedValueOnce(new Map([['ApexClass', new Set(['A'])]]));
    parallelRetrieve.mockResolvedValueOnce({ retrieved: 1, total: 1, errors: [] });
    const r = await runBackup('dev', config);
    expect(r.status).toBe('ok');
    expect(r.outDir).toMatch(/\/project\/backups\/dev-/);
    expect(parallelRetrieve).toHaveBeenCalledWith(
      expect.any(Map),
      config,
      expect.objectContaining({ cwd: expect.stringContaining('/project/backups/dev-') }),
    );
  });

  it('warns when some retrieve batches error', async () => {
    fetchOrgInventory.mockResolvedValueOnce(new Map([['ApexClass', new Set(['A'])]]));
    parallelRetrieve.mockResolvedValueOnce({ retrieved: 0, total: 1, errors: [{ batch: ['ApexClass:A'], error: 'boom' }] });
    const r = await runBackup('dev', config);
    expect(r.status).toBe('warn');
    expect(r.findings).toHaveLength(1);
  });

  it('returns error status when inventory fetch fails', async () => {
    fetchOrgInventory.mockRejectedValueOnce(new Error('no auth'));
    const r = await runBackup('dev', config);
    expect(r.status).toBe('error');
  });
});

describe('runMonitor', () => {
  it('runs all checks and builds a summary', async () => {
    execa.mockResolvedValue({ stdout: JSON.stringify({ result: [] }) });
    query.mockResolvedValue([]);
    const snapshot = await runMonitor('dev', { _projectRoot: '/p' });
    expect(snapshot.checks).toHaveLength(CHECK_IDS.length);
    expect(snapshot.org).toBe('dev');
  });

  it('appends a backup check when backup option is set', async () => {
    execa.mockResolvedValue({ stdout: JSON.stringify({ result: [] }) });
    query.mockResolvedValue([]);
    fetchOrgInventory.mockResolvedValue(new Map());
    parallelRetrieve.mockResolvedValue({ retrieved: 0, total: 0, errors: [] });
    const snapshot = await runMonitor('dev', { _projectRoot: '/p' }, { backup: true });
    expect(snapshot.checks.some((c) => c.id === 'backup')).toBe(true);
  });
});

describe('MONITOR_DEFAULTS', () => {
  it('exposes the centralized fallback constants', () => {
    expect(MONITOR_DEFAULTS).toMatchObject({ limitWarnThreshold: 0.75, errorLookbackDays: 7, healthMinScore: 80 });
  });
});
