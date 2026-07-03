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
import { registerSmokeCommand } from '../../src/commands/smoke.js';

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerSmokeCommand(program);
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

describe('smoke command', () => {
  it('uses defaultOrg when no --org flag', async () => {
    runScript.mockResolvedValue({ exitCode: 0 });

    await createProgram().parseAsync(['node', 'sfdt', 'smoke']);

    expect(runScript).toHaveBeenCalledWith(
      'ops/smoke.sh',
      expect.any(Object),
      expect.objectContaining({ env: { SFDT_TARGET_ORG: 'dev' } }),
    );
  });

  it('uses --org flag when provided', async () => {
    runScript.mockResolvedValue({ exitCode: 0 });

    await createProgram().parseAsync(['node', 'sfdt', 'smoke', '--org', 'uat']);

    expect(runScript).toHaveBeenCalledWith(
      'ops/smoke.sh',
      expect.any(Object),
      expect.objectContaining({ env: { SFDT_TARGET_ORG: 'uat' } }),
    );
  });

  it('passes SFDT_SMOKE_TESTS when smokeTests.testClasses is configured', async () => {
    runScript.mockResolvedValue({ exitCode: 0 });
    loadConfig.mockResolvedValue({
      _projectRoot: '/project',
      defaultOrg: 'dev',
      features: {},
      smokeTests: { testClasses: ['SmokeA_Test', 'SmokeB_Test'] },
    });

    await createProgram().parseAsync(['node', 'sfdt', 'smoke']);

    expect(runScript).toHaveBeenCalledWith(
      'ops/smoke.sh',
      expect.any(Object),
      expect.objectContaining({
        env: expect.objectContaining({
          SFDT_TARGET_ORG: 'dev',
          SFDT_SMOKE_TESTS: 'SmokeA_Test,SmokeB_Test',
        }),
      }),
    );
  });

  it('does not set SFDT_SMOKE_TESTS when smokeTests.testClasses is empty or absent', async () => {
    runScript.mockResolvedValue({ exitCode: 0 });
    loadConfig.mockResolvedValue({
      _projectRoot: '/project',
      defaultOrg: 'dev',
      features: {},
      smokeTests: { testClasses: [] },
    });

    await createProgram().parseAsync(['node', 'sfdt', 'smoke']);

    const env = runScript.mock.calls[0][2].env;
    expect(env).not.toHaveProperty('SFDT_SMOKE_TESTS');
  });

  it('sets exitCode 1 on failure', async () => {
    runScript.mockRejectedValue(new Error('smoke failed'));

    await createProgram().parseAsync(['node', 'sfdt', 'smoke']);

    expect(print.error).toHaveBeenCalledWith(expect.stringContaining('smoke failed'));
    expect(process.exitCode).toBe(1);
  });
});
