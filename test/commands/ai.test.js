import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../../src/lib/ai.js', () => ({
  isAiAvailable: vi.fn(),
  aiUnavailableMessage: vi.fn().mockReturnValue('AI is not available'),
  runAiPrompt: vi.fn(),
}));

vi.mock('../../src/lib/config.js', () => ({
  loadConfig: vi.fn(),
}));

vi.mock('../../src/lib/output.js', () => ({
  print: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
    header: vi.fn(),
    warning: vi.fn(),
    step: vi.fn(),
  },
}));

import { isAiAvailable, aiUnavailableMessage, runAiPrompt } from '../../src/lib/ai.js';
import { loadConfig } from '../../src/lib/config.js';
import { print } from '../../src/lib/output.js';
import { registerAiCommand } from '../../src/commands/ai.js';

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerAiCommand(program);
  return program;
}

beforeEach(() => {
  vi.resetAllMocks();
  process.exitCode = undefined;
  loadConfig.mockResolvedValue({ features: {} });
  aiUnavailableMessage.mockReturnValue('AI is not available');
});

describe('ai prompt command', () => {
  it('prints error and sets exitCode 1 when AI is not available', async () => {
    isAiAvailable.mockResolvedValue(false);

    await createProgram().parseAsync(['node', 'sfdt', 'ai', 'prompt', 'hello world']);

    expect(print.error).toHaveBeenCalledWith('AI is not available');
    expect(process.exitCode).toBe(1);
    expect(runAiPrompt).not.toHaveBeenCalled();
  });

  it('calls runAiPrompt with the text argument when AI is available', async () => {
    isAiAvailable.mockResolvedValue(true);
    runAiPrompt.mockResolvedValue({ exitCode: 0 });

    await createProgram().parseAsync(['node', 'sfdt', 'ai', 'prompt', 'explain this code']);

    expect(runAiPrompt).toHaveBeenCalledWith(
      'explain this code',
      expect.objectContaining({ aiEnabled: true, interactive: true }),
    );
    expect(process.exitCode).toBeUndefined();
  });

  it('sets exitCode 1 when runAiPrompt returns a non-zero exit code', async () => {
    isAiAvailable.mockResolvedValue(true);
    runAiPrompt.mockResolvedValue({ exitCode: 1 });

    await createProgram().parseAsync(['node', 'sfdt', 'ai', 'prompt', 'some text']);

    expect(process.exitCode).toBe(1);
  });

  it('sets exitCode 1 when runAiPrompt returns null', async () => {
    isAiAvailable.mockResolvedValue(true);
    runAiPrompt.mockResolvedValue(null);

    await createProgram().parseAsync(['node', 'sfdt', 'ai', 'prompt', 'some text']);

    expect(process.exitCode).toBe(1);
  });

  it('falls back to empty config when loadConfig throws', async () => {
    loadConfig.mockRejectedValue(new Error('no config found'));
    isAiAvailable.mockResolvedValue(false);

    await createProgram().parseAsync(['node', 'sfdt', 'ai', 'prompt', 'text']);

    // isAiAvailable is still called (with empty config {})
    expect(isAiAvailable).toHaveBeenCalledWith({});
    expect(print.error).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
