import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../../src/lib/config.js', () => ({
  loadConfig: vi.fn(),
}));

vi.mock('../../src/lib/script-runner.js', () => ({
  runScript: vi.fn(),
}));

vi.mock('../../src/lib/ai.js', () => ({
  isAiAvailable: vi.fn(),
  runAiPrompt: vi.fn(),
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
import { isAiAvailable, runAiPrompt } from '../../src/lib/ai.js';
import { print } from '../../src/lib/output.js';
import { registerQualityCommand } from '../../src/commands/quality.js';

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerQualityCommand(program);
  return program;
}

beforeEach(() => {
  vi.resetAllMocks();
  process.exitCode = undefined;
  loadConfig.mockResolvedValue({
    _projectRoot: '/project',
    defaultOrg: 'dev',
    features: { ai: true },
  });
});

describe('quality command', () => {
  it('runs code-analyzer by default', async () => {
    runScript.mockResolvedValue({ exitCode: 0, stdout: 'ok' });

    await createProgram().parseAsync(['node', 'sfdt', 'quality']);

    expect(runScript).toHaveBeenCalledTimes(1);
    expect(runScript).toHaveBeenCalledWith(
      'quality/code-analyzer.sh',
      expect.any(Object),
      expect.objectContaining({ interactive: false }),
    );
  });

  it('runs only test-analyzer with --tests', async () => {
    runScript.mockResolvedValue({ exitCode: 0, stdout: 'ok' });

    await createProgram().parseAsync(['node', 'sfdt', 'quality', '--tests']);

    expect(runScript).toHaveBeenCalledTimes(1);
    expect(runScript).toHaveBeenCalledWith(
      'quality/test-analyzer.sh',
      expect.any(Object),
      expect.any(Object),
    );
  });

  it('runs both analyzers with --all', async () => {
    runScript.mockResolvedValue({ exitCode: 0, stdout: 'ok' });

    await createProgram().parseAsync(['node', 'sfdt', 'quality', '--all']);

    expect(runScript).toHaveBeenCalledTimes(2);
    expect(runScript).toHaveBeenCalledWith(
      'quality/code-analyzer.sh',
      expect.any(Object),
      expect.any(Object),
    );
    expect(runScript).toHaveBeenCalledWith(
      'quality/test-analyzer.sh',
      expect.any(Object),
      expect.any(Object),
    );
  });

  it('generates AI fix plan with --fix-plan', async () => {
    runScript.mockResolvedValue({ exitCode: 0, stdout: 'issues found' });
    isAiAvailable.mockResolvedValue(true);
    runAiPrompt.mockResolvedValue({ stdout: 'fix plan', exitCode: 0 });

    await createProgram().parseAsync(['node', 'sfdt', 'quality', '--fix-plan']);

    expect(runAiPrompt).toHaveBeenCalledWith(
      expect.stringContaining('quality report'),
      expect.objectContaining({ aiEnabled: true }),
    );
  });

  it('warns when AI unavailable for --fix-plan', async () => {
    runScript.mockResolvedValue({ exitCode: 0, stdout: '' });
    isAiAvailable.mockResolvedValue(false);

    await createProgram().parseAsync(['node', 'sfdt', 'quality', '--fix-plan']);

    expect(print.warning).toHaveBeenCalledWith(expect.stringContaining('not available'));
  });

  it('handles analyzer errors gracefully', async () => {
    const err = new Error('analyzer crashed');
    err.stdout = 'partial output';
    runScript.mockRejectedValue(err);

    await createProgram().parseAsync(['node', 'sfdt', 'quality']);

    expect(print.warning).toHaveBeenCalledWith(expect.stringContaining('found issues'));
  });

  it('--generate-stubs calls generate-test-stubs.sh', async () => {
    runScript.mockResolvedValue({ exitCode: 0, stdout: '' });

    await createProgram().parseAsync(['node', 'sfdt', 'quality', '--generate-stubs']);

    const stubCall = runScript.mock.calls.find((call) => call[0] === 'quality/generate-test-stubs.sh');
    expect(stubCall).toBeDefined();
    expect(stubCall[2].env).not.toMatchObject({ SFDT_DRY_RUN: 'true' });
  });

  it('--generate-stubs --dry-run passes SFDT_DRY_RUN: true', async () => {
    runScript.mockResolvedValue({ exitCode: 0, stdout: '' });

    await createProgram().parseAsync(['node', 'sfdt', 'quality', '--generate-stubs', '--dry-run']);

    const stubCall = runScript.mock.calls.find((call) => call[0] === 'quality/generate-test-stubs.sh');
    expect(stubCall).toBeDefined();
    expect(stubCall[2].env).toMatchObject({ SFDT_DRY_RUN: 'true' });
  });
});
