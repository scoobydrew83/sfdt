import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
  streamAiResponse,
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
    const args = promptCall[1].join(' ');
    expect(args).toContain('-p');
    expect(args).toContain('review this code');
    expect(args).toContain('--allowedTools');
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

// ─── streamAiResponse ─────────────────────────────────────────────────────────

describe('streamAiResponse', () => {
  const claudeConfig = { ai: { provider: 'claude' } };
  const openaiConfig = { ai: { provider: 'openai', apiKey: 'sk-test' } };
  const geminiConfig = { ai: { provider: 'gemini', apiKey: 'gm-test' } };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Returns a fake execa proc: .stdout is an async iterable of Buffer lines,
  // the proc itself is a Promise resolving to { exitCode, stderr }.
  function makeClaudeProc(lines, exitCode = 0, stderr = '') {
    async function* genLines() {
      for (const line of lines) {
        yield Buffer.from(line + '\n');
      }
    }
    const promise = Promise.resolve({ exitCode, stderr });
    promise.stdout = genLines();
    return promise;
  }

  function makeSSEStream(text) {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(text));
        controller.close();
      },
    });
  }

  it('throws on empty messages array', async () => {
    await expect(
      streamAiResponse([], 'system', { config: claudeConfig }, vi.fn()),
    ).rejects.toThrow('messages array must not be empty');
  });

  it('Claude: calls onChunk with text from stream-json output', async () => {
    const jsonLine = JSON.stringify({
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'hello' },
    });

    execa.mockImplementation((_cmd, args) => {
      if (args[0] === '--version') return Promise.resolve({ exitCode: 0 });
      return makeClaudeProc([jsonLine]);
    });

    const onChunk = vi.fn();
    await streamAiResponse(
      [{ role: 'user', content: 'test question' }],
      'system prompt',
      { config: claudeConfig },
      onChunk,
    );
    expect(onChunk).toHaveBeenCalledWith('hello');
  });

  it('Claude: throws when claude CLI exits non-zero', async () => {
    execa.mockImplementation((_cmd, args) => {
      if (args[0] === '--version') return Promise.resolve({ exitCode: 0 });
      return makeClaudeProc([], 1, 'API error');
    });

    await expect(
      streamAiResponse(
        [{ role: 'user', content: 'test' }],
        'sys',
        { config: claudeConfig },
        vi.fn(),
      ),
    ).rejects.toThrow('claude exited with code 1');
  });

  it('OpenAI: calls onChunk from SSE stream', async () => {
    const sseData =
      'data: ' +
      JSON.stringify({ choices: [{ delta: { content: 'world' } }] }) +
      '\n\ndata: [DONE]\n\n';

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, body: makeSSEStream(sseData) }),
    );

    const onChunk = vi.fn();
    await streamAiResponse(
      [{ role: 'user', content: 'test' }],
      'sys',
      { config: openaiConfig },
      onChunk,
    );
    expect(onChunk).toHaveBeenCalledWith('world');
  });

  it('Gemini: calls onChunk from SSE stream', async () => {
    const sseData =
      'data: ' +
      JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] }) +
      '\n\n';

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, body: makeSSEStream(sseData) }),
    );

    const onChunk = vi.fn();
    await streamAiResponse(
      [{ role: 'user', content: 'test' }],
      'sys',
      { config: geminiConfig },
      onChunk,
    );
    expect(onChunk).toHaveBeenCalledWith('hi');
  });

  it('wraps provider errors with provider name in message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));

    await expect(
      streamAiResponse(
        [{ role: 'user', content: 'test' }],
        'sys',
        { config: openaiConfig },
        vi.fn(),
      ),
    ).rejects.toThrow('AI stream failed [openai]');
  });
});
