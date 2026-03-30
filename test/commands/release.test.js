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
import { registerReleaseCommand } from '../../src/commands/release.js';

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerReleaseCommand(program);
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

describe('release command', () => {
  it('runs generate-release-manifest.sh', async () => {
    runScript.mockResolvedValue({ exitCode: 0 });
    isClaudeAvailable.mockResolvedValue(false);

    await createProgram().parseAsync(['node', 'sfdt', 'release']);

    expect(runScript).toHaveBeenCalledWith(
      'core/generate-release-manifest.sh',
      expect.any(Object),
      expect.objectContaining({ args: [], cwd: '/project' })
    );
  });

  it('passes version argument to script', async () => {
    runScript.mockResolvedValue({ exitCode: 0 });
    isClaudeAvailable.mockResolvedValue(false);

    await createProgram().parseAsync(['node', 'sfdt', 'release', '2.0.0']);

    expect(runScript).toHaveBeenCalledWith(
      'core/generate-release-manifest.sh',
      expect.any(Object),
      expect.objectContaining({ args: ['2.0.0'] })
    );
  });

  it('offers AI release notes when AI available', async () => {
    runScript.mockResolvedValue({ exitCode: 0 });
    isClaudeAvailable.mockResolvedValue(true);
    inquirer.prompt.mockResolvedValue({ generateNotes: true });
    runAiPrompt.mockResolvedValue({ stdout: 'notes', exitCode: 0 });

    await createProgram().parseAsync(['node', 'sfdt', 'release', '1.0.0']);

    expect(inquirer.prompt).toHaveBeenCalled();
    expect(runAiPrompt).toHaveBeenCalledWith(
      expect.stringContaining('release notes'),
      expect.objectContaining({ aiEnabled: true, interactive: true })
    );
  });

  it('skips AI notes when user declines', async () => {
    runScript.mockResolvedValue({ exitCode: 0 });
    isClaudeAvailable.mockResolvedValue(true);
    inquirer.prompt.mockResolvedValue({ generateNotes: false });

    await createProgram().parseAsync(['node', 'sfdt', 'release']);

    expect(runAiPrompt).not.toHaveBeenCalled();
  });

  it('sets exitCode 1 on failure', async () => {
    runScript.mockRejectedValue(new Error('release failed'));

    await createProgram().parseAsync(['node', 'sfdt', 'release']);

    expect(print.error).toHaveBeenCalledWith(expect.stringContaining('release failed'));
    expect(process.exitCode).toBe(1);
  });
});
