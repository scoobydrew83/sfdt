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
import { registerPullCommand } from '../../src/commands/pull.js';

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerPullCommand(program);
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

describe('pull command', () => {
  it('runs pull-org-updates.sh', async () => {
    runScript.mockResolvedValue({ exitCode: 0 });

    await createProgram().parseAsync(['node', 'sfdt', 'pull']);

    expect(runScript).toHaveBeenCalledWith(
      'core/pull-org-updates.sh',
      expect.any(Object),
      expect.objectContaining({ cwd: '/project' }),
    );
    expect(print.success).toHaveBeenCalled();
  });

  it('sets exitCode 1 on failure', async () => {
    runScript.mockRejectedValue(new Error('pull failed'));

    await createProgram().parseAsync(['node', 'sfdt', 'pull']);

    expect(print.error).toHaveBeenCalledWith(expect.stringContaining('pull failed'));
    expect(process.exitCode).toBe(1);
  });
});
