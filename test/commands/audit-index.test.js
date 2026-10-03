import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../../src/lib/config.js', () => ({ loadConfig: vi.fn() }));
vi.mock('../../src/lib/org-session.js', () => ({ getOrgId: vi.fn(async () => null) }));
vi.mock('../../src/lib/notifier.js', () => ({ dispatchSnapshot: vi.fn() }));
vi.mock('../../src/lib/log-writer.js', () => ({ archiveSnapshot: vi.fn() }));
vi.mock('../../src/lib/run-history.js', () => ({ recordRun: vi.fn() }));
vi.mock('../../src/lib/readiness-index.js', () => ({ runIndexEvidence: vi.fn() }));
vi.mock('../../src/lib/audit-runner.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, runAudit: vi.fn() };
});
vi.mock('../../src/lib/exit-codes.js', () => ({ resolveExitCode: vi.fn(() => 1) }));
vi.mock('fs-extra', () => ({ default: { ensureDir: vi.fn(), writeJson: vi.fn(), writeFile: vi.fn() } }));
vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
  })),
}));

import { buildIndexEvidence } from '@sfdt/flow-core';
import { loadConfig } from '../../src/lib/config.js';
import { runAudit } from '../../src/lib/audit-runner.js';
import { runIndexEvidence } from '../../src/lib/readiness-index.js';
import fs from 'fs-extra';
import { dispatchSnapshot } from '../../src/lib/notifier.js';
import { archiveSnapshot } from '../../src/lib/log-writer.js';
import { recordRun } from '../../src/lib/run-history.js';
import { registerAuditCommand } from '../../src/commands/audit.js';

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerAuditCommand(program);
  return program;
}

const mockConfig = { _projectRoot: '/project', defaultOrg: 'dev-org', logDir: '/project/logs' };
const snap = (checks) => ({
  timestamp: '2026-09-27T00:00:00.000Z',
  org: 'dev-org',
  checks,
  summary: {
    total: checks.length,
    ok: checks.filter((c) => c.status === 'ok').length,
    warn: checks.filter((c) => c.status === 'warn').length,
    fail: checks.filter((c) => c.status === 'fail').length,
    error: checks.filter((c) => c.status === 'error').length,
  },
});
const audit = snap([{ id: 'mfa', title: 'MFA', status: 'warn', summary: '3 users without MFA', findings: [] }]);
const monitor = snap([{ id: 'health', title: 'Security health check', status: 'ok', summary: '91%', findings: [] }]);

beforeEach(() => {
  vi.resetAllMocks();
  process.exitCode = undefined;
  loadConfig.mockResolvedValue(mockConfig);
  runIndexEvidence.mockResolvedValue({ audit, monitor, evidence: buildIndexEvidence({ audit, monitor }) });
});

describe('audit --index', () => {
  it('gathers evidence instead of running a plain audit, and writes all four snapshots', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'audit', '--index']);
    expect(runAudit).not.toHaveBeenCalled();
    expect(runIndexEvidence).toHaveBeenCalledWith(
      'dev-org',
      mockConfig,
      expect.objectContaining({ auditParams: expect.any(Object), monitorParams: expect.any(Object) }),
    );
    const written = fs.writeJson.mock.calls.map(([p]) => p);
    expect(written).toEqual([
      '/project/logs/audit-latest.json',
      '/project/logs/monitor-latest.json',
      '/project/logs/index-latest.json',
    ]);
    const [mdPath, md] = fs.writeFile.mock.calls[0];
    expect(mdPath).toBe('/project/logs/index-latest.md');
    expect(md).toContain('## Permissions hygiene — WARN');
    expect(process.exitCode).toBeUndefined();
  });

  it('emits the evidence as a JSON envelope with --json', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().parseAsync(['node', 'sfdt', 'audit', '--index', '--json']);
    const env = JSON.parse(out.mock.calls.map(([s]) => s).join(''));
    out.mockRestore();
    expect(env.status).toBe(0);
    expect(env.result.dimensions).toHaveLength(8);
    expect(env.result.dimensions.find((d) => d.id === 'permissions-hygiene').status).toBe('warn');
  });

  it('archives and indexes both runs so sfdt history sees them', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'audit', '--index']);
    expect(archiveSnapshot.mock.calls.map(([dir, name, snap]) => [dir, name, snap])).toEqual([
      ['/project/logs', 'audit-results', audit],
      ['/project/logs', 'monitor-results', monitor],
    ]);
    expect(recordRun.mock.calls.map(([, row]) => [row.type, row.org])).toEqual([
      ['audit', 'dev-org'],
      ['monitor', 'dev-org'],
    ]);
  });

  it('--notify dispatches both snapshots; without it nothing is sent', async () => {
    dispatchSnapshot.mockResolvedValue({ results: [{ ok: true, channel: 'slack' }] });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'audit', '--index']);
    expect(dispatchSnapshot).not.toHaveBeenCalled();

    await createProgram().parseAsync(['node', 'sfdt', 'audit', '--index', '--notify']);
    expect(dispatchSnapshot.mock.calls.map(([snap, cfg, opts]) => [snap, cfg, opts.type])).toEqual([
      [audit, mockConfig, 'audit'],
      [monitor, mockConfig, 'monitor'],
    ]);
    expect(log.mock.calls.flat().join('\n')).toContain('Notified (monitor): slack');
  });

  it('exits non-zero when any audit or monitor check failed or errored', async () => {
    const badMonitor = snap([{ id: 'errors', title: 'Apex errors', status: 'fail', summary: 'x', findings: [] }]);
    runIndexEvidence.mockResolvedValue({ audit, monitor: badMonitor, evidence: buildIndexEvidence({ audit, monitor: badMonitor }) });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'audit', '--index']);
    expect(process.exitCode).toBe(1);
  });
});
