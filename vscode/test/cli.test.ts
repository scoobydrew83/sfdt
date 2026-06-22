import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
import { spawn } from 'node:child_process';
import { buildArgs, runSfdt, runSfdtJson } from '../src/lib/cli.js';

/** Build a fake child process that emits the given stdout/stderr then closes. */
function fakeChild(stdout = '', stderr = '', code = 0) {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  queueMicrotask(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', code);
  });
  return child;
}

beforeEach(() => vi.resetAllMocks());

describe('buildArgs', () => {
  it('appends --org when an alias is given', () => {
    expect(buildArgs(['audit', 'all'], 'dev')).toEqual(['audit', 'all', '--org', 'dev']);
  });
  it('does not duplicate --org when already present', () => {
    expect(buildArgs(['audit', '--org', 'x'], 'dev')).toEqual(['audit', '--org', 'x']);
  });
  it('leaves args untouched with no org', () => {
    expect(buildArgs(['preflight'])).toEqual(['preflight']);
  });
});

describe('runSfdt', () => {
  it('spawns the cli and resolves with captured output', async () => {
    (spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(fakeChild('hello', '', 0));
    const res = await runSfdt(['preflight'], { cliPath: 'sfdt', cwd: '/p' });
    expect(res).toEqual({ code: 0, stdout: 'hello', stderr: '' });
    expect(spawn).toHaveBeenCalledWith('sfdt', ['preflight'], expect.objectContaining({ cwd: '/p', shell: false }));
  });

  it('does not reject on a non-zero exit code', async () => {
    (spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(fakeChild('', 'bad', 2));
    const res = await runSfdt(['deploy']);
    expect(res.code).toBe(2);
    expect(res.stderr).toBe('bad');
  });
});

describe('runSfdtJson', () => {
  it('parses JSON output and appends --json', async () => {
    (spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(fakeChild(JSON.stringify({ org: 'dev', summary: {} })));
    const data = await runSfdtJson<{ org: string }>(['audit', 'all'], { org: 'dev' });
    expect(data.org).toBe('dev');
    const argv = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(argv).toContain('--json');
    expect(argv).toEqual(expect.arrayContaining(['--org', 'dev']));
  });

  it('throws on non-JSON output', async () => {
    (spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(fakeChild('not json', '', 1));
    await expect(runSfdtJson(['audit'])).rejects.toThrow(/did not return JSON/);
  });

  it('throws when the JSON reports an error envelope', async () => {
    (spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(fakeChild(JSON.stringify({ status: 'error', message: 'no org' })));
    await expect(runSfdtJson(['audit'])).rejects.toThrow(/no org/);
  });
});
