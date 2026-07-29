import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

// `apex run` falls back to stdin when --file is absent; pin isTTY and restore
// it so the mutation can't leak into other test files sharing the worker.
const ORIGINAL_IS_TTY = process.stdin.isTTY;
afterEach(() => {
  process.stdin.isTTY = ORIGINAL_IS_TTY;
});

vi.mock('../../src/lib/config.js', () => ({ loadConfig: vi.fn() }));
vi.mock('../../src/lib/apex-runner.js', () => ({
  startTrace: vi.fn(),
  stopTrace: vi.fn(),
  listTraceFlags: vi.fn(),
  listLogs: vi.fn(),
  getLog: vi.fn(),
  watchLogs: vi.fn(),
  runAnonymous: vi.fn(),
  DEFAULT_DEBUG_LEVEL: 'SFDT_Trace',
}));
vi.mock('../../src/lib/exit-codes.js', () => ({ resolveExitCode: vi.fn(() => 1) }));
vi.mock('ora', () => ({
  default: vi.fn(() => ({ start: vi.fn().mockReturnThis(), succeed: vi.fn().mockReturnThis(), fail: vi.fn().mockReturnThis() })),
}));

import { loadConfig } from '../../src/lib/config.js';
import {
  startTrace,
  stopTrace,
  listTraceFlags,
  listLogs,
  getLog,
  watchLogs,
  runAnonymous,
} from '../../src/lib/apex-runner.js';
import { registerApexCommand } from '../../src/commands/apex.js';

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerApexCommand(program);
  return program;
}

async function runJson(argv) {
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  await createProgram().parseAsync(['node', 'sfdt', ...argv]);
  const out = writeSpy.mock.calls.map((c) => c[0]).join('');
  writeSpy.mockRestore();
  return JSON.parse(out);
}

beforeEach(() => {
  vi.resetAllMocks();
  process.exitCode = undefined;
  loadConfig.mockResolvedValue({ _projectRoot: '/p', defaultOrg: 'dev' });
  startTrace.mockResolvedValue({ org: 'dev', user: 'admin@example.com', traceFlagId: '7tf1', debugLevel: 'SFDT_Trace', debugLevelCreated: false, expirationDate: 'x' });
  stopTrace.mockResolvedValue({ org: 'dev', user: 'admin@example.com', deleted: 1, ids: ['7tf1'] });
  listTraceFlags.mockResolvedValue({ org: 'dev', traceFlags: [] });
  listLogs.mockResolvedValue({ org: 'dev', total: 1, logs: [{ id: 'L1', startTime: 't', status: 'Success', operation: 'Api', user: 'Ada', lengthBytes: 9 }] });
  getLog.mockResolvedValue({ org: 'dev', id: 'L1', lengthBytes: 4, log: 'BODY', outputFile: null });
  watchLogs.mockResolvedValue({ org: 'dev', watchedMs: 1000, newLogs: 0, logs: [] });
  runAnonymous.mockResolvedValue({ org: 'dev', success: true, compiled: true, logs: 'LOG' });
});

describe('apex trace', () => {
  it('starts a trace with defaults (60 min, sfdt debug level)', async () => {
    const out = await runJson(['apex', 'trace', 'start', '--json']);
    expect(startTrace).toHaveBeenCalledWith('dev', { user: undefined, durationMinutes: 60, debugLevel: 'SFDT_Trace' });
    expect(out).toMatchObject({ status: 0, result: { traceFlagId: '7tf1' } });
  });

  it('passes --user, --duration, --level and --org through', async () => {
    await runJson(['apex', 'trace', 'start', '--org', 'qa', '--user', 'u@x.com', '--duration', '30', '--level', 'SFDC_DevConsole', '--json']);
    expect(startTrace).toHaveBeenCalledWith('qa', { user: 'u@x.com', durationMinutes: 30, debugLevel: 'SFDC_DevConsole' });
  });

  it('lists trace flags', async () => {
    const out = await runJson(['apex', 'trace', 'list', '--json']);
    expect(listTraceFlags).toHaveBeenCalledWith('dev');
    expect(out).toMatchObject({ status: 0, result: { traceFlags: [] } });
  });

  it('stops trace flags with --all', async () => {
    await runJson(['apex', 'trace', 'stop', '--all', '--json']);
    expect(stopTrace).toHaveBeenCalledWith('dev', { user: undefined, all: true });
  });

  it('errors as JSON when no org is configured', async () => {
    loadConfig.mockResolvedValue({ _projectRoot: '/p' });
    const out = await runJson(['apex', 'trace', 'list', '--json']);
    expect(out).toMatchObject({ status: 1, message: expect.stringMatching(/--org/) });
  });

  it('reports a runner failure on stderr in pretty mode', async () => {
    listTraceFlags.mockRejectedValue(new Error('org unreachable'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'apex', 'trace', 'list']);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('org unreachable'));
    expect(process.exitCode).toBe(1);
    errSpy.mockRestore();
  });
});

describe('apex logs', () => {
  it('lists logs with limit and user filters', async () => {
    await runJson(['apex', 'logs', 'list', '--limit', '5', '--user', 'Ada', '--json']);
    expect(listLogs).toHaveBeenCalledWith('dev', { limit: 5, user: 'Ada' });
  });

  it('gets one log by id and honours --output', async () => {
    await runJson(['apex', 'logs', 'get', 'L1', '--output', '/tmp/x.log', '--json']);
    expect(getLog).toHaveBeenCalledWith('dev', 'L1', { outputFile: '/tmp/x.log' });
  });

  it('prints the raw log body in pretty mode', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'apex', 'logs', 'get', 'L1']);
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('BODY');
    logSpy.mockRestore();
  });

  it('watches with bounded defaults (5s interval, 300s duration)', async () => {
    await runJson(['apex', 'logs', 'watch', '--json']);
    expect(watchLogs).toHaveBeenCalledWith(
      'dev',
      expect.objectContaining({ intervalMs: 5000, durationMs: 300_000, maxLogs: Infinity, fetchBody: true }),
    );
  });

  it('passes watch bounds through (--interval/--duration/--max/--no-body)', async () => {
    await runJson(['apex', 'logs', 'watch', '--interval', '2', '--duration', '10', '--max', '3', '--no-body', '--json']);
    expect(watchLogs).toHaveBeenCalledWith(
      'dev',
      expect.objectContaining({ intervalMs: 2000, durationMs: 10_000, maxLogs: 3, fetchBody: false }),
    );
  });
});

describe('apex run', () => {
  it('runs a file and emits the diagnostics envelope', async () => {
    const out = await runJson(['apex', 'run', '--file', 'scripts/x.apex', '--json']);
    expect(runAnonymous).toHaveBeenCalledWith('dev', { file: 'scripts/x.apex', code: undefined });
    expect(out).toMatchObject({ status: 0, result: { success: true } });
    expect(process.exitCode).toBeUndefined();
  });

  it('sets a non-zero exit code when the Apex failed', async () => {
    runAnonymous.mockResolvedValue({ org: 'dev', success: false, compiled: false, compileProblem: 'bad', line: 1, column: 2 });
    const out = await runJson(['apex', 'run', '--file', 'scripts/x.apex', '--json']);
    expect(out).toMatchObject({ status: 0, result: { success: false } });
    expect(process.exitCode).toBe(1);
  });

  it('refuses to run without --file on an interactive TTY', async () => {
    process.stdin.isTTY = true;
    const out = await runJson(['apex', 'run', '--json']);
    expect(runAnonymous).not.toHaveBeenCalled();
    expect(out).toMatchObject({ status: 1, message: expect.stringMatching(/--file|stdin/) });
  });

  it('reports runtime failure details in pretty mode', async () => {
    runAnonymous.mockResolvedValue({ org: 'dev', success: false, compiled: true, exceptionMessage: 'System.NullPointerException', exceptionStackTrace: 'line 1' });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'apex', 'run', '--file', 'x.apex']);
    expect(errSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('System.NullPointerException');
    expect(process.exitCode).toBe(1);
    errSpy.mockRestore();
  });
});
