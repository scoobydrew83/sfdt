const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
export function setupSignalForwarding(proc, child) {
  let childExited = false;
  let exitResult = null;
  let resolveExit = null;
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
export function mirrorChildExit(proc, result, removeHandlers) {
  if (result.type === 'signal') {
    removeHandlers();
    proc.kill(proc.pid, result.signal);
  } else {
    proc.exit(result.exitCode);
  }
}
