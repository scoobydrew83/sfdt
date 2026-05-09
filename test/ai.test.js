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

  it('routes to gemini CLI when provider is gemini', async () => {
    execa.mockResolvedValue({ exitCode: 0, stdout: 'gemini result', stderr: '' });

    const result = await runAiPrompt('test prompt', {
      config: { ai: { provider: 'gemini' } },
    });

    const promptCall = execa.mock.calls.find((call) => call[0] === 'gemini');
    expect(promptCall).toBeDefined();
    expect(promptCall[1][0]).toBe('-p');
    expect(promptCall[1][1]).toContain('test prompt');
    expect(result.stdout).toBe('gemini result');
  });

  it('routes to codex CLI when provider is openai', async () => {
    execa.mockResolvedValue({ exitCode: 0, stdout: 'codex result', stderr: '' });

    const result = await runAiPrompt('test prompt', {
      config: { ai: { provider: 'openai' } },
    });

    const promptCall = execa.mock.calls.find((call) => call[0] === 'codex');
    expect(promptCall).toBeDefined();
    expect(promptCall[1][0]).toContain('test prompt');
    expect(result.stdout).toBe('codex result');
  });
});

// ─── streamAiResponse ─────────────────────────────────────────────────────────

describe('streamAiResponse', () => {
  const claudeConfig = { ai: { provider: 'claude' }, features: { ai: true } };
  const openaiConfig = { ai: { provider: 'openai' } };
  const geminiConfig = { ai: { provider: 'gemini' } };

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
    expect(geminiCall[1][0]).toBe('-p');
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
