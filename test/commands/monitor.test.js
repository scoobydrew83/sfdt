import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../../src/lib/config.js', () => ({ loadConfig: vi.fn() }));
vi.mock('../../src/lib/monitor-runner.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, runMonitor: vi.fn(), runBackup: vi.fn() };
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
import { runMonitor, runBackup } from '../../src/lib/monitor-runner.js';
import fs from 'fs-extra';
import { registerMonitorCommand } from '../../src/commands/monitor.js';

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerMonitorCommand(program);
  return program;
}

const mockConfig = { _projectRoot: '/project', defaultOrg: 'dev-org', logDir: '/project/logs' };
const okSnapshot = {
  timestamp: '2026-06-22T00:00:00.000Z',
  org: 'dev-org',
  checks: [{ id: 'limits', title: 'Org limits', status: 'ok', summary: 'fine', findings: [] }],
  summary: { total: 1, ok: 1, warn: 0, fail: 0, error: 0 },
};

beforeEach(() => {
  vi.resetAllMocks();
  process.exitCode = undefined;
  loadConfig.mockResolvedValue(mockConfig);
  runMonitor.mockResolvedValue(okSnapshot);
  runBackup.mockResolvedValue({ id: 'backup', title: 'Metadata backup', status: 'ok', summary: 'done', findings: [], outDir: '/project/backups/x' });
  fs.ensureDir.mockResolvedValue(undefined);
  fs.writeJson.mockResolvedValue(undefined);
});

describe('monitor command', () => {
  it('runs all checks by default and writes a snapshot', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'monitor', 'all']);
    expect(runMonitor).toHaveBeenCalledWith('dev-org', mockConfig, expect.objectContaining({ backup: false }));
    expect(fs.writeJson).toHaveBeenCalledWith('/project/logs/monitor-latest.json', okSnapshot, { spaces: 2 });
  });

  it('passes --backup through to runMonitor', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'monitor', 'all', '--backup']);
    expect(runMonitor).toHaveBeenCalledWith('dev-org', mockConfig, expect.objectContaining({ backup: true }));
  });

  it('runs a single named check', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'monitor', 'limits']);
    expect(runMonitor).toHaveBeenCalledWith('dev-org', mockConfig, expect.objectContaining({ checks: ['limits'] }));
  });

  it('runs the backup subcommand via runBackup', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().parseAsync(['node', 'sfdt', 'monitor', 'backup', '--json']);
    expect(runBackup).toHaveBeenCalledWith('dev-org', mockConfig, expect.any(Object));
    writeSpy.mockRestore();
  });

  it('emits JSON to stdout AND persists the snapshot in --json mode', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().parseAsync(['node', 'sfdt', 'monitor', 'all', '--json']);
    // The snapshot must be written even in --json mode — the GUI/bridge read it.
    expect(fs.writeJson).toHaveBeenCalled();
    const out = writeSpy.mock.calls.map((c) => c[0]).join('');
    expect(JSON.parse(out)).toMatchObject({ status: 0, result: { org: 'dev-org' } });
    writeSpy.mockRestore();
  });

  it('sets a non-zero exit code when a check fails', async () => {
    runMonitor.mockResolvedValue({ ...okSnapshot, summary: { total: 1, ok: 0, warn: 0, fail: 1, error: 0 } });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'monitor', 'all']);
    expect(process.exitCode).toBe(1);
  });

  it('prints findings (and a truncation line) in the pretty report', async () => {
    const findings = Array.from({ length: 10 }, (_, i) => ({ message: `finding ${i}` }));
    runMonitor.mockResolvedValue({
      ...okSnapshot,
      checks: [{ id: 'errors', title: 'Apex errors', status: 'warn', summary: '10 errors', findings }],
      summary: { total: 1, ok: 0, warn: 1, fail: 0, error: 0 },
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'monitor', 'all']);
    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('Apex errors');
    expect(out).toContain('+2 more');
    logSpy.mockRestore();
  });

  it('warns on stderr but does not fail the run when the snapshot write fails', async () => {
    fs.writeJson.mockRejectedValue(new Error('EACCES'));
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'monitor', 'all']);
    expect(errSpy.mock.calls.map((c) => String(c[0])).join('')).toContain('could not write snapshot');
    expect(process.exitCode).toBeUndefined();
    errSpy.mockRestore();
  });

  it('reports a monitor failure as JSON when runMonitor throws', async () => {
    runMonitor.mockRejectedValue(new Error('org unreachable'));
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().parseAsync(['node', 'sfdt', 'monitor', 'all', '--json']);
    const out = writeSpy.mock.calls.map((c) => c[0]).join('');
    expect(JSON.parse(out)).toMatchObject({ status: 1, message: 'org unreachable' });
    writeSpy.mockRestore();
  });

  it('errors when no org is configured (pretty mode)', async () => {
    loadConfig.mockResolvedValue({ _projectRoot: '/project' });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'monitor', 'all']);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('No org specified'));
    expect(process.exitCode).toBe(1);
    errSpy.mockRestore();
  });
});

describe('monitor backup', () => {
  it('sets exit code 1 and shows the summary when the backup returns an error status', async () => {
    runBackup.mockResolvedValue({ id: 'backup', title: 'Metadata backup', status: 'error', summary: 'auth failed', findings: [] });
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().parseAsync(['node', 'sfdt', 'monitor', 'backup', '--json']);
    expect(process.exitCode).toBe(1);
    const out = writeSpy.mock.calls.map((c) => c[0]).join('');
    expect(JSON.parse(out)).toMatchObject({ status: 0, result: { status: 'error' } });
    writeSpy.mockRestore();
  });

  it('reports a thrown backup failure as JSON', async () => {
    runBackup.mockRejectedValue(new Error('retrieve crashed'));
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().parseAsync(['node', 'sfdt', 'monitor', 'backup', '--json']);
    const out = writeSpy.mock.calls.map((c) => c[0]).join('');
    expect(JSON.parse(out)).toMatchObject({ status: 1, message: 'retrieve crashed' });
    writeSpy.mockRestore();
  });

  it('reports a backup failure on stderr in pretty mode', async () => {
    runBackup.mockRejectedValue(new Error('retrieve crashed'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'monitor', 'backup']);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('retrieve crashed'));
    expect(process.exitCode).toBe(1);
    errSpy.mockRestore();
  });

  it('errors when no org is configured for backup', async () => {
    loadConfig.mockResolvedValue({ _projectRoot: '/project' });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'monitor', 'backup']);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('No org specified'));
    expect(process.exitCode).toBe(1);
    errSpy.mockRestore();
  });
});
