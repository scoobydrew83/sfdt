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
import { registerDriftCommand } from '../../src/commands/drift.js';

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerDriftCommand(program);
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

describe('drift command', () => {
  it('uses defaultOrg when no --org flag', async () => {
    runScript.mockResolvedValue({ exitCode: 0 });

    await createProgram().parseAsync(['node', 'sfdt', 'drift']);

    expect(runScript).toHaveBeenCalledWith(
      'new/drift.sh',
      expect.any(Object),
      expect.objectContaining({ env: { SFDT_TARGET_ORG: 'dev' } })
    );
  });

  it('uses --org flag when provided', async () => {
    runScript.mockResolvedValue({ exitCode: 0 });

    await createProgram().parseAsync(['node', 'sfdt', 'drift', '--org', 'prod']);

    expect(runScript).toHaveBeenCalledWith(
      'new/drift.sh',
      expect.any(Object),
      expect.objectContaining({ env: { SFDT_TARGET_ORG: 'prod' } })
    );
  });

  it('sets exitCode 1 on failure', async () => {
    runScript.mockRejectedValue(new Error('drift failed'));

    await createProgram().parseAsync(['node', 'sfdt', 'drift']);

    expect(print.error).toHaveBeenCalledWith(expect.stringContaining('drift failed'));
    expect(process.exitCode).toBe(1);
  });
});
