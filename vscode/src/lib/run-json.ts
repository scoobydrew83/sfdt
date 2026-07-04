/**
 * Native `--json` result capture for the sfdt CLI.
 *
 * `sfdt` commands that support `--json` emit an sf-native envelope on stdout:
 * `{ status, result, warnings }` on success (`status` is the numeric exit
 * code, `0` for success) and `{ status, name, message, exitCode, warnings }`
 * on error. Stdout may also carry stray non-JSON lines from subprocesses, so
 * the envelope is located defensively (brace-matched scan, last match wins).
 *
 * Deliberately free of any `vscode` import so the parsing/interpretation layer
 * can be unit-tested under vitest. The impure spawn wrapper (`captureSfdt`)
 * is kept separate from the pure functions (`parseEnvelope`,
 * `interpretCapture`) so tests can feed canned stdout strings.
 */

import { spawn } from 'node:child_process';
import { buildArgs } from './cli.js';

/** The sf-native JSON envelope emitted by sfdt commands supporting `--json`. */
export interface SfEnvelope {
  /** Numeric exit code; `0` on success. */
  status: number;
  /** Command payload (success envelopes). */
  result?: unknown;
  warnings?: string[];
  /** Error-envelope fields (present when `status` is non-zero). */
  name?: string;
  message?: string;
  exitCode?: number;
  data?: unknown;
}

/** Raw output of one CLI invocation, before interpretation. */
export interface CaptureResult {
  /** Process exit code; `null` when the process never ran or was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** True when the caller aborted the run via `CaptureOptions.signal`. */
  cancelled?: boolean;
  /** Message from a spawn-level failure (e.g. binary not found). */
  spawnError?: string;
}

/** Interpreted outcome of a native sfdt run. */
export interface SfdtJsonRun<T = unknown> {
  ok: boolean;
  /** Envelope status when one was found, otherwise the process exit code. */
  status: number;
  result: T | null;
  warnings: string[];
  /** Combined raw stdout+stderr for diagnostics / the results channel. */
  raw: string;
  /** Human-readable failure description; unset when `ok`. */
  error?: string;
  /** True when no sf envelope was found on stdout. */
  noEnvelope: boolean;
  timedOut: boolean;
}

/**
 * Return the balanced `{…}` substring starting at `start` (which must point at
 * a `{`), or null when the braces never balance. String contents (including
 * escaped quotes) are skipped so braces inside JSON strings don't miscount.
 */
function matchBraces(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function isEnvelope(value: unknown): value is SfEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.status !== 'number') return false;
  // Distinguish the sfdt envelope from stray JSON that happens to carry a
  // numeric `status`: a success envelope always has `result`+`warnings`, an
  // error envelope always has `message`+`warnings`.
  return 'result' in v || typeof v.message === 'string' || Array.isArray(v.warnings);
}

/**
 * Scan stdout for the sf-native envelope, tolerating stray non-JSON lines
 * (subprocess noise, progress text) before, between, and after JSON objects.
 * Candidates are brace-matched from each line that starts with `{`; the last
 * object that looks like an envelope wins (sfdt emits its envelope last).
 */
export function parseEnvelope(stdout: string): SfEnvelope | null {
  let found: SfEnvelope | null = null;
  let offset = 0;
  while (offset < stdout.length) {
    const lineEnd = stdout.indexOf('\n', offset);
    const end = lineEnd === -1 ? stdout.length : lineEnd;
    const line = stdout.slice(offset, end);
    const braceCol = line.indexOf('{');
    if (braceCol !== -1 && line.slice(0, braceCol).trim() === '') {
      const candidate = matchBraces(stdout, offset + braceCol);
      if (candidate) {
        try {
          const parsed: unknown = JSON.parse(candidate);
          if (isEnvelope(parsed)) {
            found = parsed;
            // Skip the envelope's pretty-printed body: every nested object
            // starts on its own indented line and would otherwise trigger a
            // redundant brace-match + parse each (large audit/monitor results
            // have thousands). Non-envelope JSON is NOT skipped — an envelope
            // may legitimately appear nested inside a wrapper object.
            const after = offset + braceCol + candidate.length;
            const nextNl = stdout.indexOf('\n', after);
            offset = nextNl === -1 ? stdout.length : nextNl + 1;
            continue;
          }
        } catch {
          // Stray brace / partial JSON — keep scanning.
        }
      }
    }
    offset = end + 1;
  }
  return found;
}

/** Last few non-empty lines of a blob, single-spaced, for compact errors. */
function tail(text: string, lines = 4, maxChars = 400): string {
  const picked = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-lines)
    .join(' · ');
  return picked.length > maxChars ? `${picked.slice(0, maxChars)}…` : picked;
}

export interface InterpretOptions {
  /**
   * When true (default) a missing envelope is a failure even on exit code 0 —
   * the caller asked for `--json` and got none. Set false for commands that
   * don't support `--json` (plain exit-code semantics).
   */
  expectEnvelope?: boolean;
}

/**
 * Pure interpretation of a capture: locate the envelope, derive ok/error.
 * Never throws — every path returns a typed run result.
 */
export function interpretCapture<T = unknown>(
  cap: CaptureResult,
  options: InterpretOptions = {},
): SfdtJsonRun<T> {
  const expectEnvelope = options.expectEnvelope !== false;
  const raw = [cap.stdout, cap.stderr].filter((s) => s && s.trim()).join('\n').trim();
  const base = { result: null, warnings: [] as string[], raw, noEnvelope: true, timedOut: false };

  if (cap.spawnError) {
    return { ...base, ok: false, status: -1, error: `Could not run the sfdt CLI: ${cap.spawnError}` };
  }
  if (cap.cancelled) {
    return { ...base, ok: false, status: cap.code ?? -1, error: 'sfdt run was cancelled' };
  }
  if (cap.timedOut) {
    return { ...base, ok: false, status: cap.code ?? -1, timedOut: true, error: 'sfdt timed out before completing' };
  }

  const envelope = parseEnvelope(cap.stdout);
  if (envelope) {
    const ok = envelope.status === 0;
    return {
      ok,
      status: envelope.status,
      result: (envelope.result ?? null) as T | null,
      warnings: Array.isArray(envelope.warnings) ? envelope.warnings : [],
      raw,
      error: ok ? undefined : envelope.message || `sfdt exited with status ${envelope.status}`,
      noEnvelope: false,
      timedOut: false,
    };
  }

  const code = cap.code ?? -1;
  if (code === 0 && !expectEnvelope) {
    return { ...base, ok: true, status: code };
  }
  const detail = tail(cap.stderr || cap.stdout);
  return {
    ...base,
    ok: false,
    status: code,
    error:
      code === 0
        ? `sfdt produced no JSON result on stdout${detail ? ` (${detail})` : ''}`
        : detail || `sfdt exited with code ${code}`,
  };
}

export interface CaptureOptions {
  /** Path to the sfdt binary (defaults to "sfdt" on PATH). */
  cliPath?: string;
  /** Working directory — typically the workspace folder root. */
  cwd?: string;
  /** Org alias appended as `--org <alias>` when set (see cli.ts buildArgs). */
  org?: string;
  /** Extra environment variables. */
  env?: NodeJS.ProcessEnv;
  /**
   * Kill the process after this long (default 10 minutes — audits can be
   * slow). `0` (or any non-positive value) disables the timeout entirely —
   * pair that with `signal` so the user can still stop the run.
   */
  timeoutMs?: number;
  /** Abort signal: aborting kills the child and resolves with `cancelled: true`. */
  signal?: AbortSignal;
}

/**
 * Spawn the sfdt CLI and capture its output with a timeout. Never rejects —
 * spawn failures and timeouts are reported in the returned CaptureResult so
 * the caller has a single code path.
 */
export function captureSfdt(args: string[], options: CaptureOptions = {}): Promise<CaptureResult> {
  const { cliPath = 'sfdt', cwd, org, env, timeoutMs = 600_000, signal } = options;
  const argv = buildArgs(args, org);
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    if (signal?.aborted) {
      resolve({ code: null, stdout, stderr, timedOut: false, cancelled: true });
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cliPath, argv, {
        cwd,
        env: { ...process.env, SFDT_NON_INTERACTIVE: 'true', ...env },
        // npm installs expose sfdt as a .cmd shim on Windows, which Node
        // refuses to spawn without a shell (EINVAL since the 2024 security
        // patch). POSIX keeps shell:false for exact argv semantics.
        shell: process.platform === 'win32',
        // POSIX: own process group, so a timeout/cancel kill reaches the `sf`
        // children sfdt spawns (they would otherwise keep querying the org).
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      resolve({ code: null, stdout, stderr, timedOut: false, spawnError: (err as Error).message });
      return;
    }
    const killChild = () => {
      try {
        if (process.platform !== 'win32' && child.pid) {
          // Negative pid = the whole process group (see `detached` above).
          process.kill(-child.pid, 'SIGTERM');
        } else {
          child.kill();
        }
      } catch {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      }
    };
    const onAbort = () => {
      killChild();
      finish({ code: null, stdout, stderr, timedOut: false, cancelled: true });
    };
    // finish() only fires from the timer, the abort listener, or child events,
    // all of which run strictly after `timer` is initialized below.
    const finish = (r: CaptureResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(r);
    };
    // timeoutMs <= 0 disables the timeout (the caller provides cancellation).
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            killChild();
            finish({ code: null, stdout, stderr, timedOut: true });
          }, timeoutMs)
        : undefined;
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => finish({ code: null, stdout, stderr, timedOut: false, spawnError: err.message }));
    child.on('close', (code) => finish({ code: code ?? 0, stdout, stderr, timedOut: false }));
  });
}

export interface RunJsonOptions extends CaptureOptions {
  /**
   * Whether the command supports `--json` (default true). When false the flag
   * is not appended and the run is interpreted by exit code alone.
   */
  json?: boolean;
}

/**
 * Run an sfdt command natively and return the interpreted result. Appends
 * `--json` (unless `json: false` or already present), captures with a
 * timeout, and parses the envelope defensively. Never rejects.
 */
export async function runSfdtForResult<T = unknown>(
  args: string[],
  options: RunJsonOptions = {},
): Promise<SfdtJsonRun<T>> {
  const { json = true, ...capture } = options;
  const argv = json && !args.includes('--json') ? [...args, '--json'] : args;
  const cap = await captureSfdt(argv, capture);
  return interpretCapture<T>(cap, { expectEnvelope: json });
}
