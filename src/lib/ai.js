import { execa } from 'execa';

// ─── Provider helpers ─────────────────────────────────────────────────────────

let claudeAvailableCache = null;

/**
 * Check whether the `claude` CLI is installed and accessible.
 * Cached for the lifetime of the process.
 */
export async function isClaudeAvailable() {
  if (claudeAvailableCache !== null) return claudeAvailableCache;

  try {
    const result = await execa('claude', ['--version'], {
      reject: false,
      timeout: 5000,
    });
    claudeAvailableCache = result.exitCode === 0;
  } catch {
    claudeAvailableCache = false;
  }

  return claudeAvailableCache;
}

/**
 * Resolve the API key for a given provider.
 * Priority: config.ai.apiKey → provider-specific env var.
 */
function resolveApiKey(config, provider) {
  if (config?.ai?.apiKey) return config.ai.apiKey;

  const envVars = {
    gemini: ['GEMINI_API_KEY', 'GOOGLE_AI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
    openai: ['OPENAI_API_KEY'],
  };

  for (const envVar of envVars[provider] ?? []) {
    if (process.env[envVar]) return process.env[envVar];
  }

  return null;
}

/**
 * Return the configured AI provider name.
 * Falls back to 'claude' if not set.
 */
export function getConfiguredProvider(config) {
  return config?.ai?.provider || 'claude';
}

/**
 * Check whether the configured AI provider is usable.
 * For Claude: requires the `claude` CLI in PATH.
 * For Gemini/OpenAI: requires an API key in config or env.
 */
export async function isAiAvailable(config) {
  if (!config?.features?.ai) return false;

  const provider = getConfiguredProvider(config);

  switch (provider) {
    case 'claude':
      return isClaudeAvailable();
    case 'gemini':
      return !!resolveApiKey(config, 'gemini');
    case 'openai':
      return !!resolveApiKey(config, 'openai');
    default:
      return false;
  }
}

/**
 * Human-readable description of why a provider is unavailable.
 */
export function aiUnavailableMessage(config) {
  const provider = getConfiguredProvider(config);

  switch (provider) {
    case 'claude':
      return (
        'Claude CLI is not installed or not in PATH. ' +
        'Install it from https://docs.anthropic.com/en/docs/claude-code to enable AI features.'
      );
    case 'gemini':
      return (
        'Gemini API key not found. ' +
        'Set GEMINI_API_KEY in your environment or add ai.apiKey to .sfdt/config.json.'
      );
    case 'openai':
      return (
        'OpenAI API key not found. ' +
        'Set OPENAI_API_KEY in your environment or add ai.apiKey to .sfdt/config.json.'
      );
    default:
      return `Unknown AI provider "${provider}". Supported: claude, gemini, openai.`;
  }
}

// ─── Claude provider ──────────────────────────────────────────────────────────

async function runClaudePrompt(prompt, options) {
  const { allowedTools, input, interactive = false, cwd } = options;

  const available = await isClaudeAvailable();
  if (!available) {
    console.log(aiUnavailableMessage({ ai: { provider: 'claude' } }));
    return null;
  }

  const args = ['-p', prompt];
  if (allowedTools && allowedTools.length > 0) {
    args.push('--allowedTools', allowedTools.join(','));
  }

  const execOptions = {
    cwd: cwd || process.cwd(),
    reject: false,
    timeout: 300_000,
  };

  if (interactive) execOptions.stdio = 'inherit';
  if (input) execOptions.input = input;

  const result = await execa('claude', args, execOptions);

  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.exitCode,
  };
}

// ─── Gemini provider ──────────────────────────────────────────────────────────

const GEMINI_DEFAULT_MODEL = 'gemini-2.0-flash';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

async function runGeminiPrompt(prompt, options, config) {
  const apiKey = resolveApiKey(config, 'gemini');
  if (!apiKey) {
    console.log(aiUnavailableMessage(config));
    return null;
  }

  const model = config?.ai?.model || GEMINI_DEFAULT_MODEL;
  const { interactive = false } = options;

  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
  });

  const headers = { 'Content-Type': 'application/json' };

  if (interactive) {
    // Streaming mode — write tokens to stdout as they arrive
    const url = `${GEMINI_BASE_URL}/${model}:streamGenerateContent?key=${apiKey}&alt=sse`;
    const res = await fetch(url, { method: 'POST', headers, body });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini API error ${res.status}: ${errText}`);
    }

    let fullText = '';
    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (!data || data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);
          const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
          if (text) {
            process.stdout.write(text);
            fullText += text;
          }
        } catch {
          // ignore malformed SSE frames
        }
      }
    }

    if (fullText) process.stdout.write('\n');
    return { stdout: fullText, stderr: '', exitCode: 0 };
  } else {
    // Non-streaming — capture full response
    const url = `${GEMINI_BASE_URL}/${model}:generateContent?key=${apiKey}`;
    const res = await fetch(url, { method: 'POST', headers, body });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini API error ${res.status}: ${errText}`);
    }

    const json = await res.json();
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    return { stdout: text, stderr: '', exitCode: 0 };
  }
}

// ─── OpenAI provider ─────────────────────────────────────────────────────────

const OPENAI_DEFAULT_MODEL = 'gpt-4o-mini';
const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';

async function runOpenAiPrompt(prompt, options, config) {
  const apiKey = resolveApiKey(config, 'openai');
  if (!apiKey) {
    console.log(aiUnavailableMessage(config));
    return null;
  }

  const model = config?.ai?.model || OPENAI_DEFAULT_MODEL;
  const { interactive = false } = options;

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };

  if (interactive) {
    const body = JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
    });

    const res = await fetch(OPENAI_CHAT_URL, { method: 'POST', headers, body });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenAI API error ${res.status}: ${errText}`);
    }

    let fullText = '';
    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (!data || data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content ?? '';
          if (delta) {
            process.stdout.write(delta);
            fullText += delta;
          }
        } catch {
          // ignore malformed SSE frames
        }
      }
    }

    if (fullText) process.stdout.write('\n');
    return { stdout: fullText, stderr: '', exitCode: 0 };
  } else {
    const body = JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
    });

    const res = await fetch(OPENAI_CHAT_URL, { method: 'POST', headers, body });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenAI API error ${res.status}: ${errText}`);
    }

    const json = await res.json();
    const text = json.choices?.[0]?.message?.content ?? '';
    return { stdout: text, stderr: '', exitCode: 0 };
  }
}

// ─── Unified entry point ──────────────────────────────────────────────────────

/**
 * Run a prompt through the configured AI provider.
 *
 * @param {string} prompt - The prompt text to send
 * @param {object} [options]
 * @param {object} [options.config]        - Loaded sfdt config (determines provider)
 * @param {string[]} [options.allowedTools] - Claude-only: tool names to allow
 * @param {string} [options.input]          - Claude-only: pipe as stdin
 * @param {boolean} [options.interactive]   - Stream to stdout (default: false)
 * @param {string} [options.cwd]            - Claude-only: working directory
 * @param {boolean} [options.aiEnabled]     - Feature-gate check (default: true)
 * @returns {Promise<{stdout,stderr,exitCode}|null>}
 */
export async function runAiPrompt(prompt, options = {}) {
  const { config, aiEnabled = true, interactive = false } = options;

  if (!aiEnabled) {
    console.log('AI features are disabled in sfdt configuration. Skipping AI prompt.');
    return null;
  }

  const provider = getConfiguredProvider(config);

  switch (provider) {
    case 'gemini':
      return runGeminiPrompt(prompt, { ...options, interactive }, config);
    case 'openai':
      return runOpenAiPrompt(prompt, { ...options, interactive }, config);
    default:
      // claude (and unknown providers fall back to claude)
      return runClaudePrompt(prompt, { ...options, interactive });
  }
}
