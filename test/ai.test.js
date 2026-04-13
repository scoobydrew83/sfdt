import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

import { execa } from 'execa';
import {
  isClaudeAvailable,
  isAiAvailable,
  getConfiguredProvider,
  aiUnavailableMessage,
  runAiPrompt,
} from '../src/lib/ai.js';

beforeEach(() => {
  vi.resetAllMocks();
});

// ─── getConfiguredProvider ────────────────────────────────────────────────────

describe('getConfiguredProvider', () => {
  it('defaults to claude when config has no ai section', () => {
    expect(getConfiguredProvider({})).toBe('claude');
    expect(getConfiguredProvider(null)).toBe('claude');
    expect(getConfiguredProvider(undefined)).toBe('claude');
  });

  it('returns the configured provider', () => {
    expect(getConfiguredProvider({ ai: { provider: 'gemini' } })).toBe('gemini');
    expect(getConfiguredProvider({ ai: { provider: 'openai' } })).toBe('openai');
    expect(getConfiguredProvider({ ai: { provider: 'claude' } })).toBe('claude');
  });
});

// ─── aiUnavailableMessage ─────────────────────────────────────────────────────

describe('aiUnavailableMessage', () => {
  it('returns Claude install instructions for claude provider', () => {
    const msg = aiUnavailableMessage({ ai: { provider: 'claude' } });
    expect(msg).toMatch(/Claude/i);
  });

  it('returns Gemini key instructions for gemini provider', () => {
    const msg = aiUnavailableMessage({ ai: { provider: 'gemini' } });
    expect(msg).toMatch(/GEMINI_API_KEY/);
  });

  it('returns OpenAI key instructions for openai provider', () => {
    const msg = aiUnavailableMessage({ ai: { provider: 'openai' } });
    expect(msg).toMatch(/OPENAI_API_KEY/);
  });
});

// ─── isAiAvailable ────────────────────────────────────────────────────────────

describe('isAiAvailable', () => {
  it('returns false when features.ai is false', async () => {
    const result = await isAiAvailable({ features: { ai: false } });
    expect(result).toBe(false);
  });

  it('checks Claude CLI for claude provider', async () => {
    execa.mockResolvedValue({ exitCode: 0 });
    const result = await isAiAvailable({ features: { ai: true }, ai: { provider: 'claude' } });
    expect(result).toBe(true);
    expect(execa).toHaveBeenCalledWith('claude', ['--version'], expect.any(Object));
  });

  it('returns true for gemini when API key is in config', async () => {
    const result = await isAiAvailable({
      features: { ai: true },
      ai: { provider: 'gemini', apiKey: 'test-key' },
    });
    expect(result).toBe(true);
  });

  it('returns false for gemini when no API key available', async () => {
    const origKey = process.env.GEMINI_API_KEY;
    const origKey2 = process.env.GOOGLE_AI_API_KEY;
    const origKey3 = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_AI_API_KEY;
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;

    const result = await isAiAvailable({
      features: { ai: true },
      ai: { provider: 'gemini', apiKey: '' },
    });
    expect(result).toBe(false);

    if (origKey) process.env.GEMINI_API_KEY = origKey;
    if (origKey2) process.env.GOOGLE_AI_API_KEY = origKey2;
    if (origKey3) process.env.GOOGLE_GENERATIVE_AI_API_KEY = origKey3;
  });

  it('returns true for openai when API key is in config', async () => {
    const result = await isAiAvailable({
      features: { ai: true },
      ai: { provider: 'openai', apiKey: 'sk-test-key' },
    });
    expect(result).toBe(true);
  });
});

// ─── runAiPrompt ─────────────────────────────────────────────────────────────

describe('runAiPrompt', () => {
  it('returns null when aiEnabled is false', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await runAiPrompt('test prompt', { aiEnabled: false });

    expect(result).toBeNull();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('AI features are disabled'));
    consoleSpy.mockRestore();
  });

  it('routes to claude by default and passes prompt + tools to CLI', async () => {
    execa.mockImplementation(async (_cmd, args) => {
      if (args[0] === '--version') return { exitCode: 0 };
      return { exitCode: 0, stdout: 'review output', stderr: '' };
    });

    const result = await runAiPrompt('review this code', {
      allowedTools: ['Bash', 'Read'],
      cwd: '/project',
    });

    const promptCall = execa.mock.calls.find((call) => call[1]?.includes('-p'));
    expect(promptCall).toBeDefined();
    expect(promptCall[1]).toContain('-p');
    expect(promptCall[1]).toContain('review this code');
    expect(promptCall[1]).toContain('--allowedTools');
    expect(result.stdout).toBe('review output');
  });

  it('routes to claude when config.ai.provider is claude', async () => {
    execa.mockImplementation(async (_cmd, args) => {
      if (args[0] === '--version') return { exitCode: 0 };
      return { exitCode: 0, stdout: 'claude out', stderr: '' };
    });

    const result = await runAiPrompt('hello', {
      config: { ai: { provider: 'claude' } },
    });

    const promptCall = execa.mock.calls.find((call) => call[1]?.includes('-p'));
    expect(promptCall).toBeDefined();
    expect(result.stdout).toBe('claude out');
  });
});
