import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../../src/lib/config.js', () => ({ loadConfig: vi.fn() }));
vi.mock('../../src/lib/audit-runner.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, runAudit: vi.fn() };
});
vi.mock('../../src/lib/exit-codes.js', () => ({ resolveExitCode: vi.fn(() => 1) }));
vi.mock('fs-extra', () => ({ default: { ensureDir: vi.fn(), writeJson: vi.fn() } }));
vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
  })),
}));

import { loadConfig } from '../../src/lib/config.js';
import { runAudit } from '../../src/lib/audit-runner.js';
import fs from 'fs-extra';
import { registerAuditCommand } from '../../src/commands/audit.js';

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerAuditCommand(program);
  return program;
}

const mockConfig = { _projectRoot: '/project', defaultOrg: 'dev-org', logDir: '/project/logs' };
const okSnapshot = {
  timestamp: '2026-06-22T00:00:00.000Z',
  org: 'dev-org',
  checks: [{ id: 'licenses', title: 'License usage', status: 'ok', summary: 'fine', findings: [] }],
  summary: { total: 1, ok: 1, warn: 0, fail: 0, error: 0 },
};

beforeEach(() => {
  vi.resetAllMocks();
  process.exitCode = undefined;
  loadConfig.mockResolvedValue(mockConfig);
  runAudit.mockResolvedValue(okSnapshot);
  fs.ensureDir.mockResolvedValue(undefined);
  fs.writeJson.mockResolvedValue(undefined);
});

describe('audit command', () => {
  it('runs all checks by default and writes a snapshot', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'audit', 'all']);
    expect(runAudit).toHaveBeenCalledWith('dev-org', expect.objectContaining({ checks: expect.any(Array) }));
    expect(fs.writeJson).toHaveBeenCalledWith('/project/logs/audit-latest.json', okSnapshot, { spaces: 2 });
  });

  it('runs a single named check', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'audit', 'mfa']);
    expect(runAudit).toHaveBeenCalledWith('dev-org', expect.objectContaining({ checks: ['mfa'] }));
  });

  it('registers the mfa-readiness subcommand', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'audit', 'mfa-readiness']);
    expect(runAudit).toHaveBeenCalledWith('dev-org', expect.objectContaining({ checks: ['mfa-readiness'] }));
  });

  it('registers the soap-logins subcommand and passes the configured lookback', async () => {
    loadConfig.mockResolvedValue({ ...mockConfig, audit: { soapLoginLookbackDays: 60 } });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'audit', 'soap-logins']);
    expect(runAudit).toHaveBeenCalledWith('dev-org', expect.objectContaining({
      checks: ['soap-logins'],
      params: expect.objectContaining({ 'soap-logins': { lookbackDays: 60 } }),
    }));
  });

  it('defaults the soap-logins lookback from AUDIT_DEFAULTS when unconfigured', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'audit', 'soap-logins']);
    expect(runAudit).toHaveBeenCalledWith('dev-org', expect.objectContaining({
      params: expect.objectContaining({ 'soap-logins': { lookbackDays: 30 } }),
    }));
  });

  it('uses --org override', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'audit', 'all', '--org', 'staging']);
    expect(runAudit).toHaveBeenCalledWith('staging', expect.any(Object));
  });

  it('emits JSON to stdout AND persists the snapshot in --json mode', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().parseAsync(['node', 'sfdt', 'audit', 'all', '--json']);
    // The snapshot must be written even in --json mode — the GUI/bridge read it.
    expect(fs.writeJson).toHaveBeenCalled();
    const out = writeSpy.mock.calls.map((c) => c[0]).join('');
    expect(JSON.parse(out)).toMatchObject({ status: 0, result: { org: 'dev-org', summary: { ok: 1 } } });
    writeSpy.mockRestore();
  });

  it('sets a non-zero exit code when a check fails', async () => {
    runAudit.mockResolvedValue({ ...okSnapshot, summary: { total: 1, ok: 0, warn: 0, fail: 1, error: 0 } });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'audit', 'all']);
    expect(process.exitCode).toBe(1);
  });

  it('sets a non-zero exit code when a check errors (e.g. unreachable org)', async () => {
    runAudit.mockResolvedValue({ ...okSnapshot, summary: { total: 1, ok: 0, warn: 0, fail: 0, error: 1 } });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'audit', 'all']);
    expect(process.exitCode).toBe(1);
  });

  it('emits error JSON when no org is configured', async () => {
    loadConfig.mockResolvedValue({ _projectRoot: '/project' });
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().parseAsync(['node', 'sfdt', 'audit', 'all', '--json']);
    const out = writeSpy.mock.calls.map((c) => c[0]).join('');
    expect(JSON.parse(out)).toMatchObject({ status: 1 });
    writeSpy.mockRestore();
  });

  it('reports a failed audit on stderr in non-json mode', async () => {
    runAudit.mockRejectedValue(new Error('org unreachable'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'audit', 'all']);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('org unreachable'));
    expect(process.exitCode).toBe(1);
    errSpy.mockRestore();
  });

  it('warns but does not fail when the snapshot cannot be written', async () => {
    fs.writeJson.mockRejectedValue(new Error('disk full'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await createProgram().parseAsync(['node', 'sfdt', 'audit', 'all']);
    const out = stderrSpy.mock.calls.map((c) => c[0]).join('');
    expect(out).toContain('could not write snapshot');
    expect(out).toContain('disk full');
    // A write failure must not flip the exit code for an otherwise-ok audit.
    expect(process.exitCode).toBeUndefined();
    stderrSpy.mockRestore();
  });

  it('falls back to <root>/logs when logDir is unset', async () => {
    loadConfig.mockResolvedValue({ _projectRoot: '/project', defaultOrg: 'dev-org' });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'audit', 'all']);
    expect(fs.writeJson).toHaveBeenCalledWith(
      '/project/logs/audit-latest.json',
      expect.any(Object),
      { spaces: 2 },
    );
  });

  it('renders findings, truncates past 10, and handles an unknown status', async () => {
    const findings = Array.from({ length: 12 }, (_, i) => ({ username: `u${i}@x.com` }));
    runAudit.mockResolvedValue({
      ...okSnapshot,
      checks: [{ id: 'mfa', title: 'MFA', status: 'mystery', summary: 's', findings }],
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'audit', 'all']);
    const out = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(out).toContain('u0@x.com');
    expect(out).toContain('+2 more');
    expect(out).toContain('MYSTERY');
    logSpy.mockRestore();
  });
});
