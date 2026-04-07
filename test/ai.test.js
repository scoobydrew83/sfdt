import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

import { execa } from 'execa';
import { isClaudeAvailable, runAiPrompt } from '../src/lib/ai.js';

beforeEach(() => {
  vi.resetAllMocks();
  // Reset the cached value between tests by re-importing would be complex,
  // so we test the cache behavior via sequential calls
});

// Because ai.js caches the result, we need to test it in isolation
// by using dynamic imports with cache busting. For simplicity, we test
// the runAiPrompt function which exercises the full flow.

describe('runAiPrompt', () => {
  it('returns null when aiEnabled is false', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await runAiPrompt('test prompt', { aiEnabled: false });

    expect(result).toBeNull();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('AI features are disabled'));
    consoleSpy.mockRestore();
  });

  it('passes prompt and allowed tools to claude CLI', async () => {
    // Mock claude --version check (isClaudeAvailable)
    execa.mockImplementation(async (cmd, args) => {
      if (args && args[0] === '--version') {
        return { exitCode: 0 };
      }
      return { exitCode: 0, stdout: 'review output', stderr: '' };
    });

    const result = await runAiPrompt('review this code', {
      allowedTools: ['Bash', 'Read'],
      cwd: '/project',
    });

    // Find the actual prompt call (not the --version call)
    const promptCall = execa.mock.calls.find((call) => call[1] && call[1].includes('-p'));

    expect(promptCall).toBeDefined();
    expect(promptCall[1]).toContain('-p');
    expect(promptCall[1]).toContain('review this code');
    expect(promptCall[1]).toContain('--allowedTools');
    expect(result.stdout).toBe('review output');
  });
});
