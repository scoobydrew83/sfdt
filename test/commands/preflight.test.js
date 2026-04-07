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
import { registerPreflightCommand } from '../../src/commands/preflight.js';

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerPreflightCommand(program);
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

describe('preflight command', () => {
  it('runs preflight.sh', async () => {
    runScript.mockResolvedValue({ exitCode: 0 });

    await createProgram().parseAsync(['node', 'sfdt', 'preflight']);

    expect(runScript).toHaveBeenCalledWith(
      'new/preflight.sh',
      expect.any(Object),
      expect.objectContaining({ cwd: '/project', env: {} }),
    );
    expect(print.success).toHaveBeenCalled();
  });

  it('sets SFDT_PREFLIGHT_STRICT with --strict', async () => {
    runScript.mockResolvedValue({ exitCode: 0 });

    await createProgram().parseAsync(['node', 'sfdt', 'preflight', '--strict']);

    expect(runScript).toHaveBeenCalledWith(
      'new/preflight.sh',
      expect.any(Object),
      expect.objectContaining({ env: { SFDT_PREFLIGHT_STRICT: 'true' } }),
    );
  });

  it('sets exitCode 1 on failure', async () => {
    runScript.mockRejectedValue(new Error('checks failed'));

    await createProgram().parseAsync(['node', 'sfdt', 'preflight']);

    expect(print.error).toHaveBeenCalledWith(expect.stringContaining('checks failed'));
    expect(process.exitCode).toBe(1);
  });
});
