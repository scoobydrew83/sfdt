import { execa } from 'execa';

let claudeAvailableCache = null;

/**
 * Check whether the `claude` CLI is installed and accessible.
 * Result is cached for the lifetime of the process.
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
 * Run a prompt through the Claude CLI.
 *
 * @param {string} prompt - The prompt text to send
 * @param {object} [options] - Execution options
 * @param {string[]} [options.allowedTools] - Tools to allow (e.g., ['Bash', 'Read'])
 * @param {string} [options.input] - Pipe this string as stdin
 * @param {boolean} [options.interactive] - Use stdio inherit for TTY (default: false)
 * @param {string} [options.cwd] - Working directory
 * @param {boolean} [options.aiEnabled] - Whether AI features are enabled in config (config.features.ai)
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number}|null>}
 *   Returns null if claude is not available or AI is disabled.
 */
export async function runAiPrompt(prompt, options = {}) {
  const { allowedTools, input, interactive = false, cwd, aiEnabled = true } = options;

  if (!aiEnabled) {
    console.log('AI features are disabled in sfdt configuration. Skipping AI prompt.');
    return null;
  }

  const available = await isClaudeAvailable();
  if (!available) {
    console.log(
      'Claude CLI is not installed or not in PATH. Skipping AI prompt.\n' +
        'Install it from https://docs.anthropic.com/en/docs/claude-cli to enable AI features.',
    );
    return null;
  }

  const args = ['-p', prompt];

  if (allowedTools && allowedTools.length > 0) {
    args.push('--allowedTools', allowedTools.join(','));
  }

  const execOptions = {
    cwd: cwd || process.cwd(),
    reject: false,
    timeout: 300000, // 5 minute timeout for AI operations
  };

  if (interactive) {
    execOptions.stdio = 'inherit';
  }

  if (input) {
    execOptions.input = input;
  }

  const result = await execa('claude', args, execOptions);

  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.exitCode,
  };
}
