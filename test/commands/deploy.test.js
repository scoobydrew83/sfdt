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
import { registerDeployCommand } from '../../src/commands/deploy.js';

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerDeployCommand(program);
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

describe('deploy command', () => {
  it('runs deployment-assistant.sh by default', async () => {
    runScript.mockResolvedValue({ exitCode: 0 });

    await createProgram().parseAsync(['node', 'sfdt', 'deploy', '--skip-preflight']);

    expect(runScript).toHaveBeenCalledWith(
      'core/deployment-assistant.sh',
      expect.any(Object),
      expect.objectContaining({ cwd: '/project' }),
    );
    expect(print.success).toHaveBeenCalled();
  });

  it('runs deploy-manager.sh with --managed flag', async () => {
    runScript.mockResolvedValue({ exitCode: 0 });

    await createProgram().parseAsync(['node', 'sfdt', 'deploy', '--managed', '--skip-preflight']);

    expect(runScript).toHaveBeenCalledWith(
      'core/deploy-manager.sh',
      expect.any(Object),
      expect.objectContaining({ cwd: '/project' }),
    );
  });

  it('sets exitCode 1 on failure', async () => {
    runScript.mockRejectedValue(new Error('deploy failed'));

    await createProgram().parseAsync(['node', 'sfdt', 'deploy', '--skip-preflight']);

    expect(print.error).toHaveBeenCalledWith(expect.stringContaining('deploy failed'));
    expect(process.exitCode).toBe(1);
  });

  it('runs preflight.sh before the deploy script by default', async () => {
    runScript.mockResolvedValue({ exitCode: 0, stdout: '' });

    await createProgram().parseAsync(['node', 'sfdt', 'deploy']);

    expect(runScript).toHaveBeenCalledTimes(2);
    expect(runScript.mock.calls[0][0]).toBe('new/preflight.sh');
    expect(runScript.mock.calls[1][0]).toBe('core/deployment-assistant.sh');
  });

  it('skips preflight with --skip-preflight flag', async () => {
    runScript.mockResolvedValue({ exitCode: 0, stdout: '' });

    await createProgram().parseAsync(['node', 'sfdt', 'deploy', '--skip-preflight']);

    expect(runScript).toHaveBeenCalledTimes(1);
    expect(runScript.mock.calls[0][0]).toBe('core/deployment-assistant.sh');
  });

  it('aborts deploy and exits 1 when preflight fails', async () => {
    runScript.mockRejectedValueOnce(new Error('preflight check failed'));

    await createProgram().parseAsync(['node', 'sfdt', 'deploy']);

    expect(runScript).toHaveBeenCalledTimes(1);
    expect(runScript.mock.calls[0][0]).toBe('new/preflight.sh');
    expect(print.error).toHaveBeenCalledWith(expect.stringContaining('Preflight failed'));
    expect(process.exitCode).toBe(1);
  });
});
