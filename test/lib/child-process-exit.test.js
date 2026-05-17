import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { setupSignalForwarding, mirrorChildExit } from '../../src/lib/child-process-exit.js';

// Minimal mock for a child process: an EventEmitter with a kill() method.
function makeChild() {
  const child = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

// Minimal mock for the parent process: an EventEmitter with exit/kill methods.
function makeProc() {
  const proc = new EventEmitter();
  proc.exit = vi.fn();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

describe('setupSignalForwarding', () => {
  let proc, child;

  beforeEach(() => {
    proc = makeProc();
    child = makeChild();
  });

  it('forwards SIGINT to child when child has not exited', () => {
    setupSignalForwarding(proc, child);
    proc.emit('SIGINT');
    expect(child.kill).toHaveBeenCalledWith('SIGINT');
  });

  it('forwards SIGTERM to child when child has not exited', () => {
    setupSignalForwarding(proc, child);
    proc.emit('SIGTERM');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('does not forward signals after child has exited', () => {
    // child.emit('exit') fires synchronously, setting childExited before
    // any subsequent proc signal emission.
    setupSignalForwarding(proc, child);
    child.emit('exit', 0, null);
    proc.emit('SIGTERM');
    expect(child.kill).not.toHaveBeenCalled();
  });

  // This test exposes Bug 2: child.killed guard blocks repeated signals
  // even when child has NOT actually exited.
  it('forwards repeated signals while child is still alive', () => {
    setupSignalForwarding(proc, child);

    // Simulate child.kill() having been called once (sets child.killed = true in real ChildProcess).
    // Our implementation must NOT rely on child.killed to skip forwarding.
    proc.emit('SIGTERM');
    proc.emit('SIGTERM');

    expect(child.kill).toHaveBeenCalledTimes(2);
  });

  it('resolves waitForExit with signal type when child exits via signal', async () => {
    const { waitForExit } = setupSignalForwarding(proc, child);
    const p = waitForExit();
    child.emit('exit', null, 'SIGTERM');
    expect(await p).toEqual({ type: 'signal', signal: 'SIGTERM' });
  });

  it('resolves waitForExit with exit code when child exits normally', async () => {
    const { waitForExit } = setupSignalForwarding(proc, child);
    const p = waitForExit();
    child.emit('exit', 42, null);
    expect(await p).toEqual({ type: 'code', exitCode: 42 });
  });

  it('resolves waitForExit with exitCode 1 when child exits with null code', async () => {
    const { waitForExit } = setupSignalForwarding(proc, child);
    const p = waitForExit();
    child.emit('exit', null, null);
    expect(await p).toEqual({ type: 'code', exitCode: 1 });
  });
});

describe('mirrorChildExit', () => {
  let proc, removeHandlers;

  beforeEach(() => {
    proc = makeProc();
    removeHandlers = vi.fn();
  });

  it('calls process.exit() with the exit code for a code result', () => {
    mirrorChildExit(proc, { type: 'code', exitCode: 3 }, removeHandlers);
    expect(proc.exit).toHaveBeenCalledWith(3);
    expect(proc.kill).not.toHaveBeenCalled();
  });

  // This test exposes Bug 1: self-signalling re-enters custom handlers
  // because they are still installed at the time process.kill() is called.
  it('removes signal handlers before self-signalling on signal exit', () => {
    const callOrder = [];
    removeHandlers = vi.fn(() => callOrder.push('removeHandlers'));
    proc.kill = vi.fn(() => callOrder.push('kill'));

    mirrorChildExit(proc, { type: 'signal', signal: 'SIGTERM' }, removeHandlers);

    expect(removeHandlers).toHaveBeenCalled();
    expect(proc.kill).toHaveBeenCalledWith(proc.pid, 'SIGTERM');
    expect(callOrder).toEqual(['removeHandlers', 'kill']);
  });

  it('does not call removeHandlers for a code exit', () => {
    mirrorChildExit(proc, { type: 'code', exitCode: 0 }, removeHandlers);
    expect(removeHandlers).not.toHaveBeenCalled();
  });
});
