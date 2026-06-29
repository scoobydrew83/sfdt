/**
 * Port-conflict helpers for the embedded dashboard. When `sfdt ui` can't bind
 * its port, we want to know *who* holds it and — only if it's a stale sfdt/node
 * GUI server we recognise — free it and retry. A foreign process is never
 * killed; the caller surfaces an error instead.
 *
 * Free of any `vscode` import and parameterised on an injected `exec` so the
 * pure parsing/recognition logic is unit-testable.
 */

export interface PortOwner {
  pid: number;
  /** Best-effort command line / image name of the process holding the port. */
  command: string;
}

/** Run a command and resolve its stdout; reject on non-zero exit / spawn error. */
export type Exec = (cmd: string, args: string[]) => Promise<string>;

/** `process.platform` value — kept local so this module needs no node types. */
export type Platform = 'win32' | 'darwin' | 'linux' | 'aix' | 'freebsd' | 'openbsd' | 'sunos' | 'android' | string;

/** First PID from `lsof -t` output (one PID per line). */
export function parseLsofPid(stdout: string): number | null {
  const line = stdout.split('\n').map((l) => l.trim()).find(Boolean);
  const pid = line ? Number.parseInt(line, 10) : NaN;
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** PID of the LISTENING socket on `port` from `netstat -ano` output (Windows). */
export function parseNetstatPid(stdout: string, port: number): number | null {
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!/^TCP\b/i.test(line) || !/\bLISTENING\b/i.test(line)) continue;
    const cols = line.split(/\s+/);
    // cols: TCP  <local>  <foreign>  LISTENING  <pid>
    const local = cols[1] ?? '';
    if (!local.endsWith(`:${port}`)) continue;
    const pid = Number.parseInt(cols[cols.length - 1] ?? '', 10);
    if (Number.isInteger(pid) && pid > 0) return pid;
  }
  return null;
}

/**
 * Is this command line one of *our* GUI servers (so it's safe to kill)?
 * Matches a node process running `sfdt ... ui` or the gui-server module —
 * deliberately conservative so we never reap an unrelated process.
 */
export function isRecognizedSfdtServer(command: string): boolean {
  const c = command.toLowerCase();
  if (c.includes('gui-server')) return true;
  return /\bsfdt\b/.test(c) && /\bui\b/.test(c);
}

/** Find the process listening on `port`, or null if none / undeterminable. */
export async function findPortOwner(
  port: number,
  exec: Exec,
  platform: Platform,
): Promise<PortOwner | null> {
  try {
    if (platform === 'win32') {
      const pid = parseNetstatPid(await exec('netstat', ['-ano', '-p', 'tcp']), port);
      if (!pid) return null;
      const tl = await exec('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']).catch(() => '');
      return { pid, command: tl.trim() || String(pid) };
    }
    const pid = parseLsofPid(await exec('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']));
    if (!pid) return null;
    const cmd = await exec('ps', ['-p', String(pid), '-o', 'command=']).catch(() => '');
    return { pid, command: cmd.trim() || String(pid) };
  } catch {
    return null;
  }
}

/** Kill a PID. Resolves true on success, false if the kill command failed. */
export async function killPid(
  pid: number,
  exec: Exec,
  platform: Platform,
): Promise<boolean> {
  try {
    if (platform === 'win32') await exec('taskkill', ['/PID', String(pid), '/F']);
    else await exec('kill', [String(pid)]);
    return true;
  } catch {
    return false;
  }
}
