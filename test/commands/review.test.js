import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

vi.mock('../../src/lib/config.js', () => ({
  loadConfig: vi.fn(),
}));

vi.mock('../../src/lib/ai.js', () => ({
  isClaudeAvailable: vi.fn(),
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

import { execa } from 'execa';
import { loadConfig } from '../../src/lib/config.js';
import { isClaudeAvailable, runAiPrompt } from '../../src/lib/ai.js';
import { print } from '../../src/lib/output.js';
import { registerReviewCommand } from '../../src/commands/review.js';

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerReviewCommand(program);
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

describe('review command', () => {
  it('errors when AI features disabled', async () => {
    loadConfig.mockResolvedValue({
      _projectRoot: '/project',
      features: { ai: false },
    });

    await createProgram().parseAsync(['node', 'sfdt', 'review']);

    expect(print.error).toHaveBeenCalledWith(expect.stringContaining('AI features are disabled'));
    expect(process.exitCode).toBe(1);
  });

  it('errors when Claude CLI not available', async () => {
    isClaudeAvailable.mockResolvedValue(false);

    await createProgram().parseAsync(['node', 'sfdt', 'review']);

    expect(print.error).toHaveBeenCalledWith(
      expect.stringContaining('Claude CLI is not installed'),
    );
    expect(process.exitCode).toBe(1);
  });

  it('warns when no diff found', async () => {
    isClaudeAvailable.mockResolvedValue(true);
    execa.mockResolvedValue({ stdout: '', stderr: '' });

    await createProgram().parseAsync(['node', 'sfdt', 'review']);

    expect(print.warning).toHaveBeenCalledWith(expect.stringContaining('No changes found'));
  });

  it('sends diff to AI for review', async () => {
    isClaudeAvailable.mockResolvedValue(true);
    execa.mockResolvedValue({ stdout: '+ added line\n- removed line', stderr: '' });
    runAiPrompt.mockResolvedValue({ stdout: 'review', exitCode: 0 });

    await createProgram().parseAsync(['node', 'sfdt', 'review']);

    expect(execa).toHaveBeenCalledWith(
      'git',
      ['diff', 'main...HEAD'],
      expect.objectContaining({ cwd: '/project' }),
    );
    expect(runAiPrompt).toHaveBeenCalledWith(
      expect.stringContaining('+ added line'),
      expect.objectContaining({ interactive: true }),
    );
  });

  it('uses custom base branch with --base', async () => {
    isClaudeAvailable.mockResolvedValue(true);
    execa.mockResolvedValue({ stdout: 'diff content', stderr: '' });
    runAiPrompt.mockResolvedValue({ stdout: '', exitCode: 0 });

    await createProgram().parseAsync(['node', 'sfdt', 'review', '--base', 'develop']);

    expect(execa).toHaveBeenCalledWith('git', ['diff', 'develop...HEAD'], expect.any(Object));
  });

  it('sets exitCode 1 on failure', async () => {
    isClaudeAvailable.mockResolvedValue(true);
    execa.mockRejectedValue(new Error('git error'));

    await createProgram().parseAsync(['node', 'sfdt', 'review']);

    expect(print.error).toHaveBeenCalledWith(expect.stringContaining('git error'));
    expect(process.exitCode).toBe(1);
  });
});
