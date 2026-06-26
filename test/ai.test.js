import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

import { execa } from 'execa';
import {
  isAiAvailable,
  getConfiguredProvider,
  aiUnavailableMessage,
  runAiPrompt,
  streamAiResponse,
  providerSupportsAgenticTools,
} from '../src/lib/ai.js';

beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
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
  it('returns Claude CLI install instructions for claude provider', () => {
    const msg = aiUnavailableMessage({ ai: { provider: 'claude' } });
    expect(msg).toMatch(/Claude/i);
    expect(msg).toMatch(/CLI/);
  });

  it('returns Gemini CLI install instructions for gemini provider', () => {
    const msg = aiUnavailableMessage({ ai: { provider: 'gemini' } });
    expect(msg).toMatch(/Gemini CLI/);
  });

  it('returns Codex CLI install instructions for openai provider', () => {
    const msg = aiUnavailableMessage({ ai: { provider: 'openai' } });
    expect(msg).toMatch(/Codex CLI/);
  });

  it('returns unknown provider message for unrecognized provider', () => {
    const msg = aiUnavailableMessage({ ai: { provider: 'unknown' } });
    expect(msg).toMatch(/Unknown AI provider/);
  });
});

// ─── isAiAvailable ────────────────────────────────────────────────────────────

describe('isAiAvailable', () => {
  it('returns false when features.ai is false', async () => {
    const result = await isAiAvailable({ features: { ai: false } });
    expect(result).toBe(false);
    expect(execa).not.toHaveBeenCalled();
  });

  it('returns false for unknown provider', async () => {
    const result = await isAiAvailable({
      features: { ai: true },
      ai: { provider: 'unknown-provider' },
    });
    expect(result).toBe(false);
  });

  it('checks codex availability for openai provider', async () => {
    execa.mockResolvedValueOnce({ exitCode: 0 });
    const result = await isAiAvailable({ features: { ai: true }, ai: { provider: 'openai' } });
    expect(typeof result).toBe('boolean');
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

  it('routes to gemini CLI when provider is gemini (read-only sandbox by default)', async () => {
    execa.mockResolvedValue({ exitCode: 0, stdout: 'gemini result', stderr: '' });

    const result = await runAiPrompt('test prompt', {
      config: { ai: { provider: 'gemini' } },
    });

    // First gemini call is the availability probe (`--version`); find the
    // actual prompt invocation by its `-p` flag.
    const promptCall = execa.mock.calls.find(
      (call) => call[0] === 'gemini' && call[1]?.includes('-p'),
    );
    expect(promptCall).toBeDefined();
    // runAiPrompt defaults allowedTools to read-only, so gemini runs in plan mode.
    expect(promptCall[1]).toContain('--approval-mode');
    expect(promptCall[1]).toContain('plan');
    expect(promptCall[1].join(' ')).toContain('test prompt');
    expect(result.stdout).toBe('gemini result');
  });

  it('routes to codex CLI when provider is openai (read-only sandbox by default)', async () => {
    execa.mockResolvedValue({ exitCode: 0, stdout: 'codex result', stderr: '' });

    const result = await runAiPrompt('test prompt', {
      config: { ai: { provider: 'openai' } },
    });

    // First codex call is the availability probe (`--version`); the prompt
    // invocation is the one carrying the actual prompt (not `--version`).
    const promptCall = execa.mock.calls.find(
      (call) => call[0] === 'codex' && call[1]?.[0] !== '--version',
    );
    expect(promptCall).toBeDefined();
    // runAiPrompt defaults allowedTools to read-only, so codex runs sandboxed.
    expect(promptCall[1]).toContain('-s');
    expect(promptCall[1]).toContain('read-only');
    expect(promptCall[1][promptCall[1].length - 1]).toContain('test prompt');
    expect(result.stdout).toBe('codex result');
  });

  it('defaults the claude provider to a read-only allowedTools sandbox', async () => {
    execa.mockResolvedValue({ exitCode: 0, stdout: 'claude result', stderr: '' });

    await runAiPrompt('test prompt', { config: { ai: { provider: 'claude' } } });

    const promptCall = execa.mock.calls.find(
      (call) => call[0] === 'claude' && call[1]?.includes('-p'),
    );
    expect(promptCall).toBeDefined();
    const idx = promptCall[1].indexOf('--allowedTools');
    expect(idx).toBeGreaterThan(-1);
    expect(promptCall[1][idx + 1]).toBe('Read,Grep,Glob');
  });
});

// ─── streamAiResponse ─────────────────────────────────────────────────────────

describe('streamAiResponse', () => {
  const claudeConfig = { ai: { provider: 'claude' }, features: { ai: true } };
  const openaiConfig = { ai: { provider: 'openai' }, features: { ai: true } };
  const geminiConfig = { ai: { provider: 'gemini' }, features: { ai: true } };

  // Returns a fake execa proc whose .stdout is an async iterable of Buffer chunks.
  function makeCLIProc(chunks, exitCode = 0, stderr = '') {
    async function* genChunks() {
      for (const chunk of chunks) {
        yield Buffer.from(chunk);
      }
    }
    const promise = Promise.resolve({ exitCode, stderr });
    promise.stdout = genChunks();
    return promise;
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
      return makeCLIProc([jsonLine + '\n']);
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
      return makeCLIProc([], 1, 'API error');
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

  it('OpenAI: streams stdout chunks from codex CLI to onChunk', async () => {
    execa.mockImplementation((cmd) => {
      if (cmd === 'codex') return makeCLIProc(['hello ', 'world']);
      return Promise.resolve({ exitCode: 0 });
    });

    const onChunk = vi.fn();
    await streamAiResponse(
      [{ role: 'user', content: 'test' }],
      'sys',
      { config: openaiConfig },
      onChunk,
    );
    expect(onChunk).toHaveBeenCalledWith('hello ');
    expect(onChunk).toHaveBeenCalledWith('world');
    const codexCall = execa.mock.calls.find((c) => c[0] === 'codex');
    expect(codexCall).toBeDefined();
  });

  it('Gemini: streams stdout chunks from gemini CLI to onChunk', async () => {
    execa.mockImplementation((cmd) => {
      if (cmd === 'gemini') return makeCLIProc(['hi ', 'there']);
      return Promise.resolve({ exitCode: 0 });
    });

    const onChunk = vi.fn();
    await streamAiResponse(
      [{ role: 'user', content: 'test' }],
      'sys',
      { config: geminiConfig },
      onChunk,
    );
    expect(onChunk).toHaveBeenCalledWith('hi ');
    expect(onChunk).toHaveBeenCalledWith('there');
    const geminiCall = execa.mock.calls.find((c) => c[0] === 'gemini');
    expect(geminiCall).toBeDefined();
    // Stream path forces Gemini into the read-only 'plan' approval mode so
    // prompt-injected commit messages cannot trigger destructive tool use.
    expect(geminiCall[1]).toContain('--approval-mode');
    expect(geminiCall[1]).toContain('plan');
    expect(geminiCall[1]).toContain('-p');
  });

  it('OpenAI: throws when codex CLI exits non-zero', async () => {
    execa.mockImplementation((cmd) => {
      if (cmd === 'codex') return makeCLIProc([], 1, 'codex error');
      return Promise.resolve({ exitCode: 0 });
    });

    await expect(
      streamAiResponse(
        [{ role: 'user', content: 'test' }],
        'sys',
        { config: openaiConfig },
        vi.fn(),
      ),
    ).rejects.toThrow('AI stream failed [openai]');
  });

  it('Gemini: throws when gemini CLI exits non-zero', async () => {
    execa.mockImplementation((cmd) => {
      if (cmd === 'gemini') return makeCLIProc([], 1, 'gemini error');
      return Promise.resolve({ exitCode: 0 });
    });

    await expect(
      streamAiResponse(
        [{ role: 'user', content: 'test' }],
        'sys',
        { config: geminiConfig },
        vi.fn(),
      ),
    ).rejects.toThrow('AI stream failed [gemini]');
  });

  it('Claude: throws when claude is not available', async () => {
    execa.mockImplementation((_cmd, args) => {
      if (args[0] === '--version') return Promise.reject(new Error('not found'));
      return Promise.resolve({ exitCode: 0 });
    });

    await expect(
      streamAiResponse(
        [{ role: 'user', content: 'test' }],
        'sys',
        { config: claudeConfig },
        vi.fn(),
      ),
    ).rejects.toThrow('AI stream failed [claude]');
  });

  it('Claude: processes remaining buffer content without trailing newline', async () => {
    const jsonLine = JSON.stringify({
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'buffered' },
    });

    execa.mockImplementation((_cmd, args) => {
      if (args[0] === '--version') return Promise.resolve({ exitCode: 0 });
      // No trailing newline — forces the remaining buffer path
      return makeCLIProc([jsonLine]);
    });

    const onChunk = vi.fn();
    await streamAiResponse(
      [{ role: 'user', content: 'test' }],
      'sys',
      { config: claudeConfig },
      onChunk,
    );
    expect(onChunk).toHaveBeenCalledWith('buffered');
  });

  it('includes conversation history when multiple messages are passed', async () => {
    const jsonLine = JSON.stringify({
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'ok' },
    });

    let capturedArgs;
    execa.mockImplementation((_cmd, args) => {
      if (args[0] === '--version') return Promise.resolve({ exitCode: 0 });
      capturedArgs = args;
      return makeCLIProc([jsonLine + '\n']);
    });

    await streamAiResponse(
      [
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'first answer' },
        { role: 'user', content: 'follow-up' },
      ],
      'sys',
      { config: claudeConfig },
      vi.fn(),
    );

    const serialized = capturedArgs?.find((a) => typeof a === 'string' && a.includes('Conversation History'));
    expect(serialized).toContain('User: first question');
    expect(serialized).toContain('Assistant: first answer');
    expect(serialized).toContain('follow-up');
  });

  it('wraps provider errors with provider name in message', async () => {
    execa.mockImplementation((cmd) => {
      if (cmd === 'codex') throw new Error('spawn error');
      return Promise.resolve({ exitCode: 0 });
    });

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

// ─── HTTP (OpenAI-compatible) provider ────────────────────────────────────────

describe('providerSupportsAgenticTools', () => {
  it('is false for http and true for CLI providers', () => {
    expect(providerSupportsAgenticTools({ ai: { provider: 'http' } })).toBe(false);
    expect(providerSupportsAgenticTools({ ai: { provider: 'claude' } })).toBe(true);
    expect(providerSupportsAgenticTools({ ai: { provider: 'gemini' } })).toBe(true);
    expect(providerSupportsAgenticTools({})).toBe(true);
  });
});

describe('http provider — aiUnavailableMessage', () => {
  it('explains a missing baseURL', () => {
    const msg = aiUnavailableMessage({ ai: { provider: 'http' } });
    expect(msg).toMatch(/baseURL/);
  });

  it('explains a missing API-key env var', () => {
    vi.stubEnv('SOME_MISSING_KEY', '');
    const msg = aiUnavailableMessage({
      ai: { provider: 'http', baseURL: 'https://api.example.com/v1', apiKeyEnv: 'SOME_MISSING_KEY' },
    });
    expect(msg).toMatch(/SOME_MISSING_KEY/);
  });
});

describe('http provider — isAiAvailable', () => {
  it('is false when baseURL is unset', async () => {
    const ok = await isAiAvailable({ features: { ai: true }, ai: { provider: 'http' } });
    expect(ok).toBe(false);
  });

  it('is false when apiKeyEnv is named but the env var is empty', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', '');
    const ok = await isAiAvailable({
      features: { ai: true },
      ai: { provider: 'http', baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY' },
    });
    expect(ok).toBe(false);
  });

  it('is true for a cloud endpoint with the key present (no network probe)', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-test');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const ok = await isAiAvailable({
      features: { ai: true },
      // Unique host avoids the per-process availability cache from prior tests.
      ai: { provider: 'http', baseURL: 'https://cloud-no-probe.example/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY' },
    });
    expect(ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('probes localhost endpoints via the OpenAI-standard /models for reachability', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    const ok = await isAiAvailable({
      features: { ai: true },
      ai: { provider: 'http', baseURL: 'http://localhost:9999/v1' },
    });
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:9999/v1/models',
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('treats a non-200 probe response (e.g. 403/404) as reachable', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 403 });
    vi.stubGlobal('fetch', fetchMock);
    const ok = await isAiAvailable({
      features: { ai: true },
      ai: { provider: 'http', baseURL: 'http://localhost:9998/v1' },
    });
    expect(ok).toBe(true);
  });
});

describe('http provider — runAiPrompt', () => {
  const httpConfig = {
    ai: { provider: 'http', baseURL: 'https://api.example.com/v1', model: 'test-model', apiKeyEnv: 'TEST_KEY' },
  };

  it('POSTs to /chat/completions with bearer auth and returns content as stdout', async () => {
    vi.stubEnv('TEST_KEY', 'sk-abc');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'http answer' } }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await runAiPrompt('hello model', { config: httpConfig });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer sk-abc');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('test-model');
    expect(body.stream).toBe(false);
    expect(body.messages.at(-1).content).toContain('hello model');
    expect(execa).not.toHaveBeenCalled();
    expect(result.stdout).toBe('http answer');
    expect(result.exitCode).toBe(0);
  });

  it('maps a non-2xx response to exitCode 1 with stderr', async () => {
    vi.stubEnv('TEST_KEY', 'sk-abc');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => 'bad key',
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await runAiPrompt('hello', { config: httpConfig });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/401/);
  });
});

describe('http provider — streamAiResponse', () => {
  function makeSSEResponse(lines) {
    async function* body() {
      for (const line of lines) yield new TextEncoder().encode(line);
    }
    return { ok: true, body: body() };
  }

  it('parses SSE delta chunks and stops on [DONE]', async () => {
    vi.stubEnv('TEST_KEY', 'sk-abc');
    const sse = [
      'data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] }) + '\n\n',
      'data: ' + JSON.stringify({ choices: [{ delta: { content: 'lo' } }] }) + '\n\n',
      'data: [DONE]\n\n',
    ];
    const fetchMock = vi.fn().mockResolvedValue(makeSSEResponse(sse));
    vi.stubGlobal('fetch', fetchMock);

    const onChunk = vi.fn();
    await streamAiResponse(
      [{ role: 'user', content: 'hi' }],
      'system',
      { config: { ai: { provider: 'http', baseURL: 'https://api.example.com/v1', apiKeyEnv: 'TEST_KEY' } } },
      onChunk,
    );

    expect(onChunk).toHaveBeenCalledWith('Hel');
    expect(onChunk).toHaveBeenCalledWith('lo');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.stream).toBe(true);
  });

  it('processes a trailing event when the server closes without [DONE]', async () => {
    vi.stubEnv('TEST_KEY', 'sk-abc');
    // Last event has no terminating blank line and there is no [DONE] sentinel —
    // it must still be flushed from the buffer after the stream ends.
    const sse = [
      'data: ' + JSON.stringify({ choices: [{ delta: { content: 'A' } }] }) + '\n\n',
      'data: ' + JSON.stringify({ choices: [{ delta: { content: 'B' } }] }),
    ];
    const fetchMock = vi.fn().mockResolvedValue(makeSSEResponse(sse));
    vi.stubGlobal('fetch', fetchMock);

    const onChunk = vi.fn();
    await streamAiResponse(
      [{ role: 'user', content: 'hi' }],
      'system',
      { config: { ai: { provider: 'http', baseURL: 'https://api.example.com/v1', apiKeyEnv: 'TEST_KEY' } } },
      onChunk,
    );

    expect(onChunk).toHaveBeenCalledWith('A');
    expect(onChunk).toHaveBeenCalledWith('B'); // tail event not dropped
  });
});
