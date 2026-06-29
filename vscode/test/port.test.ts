import { describe, it, expect, vi } from 'vitest';
import {
  parseLsofPid,
  parseNetstatPid,
  isRecognizedSfdtServer,
  findPortOwner,
  killPid,
} from '../src/lib/port.js';

describe('parseLsofPid', () => {
  it('returns the first PID', () => {
    expect(parseLsofPid('12345\n')).toBe(12345);
    expect(parseLsofPid('  678 \n9012\n')).toBe(678);
  });
  it('returns null for empty / non-numeric output', () => {
    expect(parseLsofPid('')).toBeNull();
    expect(parseLsofPid('\n  \n')).toBeNull();
    expect(parseLsofPid('nope')).toBeNull();
  });
});

describe('parseNetstatPid', () => {
  const out = [
    '  TCP    0.0.0.0:7654           0.0.0.0:0              LISTENING       4321',
    '  TCP    127.0.0.1:5000         0.0.0.0:0              LISTENING       111',
    '  TCP    0.0.0.0:7654           1.2.3.4:55             ESTABLISHED     999',
  ].join('\n');
  it('finds the LISTENING PID for the port', () => {
    expect(parseNetstatPid(out, 7654)).toBe(4321);
  });
  it('ignores non-listening / other-port rows', () => {
    expect(parseNetstatPid(out, 5000)).toBe(111);
    expect(parseNetstatPid(out, 9999)).toBeNull();
  });
});

describe('isRecognizedSfdtServer', () => {
  it('matches our node GUI servers', () => {
    expect(isRecognizedSfdtServer('node /usr/local/lib/node_modules/@sfdt/cli/bin/sfdt.js ui --no-open')).toBe(true);
    expect(isRecognizedSfdtServer('node /path/src/lib/gui-server/index.js')).toBe(true);
  });
  it('does NOT match foreign processes', () => {
    expect(isRecognizedSfdtServer('node /some/other/app/server.js')).toBe(false);
    expect(isRecognizedSfdtServer('/Applications/Some.app/Contents/MacOS/Some')).toBe(false);
    expect(isRecognizedSfdtServer('sfdt audit')).toBe(false); // sfdt but not the ui server
  });
});

describe('findPortOwner', () => {
  it('resolves pid + command on macOS/Linux via lsof + ps', async () => {
    const exec = vi.fn(async (cmd: string) =>
      cmd === 'lsof' ? '8899\n' : 'node /x/sfdt.js ui --no-open\n',
    );
    expect(await findPortOwner(7654, exec, 'darwin')).toEqual({
      pid: 8899,
      command: 'node /x/sfdt.js ui --no-open',
    });
  });
  it('resolves pid + command on Windows via netstat + tasklist', async () => {
    const exec = vi.fn(async (cmd: string) =>
      cmd === 'netstat'
        ? '  TCP    0.0.0.0:7654   0.0.0.0:0   LISTENING   4321'
        : '"node.exe","4321","Console","1","50,000 K"',
    );
    const owner = await findPortOwner(7654, exec, 'win32');
    expect(owner?.pid).toBe(4321);
    expect(owner?.command).toContain('node.exe');
  });
  it('returns null when nothing holds the port', async () => {
    expect(await findPortOwner(7654, async () => '', 'darwin')).toBeNull();
  });
  it('returns null (never throws) when the lookup command errors', async () => {
    const exec = vi.fn(async () => { throw new Error('lsof missing'); });
    expect(await findPortOwner(7654, exec, 'darwin')).toBeNull();
  });
});

describe('killPid', () => {
  it('uses kill on posix and reports success', async () => {
    const exec = vi.fn(async () => '');
    expect(await killPid(4321, exec, 'darwin')).toBe(true);
    expect(exec).toHaveBeenCalledWith('kill', ['4321']);
  });
  it('uses taskkill on windows', async () => {
    const exec = vi.fn(async () => '');
    await killPid(4321, exec, 'win32');
    expect(exec).toHaveBeenCalledWith('taskkill', ['/PID', '4321', '/F']);
  });
  it('returns false when the kill fails', async () => {
    expect(await killPid(4321, async () => { throw new Error('no perm'); }, 'darwin')).toBe(false);
  });
});
