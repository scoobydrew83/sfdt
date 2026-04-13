const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * Sets up signal forwarding from a parent process to a child process.
 *
 * Tracks child exit state independently of `child.killed` so that repeated
 * signals are forwarded as long as the child is still alive. Returns
 * `removeHandlers` (to reset the parent's signal listeners before
 * self-signalling) and `waitForExit` (a Promise that resolves with the child's
 * exit result).
 *
 * @param {NodeJS.EventEmitter & { exit: Function; kill: Function; pid: number }} proc
 * @param {NodeJS.EventEmitter & { kill: Function }} child
 */
export function setupSignalForwarding(proc, child) {
  let childExited = false;
  let exitResult = null;
  let resolveExit = null;

  // Register eagerly so childExited is accurate regardless of whether
  // waitForExit() has been called yet.
  child.on('exit', (code, signal) => {
    childExited = true;
    exitResult = signal
      ? { type: 'signal', signal }
      : { type: 'code', exitCode: code ?? 1 };
    if (resolveExit) resolveExit(exitResult);
  });

  const forwardSignal = (signal) => {
    if (childExited) return;
    try {
      child.kill(signal);
    } catch {
      /* ignore – child may have exited between the guard and the kill call */
    }
  };

  const handlers = {};
  SIGNALS.forEach((sig) => {
    handlers[sig] = () => forwardSignal(sig);
    proc.on(sig, handlers[sig]);
  });

  const removeHandlers = () => {
    SIGNALS.forEach((sig) => proc.removeListener(sig, handlers[sig]));
  };

  const waitForExit = () =>
    new Promise((resolve) => {
      if (exitResult) {
        resolve(exitResult);
      } else {
        resolveExit = resolve;
      }
    });

  return { removeHandlers, waitForExit };
}

/**
 * Terminates the parent process to mirror the child's exit status.
 *
 * For signal exits, removes custom signal handlers before self-signalling so
 * the OS default behaviour (terminate with 128+n) takes effect instead of
 * re-entering the forwarding handler and exiting 0.
 *
 * @param {{ exit: Function; kill: Function; pid: number }} proc
 * @param {{ type: string; signal?: string; exitCode?: number }} result
 * @param {Function} removeHandlers
 */
export function mirrorChildExit(proc, result, removeHandlers) {
  if (result.type === 'signal') {
    removeHandlers();
    proc.kill(proc.pid, result.signal);
  } else {
    proc.exit(result.exitCode);
  }
}
