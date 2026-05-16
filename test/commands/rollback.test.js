import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
vi.mock('../../src/lib/config.js', () => ({
  loadConfig: vi.fn(),
}));
vi.mock('../../src/lib/script-runner.js', () => ({
  runScript: vi.fn(),
}));
vi.mock('../../src/lib/output.js', () => ({
  print: {
    header: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    step: vi.fn(),
  },
}));
vi.mock('../../src/lib/log-writer.js', () => ({
  writeRawLog: vi.fn().mockResolvedValue({}),
}));
import { loadConfig } from '../../src/lib/config.js';
import { runScript } from '../../src/lib/script-runner.js';
import { print } from '../../src/lib/output.js';
import { writeRawLog } from '../../src/lib/log-writer.js';
import { registerRollbackCommand } from '../../src/commands/rollback.js';
function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerRollbackCommand(program);
  return program;
}
beforeEach(() => {
  vi.resetAllMocks();
  process.exitCode = undefined;
  loadConfig.mockResolvedValue({
    _projectRoot: '/project',
    defaultOrg: 'dev',
    features: {},
  });
  writeRawLog.mockResolvedValue({});
});
describe('rollback command', () => {
  it('uses defaultOrg when no --org flag', async () => {
    runScript.mockResolvedValue({ exitCode: 0 });
    await createProgram().parseAsync(['node', 'sfdt', 'rollback']);
    expect(runScript).toHaveBeenCalledWith(
      'ops/rollback.sh',
      expect.any(Object),
      expect.objectContaining({ env: expect.objectContaining({ SFDT_TARGET_ORG: 'dev' }) }),
    );
  });
  it('uses --org flag when provided', async () => {
    runScript.mockResolvedValue({ exitCode: 0 });
    await createProgram().parseAsync(['node', 'sfdt', 'rollback', '--org', 'staging']);
    expect(runScript).toHaveBeenCalledWith(
      'ops/rollback.sh',
      expect.any(Object),
      expect.objectContaining({ env: expect.objectContaining({ SFDT_TARGET_ORG: 'staging' }) }),
    );
  });
  it('passes SFDT_BACKUP_BEFORE_ROLLBACK: true by default', async () => {
    runScript.mockResolvedValue({ exitCode: 0, stdout: '' });
    await createProgram().parseAsync(['node', 'sfdt', 'rollback']);
    expect(runScript).toHaveBeenCalledWith(
      'ops/rollback.sh',
      expect.any(Object),
      expect.objectContaining({
        env: expect.objectContaining({ SFDT_BACKUP_BEFORE_ROLLBACK: 'true' }),
      }),
    );
  });
  it('passes SFDT_BACKUP_BEFORE_ROLLBACK: false when config disables it', async () => {
    loadConfig.mockResolvedValue({
      _projectRoot: '/project',
      defaultOrg: 'dev',
      features: {},
      deployment: { backupBeforeRollback: false },
    });
    runScript.mockResolvedValue({ exitCode: 0, stdout: '' });
    await createProgram().parseAsync(['node', 'sfdt', 'rollback']);
    expect(runScript).toHaveBeenCalledWith(
      'ops/rollback.sh',
      expect.any(Object),
      expect.objectContaining({
        env: expect.objectContaining({ SFDT_BACKUP_BEFORE_ROLLBACK: 'false' }),
      }),
    );
  });
  it('sets exitCode 1 on failure', async () => {
    runScript.mockRejectedValue(new Error('rollback failed'));
    await createProgram().parseAsync(['node', 'sfdt', 'rollback']);
    expect(print.error).toHaveBeenCalledWith(expect.stringContaining('rollback failed'));
    expect(process.exitCode).toBe(1);
  });
  describe('--json flag', () => {
    it('suppresses print calls when --json is active', async () => {
      runScript.mockResolvedValue({ exitCode: 0, stdout: 'Rollback complete.' });
      await createProgram().parseAsync(['node', 'sfdt', 'rollback', '--json']);
      expect(print.header).not.toHaveBeenCalled();
      expect(print.success).not.toHaveBeenCalled();
    });
    it('writes JSON envelope with stdout to process.stdout', async () => {
      runScript.mockResolvedValue({ exitCode: 0, stdout: 'Rollback complete.\nDone.' });
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      await createProgram().parseAsync(['node', 'sfdt', 'rollback', '--org', 'prod', '--json']);
      expect(runScript).toHaveBeenCalledWith(
        'ops/rollback.sh',
        expect.any(Object),
        expect.objectContaining({ captureStdout: true }),
      );
      const written = writeSpy.mock.calls.map((c) => c[0]).join('');
      const parsed = JSON.parse(written);
      expect(parsed).toMatchObject({
        status: 'success',
        org: 'prod',
        exitCode: 0,
        log: 'Rollback complete.\nDone.',
      });
      expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      writeSpy.mockRestore();
    });
    it('emits error JSON and sets exitCode on script failure with --json', async () => {
      const err = new Error('rollback failed');
      err.exitCode = 1;
      runScript.mockRejectedValue(err);
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      await createProgram().parseAsync(['node', 'sfdt', 'rollback', '--json']);
      expect(process.exitCode).toBe(1);
      const written = writeSpy.mock.calls.map((c) => c[0]).join('');
      expect(JSON.parse(written)).toMatchObject({ status: 'error', message: 'rollback failed' });
      writeSpy.mockRestore();
    });
  });
});
