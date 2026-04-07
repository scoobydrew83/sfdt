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

import { loadConfig } from '../../src/lib/config.js';
import { runScript } from '../../src/lib/script-runner.js';
import { print } from '../../src/lib/output.js';
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
});

describe('rollback command', () => {
  it('uses defaultOrg when no --org flag', async () => {
    runScript.mockResolvedValue({ exitCode: 0 });

    await createProgram().parseAsync(['node', 'sfdt', 'rollback']);

    expect(runScript).toHaveBeenCalledWith(
      'new/rollback.sh',
      expect.any(Object),
      expect.objectContaining({ env: expect.objectContaining({ SFDT_TARGET_ORG: 'dev' }) }),
    );
  });

  it('uses --org flag when provided', async () => {
    runScript.mockResolvedValue({ exitCode: 0 });

    await createProgram().parseAsync(['node', 'sfdt', 'rollback', '--org', 'staging']);

    expect(runScript).toHaveBeenCalledWith(
      'new/rollback.sh',
      expect.any(Object),
      expect.objectContaining({ env: expect.objectContaining({ SFDT_TARGET_ORG: 'staging' }) }),
    );
  });

  it('passes SFDT_BACKUP_BEFORE_ROLLBACK: true by default', async () => {
    runScript.mockResolvedValue({ exitCode: 0, stdout: '' });

    await createProgram().parseAsync(['node', 'sfdt', 'rollback']);

    expect(runScript).toHaveBeenCalledWith(
      'new/rollback.sh',
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
      'new/rollback.sh',
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
});
