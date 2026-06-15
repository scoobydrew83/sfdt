import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

import { execa } from 'execa';
import {
  getConfiguredProvider,
  isAiAvailable,
  aiUnavailableMessage,
  runAiPrompt,
  streamAiResponse,
} from '../../src/lib/ai.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides = {}) {
  return {
    features: { ai: true },
    ai: { provider: 'claude' },
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// getConfiguredProvider
// ---------------------------------------------------------------------------

describe('getConfiguredProvider', () => {
  it('returns "claude" when config is undefined', () => {
    expect(getConfiguredProvider(undefined)).toBe('claude');
  });

  it('returns "claude" when config.ai is not set', () => {
    expect(getConfiguredProvider({})).toBe('claude');
  });

  it('returns "claude" when config.ai.provider is not set', () => {
    expect(getConfiguredProvider({ ai: {} })).toBe('claude');
  });

  it('returns the configured provider when set to gemini', () => {
    expect(getConfiguredProvider({ ai: { provider: 'gemini' } })).toBe('gemini');
  });

  it('returns the configured provider when set to openai', () => {
    expect(getConfiguredProvider({ ai: { provider: 'openai' } })).toBe('openai');
  });

  it('returns the configured provider for arbitrary values', () => {
    expect(getConfiguredProvider({ ai: { provider: 'myai' } })).toBe('myai');
  });
});

// ---------------------------------------------------------------------------
// aiUnavailableMessage
// ---------------------------------------------------------------------------

describe('aiUnavailableMessage', () => {
  it('returns claude install message when provider is claude', () => {
    const msg = aiUnavailableMessage({ ai: { provider: 'claude' } });
    expect(msg).toContain('Claude CLI');
    expect(msg).toContain('docs.anthropic.com');
  });

  it('returns claude install message when no provider configured (fallback)', () => {
    const msg = aiUnavailableMessage({});
    expect(msg).toContain('Claude CLI');
  });

  it('returns gemini install message when provider is gemini', () => {
    const msg = aiUnavailableMessage({ ai: { provider: 'gemini' } });
    expect(msg).toContain('Gemini CLI');
  });

  it('returns codex install message when provider is openai', () => {
    const msg = aiUnavailableMessage({ ai: { provider: 'openai' } });
    expect(msg).toContain('Codex CLI');
  });

  it('returns unknown provider message for unrecognised provider', () => {
    const msg = aiUnavailableMessage({ ai: { provider: 'myai' } });
    expect(msg).toContain('Unknown AI provider');
    expect(msg).toContain('"myai"');
    expect(msg).toContain('claude, gemini, openai');
  });
});

// ---------------------------------------------------------------------------
// isAiAvailable — feature-gate branch (no execa call needed)
// ---------------------------------------------------------------------------

describe('isAiAvailable (feature gate)', () => {
  it('returns false when features.ai is falsy (false)', async () => {
    const result = await isAiAvailable({ features: { ai: false } });
    expect(result).toBe(false);
    expect(execa).not.toHaveBeenCalled();
  });

  it('returns false when features.ai is absent', async () => {
    const result = await isAiAvailable({ features: {} });
    expect(result).toBe(false);
    expect(execa).not.toHaveBeenCalled();
  });

  it('returns false when config is undefined', async () => {
    const result = await isAiAvailable(undefined);
    expect(result).toBe(false);
    expect(execa).not.toHaveBeenCalled();
  });

  it('returns false for unknown provider even when features.ai is true', async () => {
    // unknown provider hits the default branch which returns false without calling execa
    const result = await isAiAvailable({
      features: { ai: true },
      ai: { provider: 'unknown-provider' },
    });
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isAiAvailable — provider delegation (uses vi.resetModules for fresh cache)
// ---------------------------------------------------------------------------

describe('isAiAvailable (provider delegation)', () => {
  it('delegates to isClaudeAvailable when provider is claude', async () => {
    execa.mockResolvedValue({ exitCode: 0 });
    vi.resetModules();

    const { isAiAvailable: fresh } = await import('../../src/lib/ai.js');
    const config = makeConfig({ ai: { provider: 'claude' } });
    const result = await fresh(config);

    expect(result).toBe(true);
    expect(execa).toHaveBeenCalledWith('claude', ['--version'], expect.any(Object));
  });

  it('delegates to isGeminiAvailable when provider is gemini', async () => {
    execa.mockResolvedValue({ exitCode: 0 });
    vi.resetModules();

    const { isAiAvailable: fresh } = await import('../../src/lib/ai.js');
    const config = makeConfig({ ai: { provider: 'gemini' } });
    const result = await fresh(config);

    expect(result).toBe(true);
    expect(execa).toHaveBeenCalledWith('gemini', ['--version'], expect.any(Object));
  });

  it('delegates to isCodexAvailable when provider is openai', async () => {
    execa.mockResolvedValue({ exitCode: 0 });
    vi.resetModules();

    const { isAiAvailable: fresh } = await import('../../src/lib/ai.js');
    const config = makeConfig({ ai: { provider: 'openai' } });
    const result = await fresh(config);

    expect(result).toBe(true);
    expect(execa).toHaveBeenCalledWith('codex', ['--version'], expect.any(Object));
  });

  it('returns false when provider CLI exits with non-zero code', async () => {
    execa.mockResolvedValue({ exitCode: 1 });
    vi.resetModules();

    const { isAiAvailable: fresh } = await import('../../src/lib/ai.js');
    const config = makeConfig({ ai: { provider: 'claude' } });
    const result = await fresh(config);

    expect(result).toBe(false);
  });

  it('returns false when provider CLI check throws', async () => {
    execa.mockRejectedValue(new Error('ENOENT'));
    vi.resetModules();

    const { isAiAvailable: fresh } = await import('../../src/lib/ai.js');
    const config = makeConfig({ ai: { provider: 'claude' } });
    const result = await fresh(config);

    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Availability check caching — execa is called only once per CLI tool
// ---------------------------------------------------------------------------

describe('availability check caching', () => {
  it('isClaudeAvailable caches the result across repeated calls', async () => {
    execa.mockResolvedValue({ exitCode: 0 });
    vi.resetModules();

    const { isClaudeAvailable: fresh } = await import('../../src/lib/ai.js');

    const first = await fresh();
    const second = await fresh();

    expect(first).toBe(true);
    expect(second).toBe(true);
    // execa is called only once despite two invocations
    expect(execa).toHaveBeenCalledTimes(1);
  });

  it('isGeminiAvailable caches the result across repeated calls', async () => {
    execa.mockResolvedValue({ exitCode: 0 });
    vi.resetModules();

    const { isGeminiAvailable: fresh } = await import('../../src/lib/ai.js');

    await fresh();
    await fresh();

    expect(execa).toHaveBeenCalledTimes(1);
  });

  it('isCodexAvailable caches the result across repeated calls', async () => {
    execa.mockResolvedValue({ exitCode: 0 });
    vi.resetModules();

    const { isCodexAvailable: fresh } = await import('../../src/lib/ai.js');

    await fresh();
    await fresh();

    expect(execa).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// runAiPrompt — aiEnabled gate
// ---------------------------------------------------------------------------

describe('runAiPrompt (aiEnabled: false)', () => {
  it('returns null without calling execa when aiEnabled is false', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await runAiPrompt('do something', { aiEnabled: false });

    expect(result).toBeNull();
    expect(execa).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('AI features are disabled'),
    );

    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// runAiPrompt — provider routing
// ---------------------------------------------------------------------------

describe('runAiPrompt (provider routing)', () => {
  it('calls claude CLI when provider is claude and it is available', async () => {
    // First call: version check (exitCode 0 → available)
    // Second call: the actual prompt
    execa
      .mockResolvedValueOnce({ exitCode: 0 })
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'claude response', stderr: '' });

    vi.resetModules();
    const { runAiPrompt: freshRun } = await import('../../src/lib/ai.js');
    const config = makeConfig({ ai: { provider: 'claude' } });

    const result = await freshRun('test prompt', { config, aiEnabled: true });

    expect(result).toMatchObject({ stdout: 'claude response', exitCode: 0 });
    expect(execa.mock.calls.some(([cmd]) => cmd === 'claude')).toBe(true);
  });

  it('returns null and logs when claude is not available', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    execa.mockResolvedValue({ exitCode: 1 }); // isClaudeAvailable → false

    vi.resetModules();
    const { runAiPrompt: freshRun } = await import('../../src/lib/ai.js');
    const config = makeConfig({ ai: { provider: 'claude' } });

    const result = await freshRun('test prompt', { config, aiEnabled: true });

    expect(result).toBeNull();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Claude CLI'));

    consoleSpy.mockRestore();
  });

  it('calls gemini CLI when provider is gemini', async () => {
    execa.mockResolvedValue({ exitCode: 0, stdout: 'gemini response', stderr: '' });

    vi.resetModules();
    const { runAiPrompt: freshRun } = await import('../../src/lib/ai.js');
    const config = makeConfig({ ai: { provider: 'gemini' } });

    const result = await freshRun('test prompt', { config, aiEnabled: true });

    expect(result).toMatchObject({ stdout: 'gemini response', exitCode: 0 });
    expect(execa).toHaveBeenCalledWith('gemini', expect.any(Array), expect.any(Object));
  });

  it('calls codex CLI when provider is openai', async () => {
    execa.mockResolvedValue({ exitCode: 0, stdout: 'codex response', stderr: '' });

    vi.resetModules();
    const { runAiPrompt: freshRun } = await import('../../src/lib/ai.js');
    const config = makeConfig({ ai: { provider: 'openai' } });

    const result = await freshRun('test prompt', { config, aiEnabled: true });

    expect(result).toMatchObject({ stdout: 'codex response', exitCode: 0 });
    expect(execa).toHaveBeenCalledWith('codex', expect.any(Array), expect.any(Object));
  });

  it('injects security guard prefix into the prompt before calling the provider', async () => {
    execa
      .mockResolvedValueOnce({ exitCode: 0 })                               // isClaudeAvailable
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'ok', stderr: '' });    // prompt

    vi.resetModules();
    const { runAiPrompt: freshRun } = await import('../../src/lib/ai.js');
    const config = makeConfig({ ai: { provider: 'claude' } });

    await freshRun('my real prompt', { config, aiEnabled: true });

    // The second execa call carries the prompt; find the value after '-p'
    const promptCall = execa.mock.calls[1];
    const pIdx = promptCall[1].indexOf('-p');
    const promptArg = pIdx !== -1 ? promptCall[1][pIdx + 1] : promptCall[1][0];
    expect(promptArg).toContain('SYSTEM:');
    expect(promptArg).toContain('my real prompt');
  });

  it('falls back to claude when provider is unknown', async () => {
    execa
      .mockResolvedValueOnce({ exitCode: 0 })                                    // isClaudeAvailable
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'fallback', stderr: '' });   // prompt

    vi.resetModules();
    const { runAiPrompt: freshRun } = await import('../../src/lib/ai.js');
    const config = makeConfig({ ai: { provider: 'nonexistent' } });

    const result = await freshRun('test', { config, aiEnabled: true });

    expect(result).toMatchObject({ stdout: 'fallback', exitCode: 0 });
    expect(execa.mock.calls.some(([cmd]) => cmd === 'claude')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// streamAiResponse — error paths
// ---------------------------------------------------------------------------

describe('streamAiResponse', () => {
  it('throws immediately when messages array is empty', async () => {
    await expect(
      streamAiResponse([], 'sys', { config: makeConfig() }, vi.fn()),
    ).rejects.toThrow('messages array must not be empty');
  });

  it('throws when messages is null', async () => {
    await expect(
      streamAiResponse(null, 'sys', { config: makeConfig() }, vi.fn()),
    ).rejects.toThrow('messages array must not be empty');
  });

  it('wraps provider errors with "AI stream failed" prefix for claude', async () => {
    // version check passes; the stream proc's stdout throws
    execa
      .mockResolvedValueOnce({ exitCode: 0 })    // isClaudeAvailable
      .mockImplementationOnce(() => ({
        stdout: {
          [Symbol.asyncIterator]() {
            return {
              next() {
                return Promise.reject(new Error('spawn error'));
              },
            };
          },
        },
      }));

    vi.resetModules();
    const { streamAiResponse: freshStream } = await import('../../src/lib/ai.js');
    const config = makeConfig({ ai: { provider: 'claude' } });
    const messages = [{ role: 'user', content: 'hello' }];

    await expect(
      freshStream(messages, 'system prompt', { config }, vi.fn()),
    ).rejects.toThrow(/AI stream failed \[claude\]/);
  });

  it('wraps gemini provider errors with the gemini provider tag', async () => {
    execa.mockImplementationOnce(() => ({
      stdout: {
        [Symbol.asyncIterator]() {
          return {
            next() {
              return Promise.reject(new Error('gemini spawn error'));
            },
          };
        },
      },
    }));

    vi.resetModules();
    const { streamAiResponse: freshStream } = await import('../../src/lib/ai.js');
    const config = makeConfig({ ai: { provider: 'gemini' } });
    const messages = [{ role: 'user', content: 'hello' }];

    await expect(
      freshStream(messages, 'system', { config }, vi.fn()),
    ).rejects.toThrow(/AI stream failed \[gemini\]/);
  });

  it('wraps openai provider errors with the openai provider tag', async () => {
    execa.mockImplementationOnce(() => ({
      stdout: {
        [Symbol.asyncIterator]() {
          return {
            next() {
              return Promise.reject(new Error('codex spawn error'));
            },
          };
        },
      },
    }));

    vi.resetModules();
    const { streamAiResponse: freshStream } = await import('../../src/lib/ai.js');
    const config = makeConfig({ ai: { provider: 'openai' } });
    const messages = [{ role: 'user', content: 'hello' }];

    await expect(
      freshStream(messages, 'system', { config }, vi.fn()),
    ).rejects.toThrow(/AI stream failed \[openai\]/);
  });

  it('restricts the claude streaming path to read-only tools (prompt-injection guard)', async () => {
    // The /api/ai/chat prompt can carry attacker-controlled page context, so the
    // claude streaming invocation must pass `--allowedTools Read,Grep,Glob` to deny
    // Bash/Write/Edit — matching the codex (`-s read-only`) and gemini
    // (`--approval-mode plan`) streaming guards. Regression guard for security
    // finding H1 (2026-06-13 pre-release review).
    const proc = {
      stdout: {
        [Symbol.asyncIterator]() {
          // emits no chunks, then completes
          return { next: () => Promise.resolve({ done: true, value: undefined }) };
        },
      },
      then: (resolve) => resolve({ exitCode: 0, stdout: '', stderr: '' }),
    };
    execa
      .mockResolvedValueOnce({ exitCode: 0 }) // isClaudeAvailable --version
      .mockReturnValueOnce(proc); // streaming proc

    vi.resetModules();
    const { streamAiResponse: freshStream } = await import('../../src/lib/ai.js');
    const config = makeConfig({ ai: { provider: 'claude' } });
    const messages = [{ role: 'user', content: 'hello' }];

    await freshStream(messages, 'system prompt', { config }, vi.fn());

    const streamCall = execa.mock.calls.find(
      (c) => c[0] === 'claude' && Array.isArray(c[1]) && c[1].includes('-p'),
    );
    expect(streamCall).toBeDefined();
    const args = streamCall[1];
    const idx = args.indexOf('--allowedTools');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('Read,Grep,Glob');
  });
});
