import { spawn } from 'node:child_process';

/**
 * Thin wrapper around the sfdt CLI for the VS Code extension.
 *
 * Deliberately free of any `vscode` import so it can be unit-tested under
 * vitest with a mocked child_process. The extension layer supplies the CLI
 * path, cwd, and default org from workspace configuration.
 */

export interface RunOptions {
  /** Path to the sfdt binary (defaults to "sfdt" on PATH). */
  cliPath?: string;
  /** Working directory — typically the workspace folder root. */
  cwd?: string;
  /** Org alias appended as `--org <alias>` when set. */
  org?: string;
  /** Extra environment variables. */
  env?: NodeJS.ProcessEnv;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Build the full argv for an sfdt invocation, appending `--org` when an alias
 * is configured and not already present.
 */
export function buildArgs(args: string[], org?: string): string[] {
  if (org && !args.includes('--org')) {
    return [...args, '--org', org];
  }
  return args;
}

/**
 * Run an sfdt command and capture its output. Never rejects on a non-zero exit
 * code — the caller inspects `code`.
 */
export function runSfdt(args: string[], options: RunOptions = {}): Promise<RunResult> {
  const { cliPath = 'sfdt', cwd, org, env } = options;
  const argv = buildArgs(args, org);
  return new Promise((resolve, reject) => {
    const child = spawn(cliPath, argv, {
      cwd,
      env: { ...process.env, SFDT_NON_INTERACTIVE: 'true', ...env },
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

/**
 * Run an sfdt command in `--json` mode and parse the result. Throws when the
 * output is not valid JSON or the command reported an error envelope.
 */
export async function runSfdtJson<T = unknown>(args: string[], options: RunOptions = {}): Promise<T> {
  const result = await runSfdt([...args, '--json'], options);
  const text = result.stdout.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `sfdt ${args.join(' ')} did not return JSON (exit ${result.code}): ${truncate(result.stderr || text)}`,
    );
  }
  if (parsed && typeof parsed === 'object' && (parsed as { status?: string }).status === 'error') {
    throw new Error((parsed as { message?: string }).message ?? 'sfdt command failed');
  }
  return parsed as T;
}

function truncate(s: string, max = 300): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}
