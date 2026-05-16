import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { setupSignalForwarding, mirrorChildExit } from '../../src/lib/child-process-exit.js';
function makeChild() {
  const child = new EventEmitter();
  child.kill = vi.fn();
  return child;
}
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
    setupSignalForwarding(proc, child);
    child.emit('exit', 0, null);
    proc.emit('SIGTERM');
    expect(child.kill).not.toHaveBeenCalled();
  });
  it('forwards repeated signals while child is still alive', () => {
    setupSignalForwarding(proc, child);
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
