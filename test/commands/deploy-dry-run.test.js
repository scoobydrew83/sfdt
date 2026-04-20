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

describe('deploy --dry-run', () => {
  it('passes dryRun: true to runScript', async () => {
    runScript.mockResolvedValue({ exitCode: 0 });

    await createProgram().parseAsync(['node', 'sfdt', 'deploy', '--dry-run', '--skip-preflight']);

    expect(runScript).toHaveBeenCalledWith(
      'core/deployment-assistant.sh',
      expect.any(Object),
      expect.objectContaining({ dryRun: true }),
    );
  });

  it('prints dry-run complete success message', async () => {
    runScript.mockResolvedValue({ exitCode: 0 });

    await createProgram().parseAsync(['node', 'sfdt', 'deploy', '--dry-run', '--skip-preflight']);

    expect(print.success).toHaveBeenCalledWith(expect.stringContaining('Dry-run complete'));
  });

  it('passes dryRun: true to preflight runScript call too', async () => {
    runScript.mockResolvedValue({ exitCode: 0 });

    await createProgram().parseAsync(['node', 'sfdt', 'deploy', '--dry-run']);

    expect(runScript).toHaveBeenCalledTimes(2);
    expect(runScript.mock.calls[0][2]).toMatchObject({ dryRun: true });
    expect(runScript.mock.calls[1][2]).toMatchObject({ dryRun: true });
  });

  it('without --dry-run passes dryRun: false (or undefined)', async () => {
    runScript.mockResolvedValue({ exitCode: 0 });

    await createProgram().parseAsync(['node', 'sfdt', 'deploy', '--skip-preflight']);

    expect(runScript).toHaveBeenCalledWith(
      'core/deployment-assistant.sh',
      expect.any(Object),
      expect.not.objectContaining({ dryRun: true }),
    );
  });
});
