import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('execa', () => ({ execa: vi.fn() }));
vi.mock('../../src/lib/org-query.js', () => ({
  query: vi.fn(),
  // checkLimits parses `sf org list limits` output with safeParse; provide the
  // real (trivial) implementation so the mock doesn't break JSON parsing.
  safeParse: (t) => { try { return JSON.parse(t); } catch { return null; } },
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
    expect(MONITOR_DEFAULTS).toMatchObject({ limitWarnThreshold: 0.8, errorLookbackDays: 7, healthMinScore: 80 });
  });
});
