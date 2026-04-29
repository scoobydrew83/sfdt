import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

vi.mock('fs-extra', () => ({
  default: {
    pathExists: vi.fn().mockResolvedValue(false),
    readJson: vi.fn().mockResolvedValue({}),
    writeJson: vi.fn().mockResolvedValue(undefined),
    ensureDir: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(''),
    readdir: vi.fn().mockResolvedValue([]),
    realpath: vi.fn().mockImplementation((p) => Promise.resolve(p)),
  },
}));

import { execa } from 'execa';
import fs from 'fs-extra';
import {
  isAiAvailable,
  getConfiguredProvider,
  aiUnavailableMessage,
  runAiPrompt,
  streamAiResponse,
  storeCredential,
} from '../src/lib/ai.js';

beforeEach(() => {
  vi.resetAllMocks();
  // Restore fs-extra defaults after each reset so all tests have a working baseline
  fs.pathExists.mockResolvedValue(false);
  fs.readJson.mockResolvedValue({});
  fs.writeJson.mockResolvedValue(undefined);
  fs.ensureDir.mockResolvedValue(undefined);
  fs.readFile.mockResolvedValue('');
  fs.readdir.mockResolvedValue([]);
  fs.realpath.mockImplementation((p) => Promise.resolve(p));
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
  const claudeConfig = { ai: { provider: 'claude' }, features: { ai: true } };
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

// ─── storeCredential ──────────────────────────────────────────────────────────

describe('storeCredential', () => {
  it('calls ensureDir and writeJson with the provider key and apiKey', async () => {
    await storeCredential('openai', 'sk-test-123');

    expect(fs.ensureDir).toHaveBeenCalledTimes(1);
    expect(fs.writeJson).toHaveBeenCalledTimes(1);

    const [, writtenData, opts] = fs.writeJson.mock.calls[0];
    expect(writtenData).toEqual({ openai: { apiKey: 'sk-test-123' } });
    expect(opts).toMatchObject({ spaces: 2, mode: 0o600 });
  });

  it('merges new credential with existing credentials for other providers', async () => {
    // Simulate an existing gemini credential already stored
    fs.pathExists.mockResolvedValue(true);
    fs.readJson.mockResolvedValue({ gemini: { apiKey: 'gm-existing' } });

    await storeCredential('openai', 'sk-new-key');

    const [, writtenData] = fs.writeJson.mock.calls[0];
    expect(writtenData).toEqual({
      gemini: { apiKey: 'gm-existing' },
      openai: { apiKey: 'sk-new-key' },
    });
  });

  it('reads existing credentials via pathExists then readJson before writing', async () => {
    fs.pathExists.mockResolvedValue(true);
    fs.readJson.mockResolvedValue({ claude: { apiKey: 'old-claude' } });

    await storeCredential('gemini', 'gm-abc');

    expect(fs.pathExists).toHaveBeenCalledTimes(1);
    expect(fs.readJson).toHaveBeenCalledTimes(1);
    expect(fs.writeJson).toHaveBeenCalledTimes(1);

    const [, writtenData] = fs.writeJson.mock.calls[0];
    expect(writtenData.gemini).toEqual({ apiKey: 'gm-abc' });
    expect(writtenData.claude).toEqual({ apiKey: 'old-claude' });
  });

  it('writes empty object as base when no existing credentials file', async () => {
    fs.pathExists.mockResolvedValue(false);

    await storeCredential('gemini', 'gm-fresh');

    // pathExists returns false so readJson should not be called
    expect(fs.readJson).not.toHaveBeenCalled();
    const [, writtenData] = fs.writeJson.mock.calls[0];
    expect(writtenData).toEqual({ gemini: { apiKey: 'gm-fresh' } });
  });
});

// ─── runAiPrompt — additional provider paths ──────────────────────────────────

describe('runAiPrompt (OpenAI provider)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('routes to OpenAI and returns the response content', async () => {
    const openaiConfig = {
      ai: { provider: 'openai', apiKey: 'sk-test' },
      features: { ai: true },
    };

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'openai result' }, finish_reason: 'stop' }],
        }),
      }),
    );

    const result = await runAiPrompt('test prompt', { config: openaiConfig });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url] = fetch.mock.calls[0];
    expect(url).toContain('openai.com');
    expect(result).not.toBeNull();
    expect(result.stdout).toBe('openai result');
  });

  it('returns null and logs when OpenAI API key is missing', async () => {
    const origKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    fs.pathExists.mockResolvedValue(false);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const noKeyConfig = {
      ai: { provider: 'openai', apiKey: '' },
      features: { ai: true },
    };

    const result = await runAiPrompt('test prompt', { config: noKeyConfig });

    expect(result).toBeNull();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('OPENAI_API_KEY'));

    consoleSpy.mockRestore();
    if (origKey) process.env.OPENAI_API_KEY = origKey;
  });
});

describe('runAiPrompt (Gemini provider)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('routes to Gemini and returns the response content', async () => {
    const geminiConfig = {
      ai: { provider: 'gemini', apiKey: 'gm-test' },
      features: { ai: true },
    };

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: 'gemini result' }] } }],
        }),
      }),
    );

    const result = await runAiPrompt('test prompt', { config: geminiConfig });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url] = fetch.mock.calls[0];
    expect(url).toContain('googleapis.com');
    expect(result).not.toBeNull();
    expect(result.stdout).toBe('gemini result');
  });

  it('returns null and logs when Gemini API key is missing', async () => {
    const origKey = process.env.GEMINI_API_KEY;
    const origKey2 = process.env.GOOGLE_AI_API_KEY;
    const origKey3 = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_AI_API_KEY;
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    fs.pathExists.mockResolvedValue(false);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const noKeyConfig = {
      ai: { provider: 'gemini', apiKey: '' },
      features: { ai: true },
    };

    const result = await runAiPrompt('test prompt', { config: noKeyConfig });

    expect(result).toBeNull();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('GEMINI_API_KEY'));

    consoleSpy.mockRestore();
    if (origKey) process.env.GEMINI_API_KEY = origKey;
    if (origKey2) process.env.GOOGLE_AI_API_KEY = origKey2;
    if (origKey3) process.env.GOOGLE_GENERATIVE_AI_API_KEY = origKey3;
  });
});

// ─── isAiAvailable — additional edge cases ───────────────────────────────────

describe('isAiAvailable (additional edge cases)', () => {
  it('returns true for openai when OPENAI_API_KEY env var is set', async () => {
    const orig = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-env-key';
    fs.pathExists.mockResolvedValue(false);

    const result = await isAiAvailable({
      features: { ai: true },
      ai: { provider: 'openai', apiKey: '' },
    });
    expect(result).toBe(true);

    if (orig) process.env.OPENAI_API_KEY = orig;
    else delete process.env.OPENAI_API_KEY;
  });

  it('returns true for gemini when GEMINI_API_KEY env var is set', async () => {
    const origKey = process.env.GEMINI_API_KEY;
    const origKey2 = process.env.GOOGLE_AI_API_KEY;
    const origKey3 = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    process.env.GEMINI_API_KEY = 'gm-env-key';
    fs.pathExists.mockResolvedValue(false);

    const result = await isAiAvailable({
      features: { ai: true },
      ai: { provider: 'gemini', apiKey: '' },
    });
    expect(result).toBe(true);

    if (origKey) process.env.GEMINI_API_KEY = origKey;
    else delete process.env.GEMINI_API_KEY;
    if (origKey2) process.env.GOOGLE_AI_API_KEY = origKey2;
    if (origKey3) process.env.GOOGLE_GENERATIVE_AI_API_KEY = origKey3;
  });

  it('returns false for unknown provider', async () => {
    const result = await isAiAvailable({
      features: { ai: true },
      ai: { provider: 'unknown-provider' },
    });
    expect(result).toBe(false);
  });
});
