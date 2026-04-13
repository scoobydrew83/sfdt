import { execa } from 'execa';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';

// ─── Credential storage ───────────────────────────────────────────────────────

const SFDT_HOME = path.join(os.homedir(), '.sfdt');
const CREDENTIALS_FILE = path.join(SFDT_HOME, 'credentials.json');

async function readStoredCredentials() {
  try {
    if (await fs.pathExists(CREDENTIALS_FILE)) {
      return await fs.readJson(CREDENTIALS_FILE);
    }
  } catch {
    // ignore corrupt/missing file
  }
  return {};
}

/**
 * Persist an API key for a provider to ~/.sfdt/credentials.json (mode 0600).
 */
export async function storeCredential(provider, apiKey) {
  await fs.ensureDir(SFDT_HOME);
  const existing = await readStoredCredentials();
  existing[provider] = { apiKey };
  await fs.writeJson(CREDENTIALS_FILE, existing, { spaces: 2 });
  await fs.chmod(CREDENTIALS_FILE, 0o600);
}

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
 * Priority: ~/.sfdt/credentials.json → provider env vars → legacy config.ai.apiKey.
 */
async function resolveApiKey(config, provider) {
  // 1. User-level credentials file
  const creds = await readStoredCredentials();
  if (creds[provider]?.apiKey) return creds[provider].apiKey;

  // 2. Environment variables
  const envVars = {
    gemini: ['GEMINI_API_KEY', 'GOOGLE_AI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
    openai: ['OPENAI_API_KEY'],
  };
  for (const envVar of envVars[provider] ?? []) {
    if (process.env[envVar]) return process.env[envVar];
  }

  // 3. Legacy: config.ai.apiKey (backwards compat — do not write here going forward)
  if (config?.ai?.apiKey) return config.ai.apiKey;

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
 */
export async function isAiAvailable(config) {
  if (!config?.features?.ai) return false;

  const provider = getConfiguredProvider(config);

  switch (provider) {
    case 'claude':
      return isClaudeAvailable();
    case 'gemini':
      return !!(await resolveApiKey(config, 'gemini'));
    case 'openai':
      return !!(await resolveApiKey(config, 'openai'));
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
        'Set GEMINI_API_KEY in your environment or run `sfdt init` to store it in ~/.sfdt/credentials.json.'
      );
    case 'openai':
      return (
        'OpenAI API key not found. ' +
        'Set OPENAI_API_KEY in your environment or run `sfdt init` to store it in ~/.sfdt/credentials.json.'
      );
    default:
      return `Unknown AI provider "${provider}". Supported: claude, gemini, openai.`;
  }
}

// ─── Local tool execution ─────────────────────────────────────────────────────

/**
 * Translate Claude-style allowedTools names to local tool names.
 *   'Read'           → read_file
 *   'Write'          → write_file
 *   'Grep'           → grep_files
 *   'LS' / 'Glob'    → list_directory
 *   'Bash(git ...)'  → run_git
 */
function mapAllowedTools(allowedTools) {
  if (!allowedTools || allowedTools.length === 0) return [];
  const tools = new Set();
  for (const tool of allowedTools) {
    if (tool === 'Read') tools.add('read_file');
    if (tool === 'Write') tools.add('write_file');
    if (tool === 'Grep') tools.add('grep_files');
    if (tool === 'LS' || tool === 'Glob') tools.add('list_directory');
    if (tool.startsWith('Bash')) tools.add('run_git');
  }
  return [...tools];
}

const ALLOWED_GIT_SUBCOMMANDS = new Set([
  'log', 'diff', 'status', 'show', 'branch', 'tag',
  'remote', 'ls-files', 'rev-parse', 'describe',
]);

/**
 * Resolve a user-supplied path and assert it stays within the project root.
 * Returns the resolved absolute path, or throws if the path escapes cwd.
 */
async function safeResolvePath(base, relative) {
  if (relative === undefined || relative === null) return base;
  // Reject absolute paths and obvious traversal attempts outright
  if (path.isAbsolute(relative)) {
    throw new Error(`absolute paths are not allowed: ${relative}`);
  }
  const resolved = path.resolve(base, relative);
  // Normalise the base so symlinks don't bypass the check
  let realBase;
  try {
    realBase = await fs.realpath(base);
  } catch {
    realBase = path.resolve(base);
  }
  if (resolved !== realBase && !resolved.startsWith(realBase + path.sep)) {
    throw new Error(`path traversal detected: ${relative}`);
  }
  return resolved;
}

/**
 * Execute a single local tool call. Returns a string result.
 */
async function executeLocalTool(toolName, args, cwd) {
  try {
    switch (toolName) {
      case 'read_file': {
        const filePath = await safeResolvePath(cwd, args.path);
        if (!(await fs.pathExists(filePath))) return `Error: file not found: ${args.path}`;
        const content = await fs.readFile(filePath, 'utf8');
        return content.length > 50000 ? content.slice(0, 50000) + '\n...(truncated)' : content;
      }

      case 'write_file': {
        const filePath = await safeResolvePath(cwd, args.path);
        await fs.ensureDir(path.dirname(filePath));
        await fs.writeFile(filePath, args.content);
        return `Successfully wrote ${args.content.length} bytes to ${args.path}`;
      }

      case 'list_directory': {
        const dirPath = args.path ? await safeResolvePath(cwd, args.path) : cwd;
        if (!(await fs.pathExists(dirPath))) return `Error: directory not found: ${args.path || '.'}`;
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        return entries.map((e) => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`).join('\n');
      }

      case 'run_git': {
        const gitArgs = Array.isArray(args.args)
          ? args.args
          : String(args.command || '').split(/\s+/).filter(Boolean);
        const subcommand = gitArgs[0];
        if (!ALLOWED_GIT_SUBCOMMANDS.has(subcommand)) {
          return `Error: git subcommand "${subcommand}" is not allowed. Allowed: ${[...ALLOWED_GIT_SUBCOMMANDS].join(', ')}`;
        }
        const result = await execa('git', gitArgs, { cwd, reject: false });
        const out = result.stdout || '';
        const err = result.stderr ? `\nstderr: ${result.stderr}` : '';
        return (out + err) || '(empty output)';
      }

      case 'grep_files': {
        if (!args.pattern) return 'Error: pattern is required';
        const searchPath = args.path ? await safeResolvePath(cwd, args.path) : cwd;
        const result = await execa(
          'grep',
          ['-r', '-n', '--include=*.cls', '--include=*.js', '--include=*.html',
           '--include=*.json', '--include=*.xml', args.pattern, searchPath],
          { cwd, reject: false },
        );
        const output = result.stdout || '';
        return output.length > 10000
          ? output.slice(0, 10000) + '\n...(truncated)'
          : output || '(no matches)';
      }

      default:
        return `Error: unknown tool "${toolName}"`;
    }
  } catch (err) {
    return `Error executing ${toolName}: ${err.message}`;
  }
}

// ─── Tool schema definitions ──────────────────────────────────────────────────

// Gemini uses uppercase types (OBJECT, STRING, ARRAY); we convert to lowercase for OpenAI.
const TOOL_SCHEMAS = {
  read_file: {
    name: 'read_file',
    description: 'Read the contents of a file from the project',
    parameters: {
      type: 'OBJECT',
      properties: {
        path: { type: 'STRING', description: 'File path relative to project root' },
      },
      required: ['path'],
    },
  },
  write_file: {
    name: 'write_file',
    description: 'Write content to a file in the project',
    parameters: {
      type: 'OBJECT',
      properties: {
        path: { type: 'STRING', description: 'File path relative to project root' },
        content: { type: 'STRING', description: 'Content to write to the file' },
      },
      required: ['path', 'content'],
    },
  },
  list_directory: {
    name: 'list_directory',
    description: 'List files and directories at a path',
    parameters: {
      type: 'OBJECT',
      properties: {
        path: { type: 'STRING', description: 'Directory path relative to project root (omit for root)' },
      },
    },
  },
  run_git: {
    name: 'run_git',
    description: 'Run a read-only git command (log, diff, status, show, branch, etc.)',
    parameters: {
      type: 'OBJECT',
      properties: {
        args: {
          type: 'ARRAY',
          items: { type: 'STRING' },
          description: 'Git arguments after "git", e.g. ["log", "--oneline", "-20"]',
        },
      },
      required: ['args'],
    },
  },
  grep_files: {
    name: 'grep_files',
    description: 'Search for a pattern in project source files',
    parameters: {
      type: 'OBJECT',
      properties: {
        pattern: { type: 'STRING', description: 'Search pattern (grep-compatible)' },
        path: {
          type: 'STRING',
          description: 'Directory or file to search (optional, defaults to project root)',
        },
      },
      required: ['pattern'],
    },
  },
};

function buildGeminiToolDefs(toolNames) {
  return toolNames.map((n) => TOOL_SCHEMAS[n]).filter(Boolean);
}

function convertSchemaToOpenAi(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const result = { ...schema };
  if (typeof result.type === 'string') result.type = result.type.toLowerCase();
  if (result.properties) {
    result.properties = Object.fromEntries(
      Object.entries(result.properties).map(([k, v]) => [k, convertSchemaToOpenAi(v)]),
    );
  }
  if (result.items) result.items = convertSchemaToOpenAi(result.items);
  return result;
}

function buildOpenAiToolDefs(toolNames) {
  return toolNames.map((n) => {
    const def = TOOL_SCHEMAS[n];
    if (!def) return null;
    return {
      type: 'function',
      function: {
        name: def.name,
        description: def.description,
        parameters: convertSchemaToOpenAi(def.parameters),
      },
    };
  }).filter(Boolean);
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
const MAX_TOOL_ITERATIONS = 10;

async function runGeminiPrompt(prompt, options, config) {
  const apiKey = await resolveApiKey(config, 'gemini');
  if (!apiKey) {
    console.log(aiUnavailableMessage(config));
    return null;
  }

  const model = config?.ai?.model || GEMINI_DEFAULT_MODEL;
  const { interactive = false, allowedTools, cwd = process.cwd() } = options;

  const enabledTools = mapAllowedTools(allowedTools);
  const toolDefs = buildGeminiToolDefs(enabledTools);

  const messages = [{ role: 'user', parts: [{ text: prompt }] }];
  let finalText = '';

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const body = { contents: messages };
    if (toolDefs.length > 0) {
      body.tools = [{ functionDeclarations: toolDefs }];
    }

    const url = `${GEMINI_BASE_URL}/${model}:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini API error ${res.status}: ${errText}`);
    }

    const json = await res.json();
    const parts = json.candidates?.[0]?.content?.parts ?? [];

    const funcCalls = parts.filter((p) => p.functionCall);

    if (funcCalls.length > 0) {
      // Add the model turn to history
      messages.push({ role: 'model', parts });

      // Execute each tool and feed results back
      const funcResponses = [];
      for (const part of funcCalls) {
        const { name, args: toolArgs } = part.functionCall;
        const result = await executeLocalTool(name, toolArgs || {}, cwd);
        funcResponses.push({
          functionResponse: { name, response: { output: result } },
        });
      }
      messages.push({ role: 'user', parts: funcResponses });
      continue;
    }

    // No tool calls — final response
    finalText = parts.filter((p) => p.text).map((p) => p.text).join('');
    break;
  }

  if (interactive && finalText) {
    process.stdout.write(finalText);
    process.stdout.write('\n');
  }

  return { stdout: finalText, stderr: '', exitCode: 0 };
}

// ─── OpenAI provider ─────────────────────────────────────────────────────────

const OPENAI_DEFAULT_MODEL = 'gpt-4o-mini';
const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';

async function runOpenAiPrompt(prompt, options, config) {
  const apiKey = await resolveApiKey(config, 'openai');
  if (!apiKey) {
    console.log(aiUnavailableMessage(config));
    return null;
  }

  const model = config?.ai?.model || OPENAI_DEFAULT_MODEL;
  const { interactive = false, allowedTools, cwd = process.cwd() } = options;

  const enabledTools = mapAllowedTools(allowedTools);
  const toolDefs = buildOpenAiToolDefs(enabledTools);

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };

  const messages = [{ role: 'user', content: prompt }];
  let finalText = '';

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const body = { model, messages };
    if (toolDefs.length > 0) {
      body.tools = toolDefs;
    }

    const res = await fetch(OPENAI_CHAT_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenAI API error ${res.status}: ${errText}`);
    }

    const json = await res.json();
    const choice = json.choices?.[0];
    const message = choice?.message;

    if (choice?.finish_reason === 'tool_calls' && message?.tool_calls?.length > 0) {
      // Add assistant turn to history
      messages.push(message);

      // Execute each tool
      for (const toolCall of message.tool_calls) {
        const {
          id,
          function: { name, arguments: argsJson },
        } = toolCall;
        let toolArgs;
        try {
          toolArgs = JSON.parse(argsJson);
        } catch {
          toolArgs = {};
        }
        const result = await executeLocalTool(name, toolArgs, cwd);
        messages.push({ role: 'tool', tool_call_id: id, content: result });
      }
      continue;
    }

    finalText = message?.content ?? '';
    break;
  }

  if (interactive && finalText) {
    process.stdout.write(finalText);
    process.stdout.write('\n');
  }

  return { stdout: finalText, stderr: '', exitCode: 0 };
}

// ─── Unified entry point ──────────────────────────────────────────────────────

/**
 * Run a prompt through the configured AI provider.
 *
 * @param {string} prompt - The prompt text to send
 * @param {object} [options]
 * @param {object} [options.config]         - Loaded sfdt config (determines provider)
 * @param {string[]} [options.allowedTools] - Tool names to allow (Claude names mapped to local impls)
 * @param {string} [options.input]          - Claude-only: pipe as stdin
 * @param {boolean} [options.interactive]   - Stream/print to stdout (default: false)
 * @param {string} [options.cwd]            - Working directory for tool execution
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
