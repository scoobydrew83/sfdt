import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../../src/lib/config.js', () => ({
  loadConfig: vi.fn(),
}));

vi.mock('../../src/lib/script-runner.js', () => ({
  runScript: vi.fn(),
}));

vi.mock('../../src/lib/ai.js', () => ({
  isClaudeAvailable: vi.fn(),
  runAiPrompt: vi.fn(),
}));

vi.mock('inquirer', () => ({
  default: { prompt: vi.fn() },
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
import { isClaudeAvailable, runAiPrompt } from '../../src/lib/ai.js';
import inquirer from 'inquirer';
import { print } from '../../src/lib/output.js';
import { registerTestCommand } from '../../src/commands/test.js';

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerTestCommand(program);
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

describe('test command', () => {
  it('runs enhanced-test-runner.sh by default', async () => {
    runScript.mockResolvedValue({ exitCode: 0 });

    await createProgram().parseAsync(['node', 'sfdt', 'test']);

    expect(runScript).toHaveBeenCalledWith(
      'core/enhanced-test-runner.sh',
      expect.any(Object),
      expect.objectContaining({ cwd: '/project' })
    );
    expect(print.success).toHaveBeenCalled();
  });

  it('runs run-tests.sh with --legacy flag', async () => {
    runScript.mockResolvedValue({ exitCode: 0 });

    await createProgram().parseAsync(['node', 'sfdt', 'test', '--legacy']);

    expect(runScript).toHaveBeenCalledWith(
      'core/run-tests.sh',
      expect.any(Object),
      expect.any(Object)
    );
  });

  it('runs test-analyzer with --analyze flag', async () => {
    runScript.mockResolvedValue({ exitCode: 0 });

    await createProgram().parseAsync(['node', 'sfdt', 'test', '--analyze']);

    expect(runScript).toHaveBeenCalledTimes(2);
    expect(runScript).toHaveBeenCalledWith(
      'quality/test-analyzer.sh',
      expect.any(Object),
      expect.any(Object)
    );
  });

  it('offers AI analysis on test failure when AI enabled', async () => {
    runScript.mockRejectedValueOnce(new Error('tests failed'));
    isClaudeAvailable.mockResolvedValue(true);
    inquirer.prompt.mockResolvedValue({ analyzeFailure: true });
    runAiPrompt.mockResolvedValue({ stdout: 'analysis', exitCode: 0 });

    await createProgram().parseAsync(['node', 'sfdt', 'test']);

    expect(inquirer.prompt).toHaveBeenCalled();
    expect(runAiPrompt).toHaveBeenCalledWith(
      expect.stringContaining('Analyze the most recent Apex test failures'),
      expect.any(Object)
    );
    expect(process.exitCode).toBe(1);
  });

  it('skips AI analysis when user declines', async () => {
    runScript.mockRejectedValueOnce(new Error('tests failed'));
    isClaudeAvailable.mockResolvedValue(true);
    inquirer.prompt.mockResolvedValue({ analyzeFailure: false });

    await createProgram().parseAsync(['node', 'sfdt', 'test']);

    expect(runAiPrompt).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('skips AI prompt when AI is disabled', async () => {
    loadConfig.mockResolvedValue({
      _projectRoot: '/project',
      defaultOrg: 'dev',
      features: { ai: false },
    });
    runScript.mockRejectedValueOnce(new Error('tests failed'));

    await createProgram().parseAsync(['node', 'sfdt', 'test']);

    expect(inquirer.prompt).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
