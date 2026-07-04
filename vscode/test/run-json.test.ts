import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
import { spawn } from 'node:child_process';
import {
  parseEnvelope,
  interpretCapture,
  captureSfdt,
  runSfdtForResult,
  type CaptureResult,
} from '../src/lib/run-json.js';

const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>;

/** A canned success envelope as sfdt emits it (pretty-printed, 2-space). */
const auditEnvelope = JSON.stringify(
  {
    status: 0,
    result: { org: 'dev', checks: [], summary: { total: 0, ok: 0, warn: 0, fail: 0, error: 0 } },
    warnings: [],
  },
  null,
  2,
);

const errorEnvelope = JSON.stringify(
  { status: 1, name: 'Error', message: 'No org specified', exitCode: 1, warnings: [] },
  null,
  2,
);

function cap(partial: Partial<CaptureResult>): CaptureResult {
  return { code: 0, stdout: '', stderr: '', timedOut: false, ...partial };
}

describe('parseEnvelope', () => {
  it('parses a bare pretty-printed envelope', () => {
    const env = parseEnvelope(auditEnvelope);
    expect(env?.status).toBe(0);
    expect((env?.result as { org: string }).org).toBe('dev');
  });

  it('tolerates stray non-JSON lines before and after the envelope', () => {
    const stdout = `Pulling metadata...\nWarning: slow org\n${auditEnvelope}\ntrailing noise\n`;
    expect(parseEnvelope(stdout)?.status).toBe(0);
  });

  it('skips stray JSON objects that are not envelopes', () => {
    const stray = '{"status":"skipped","reason":"scanner missing"}';
    const stdout = `${stray}\n${auditEnvelope}`;
    const env = parseEnvelope(stdout);
    expect(env?.status).toBe(0);
    expect(env && 'result' in env).toBe(true);
  });

  it('picks the last envelope when several JSON objects appear', () => {
    const first = JSON.stringify({ status: 0, result: { org: 'first' }, warnings: [] });
    const stdout = `${first}\nmore output\n${errorEnvelope}`;
    const env = parseEnvelope(stdout);
    expect(env?.status).toBe(1);
    expect(env?.message).toBe('No org specified');
  });

  it('survives an unclosed stray brace earlier in the stream', () => {
    const stdout = `{oops this never closes\n${auditEnvelope}`;
    expect(parseEnvelope(stdout)?.status).toBe(0);
  });

  it('ignores braces inside JSON strings when matching', () => {
    const env = JSON.stringify({ status: 0, result: { msg: 'a } b { c' }, warnings: [] }, null, 2);
    const parsed = parseEnvelope(`noise\n${env}`);
    expect((parsed?.result as { msg: string }).msg).toBe('a } b { c');
  });

  it('ignores JSON preceded by non-whitespace on the same line', () => {
    // Only lines that *start* a JSON object are candidates.
    const stdout = 'log: {"status":5,"message":"inline"}';
    expect(parseEnvelope(stdout)).toBeNull();
  });

  it('returns null for garbage and for empty output', () => {
    expect(parseEnvelope('')).toBeNull();
    expect(parseEnvelope('not json at all')).toBeNull();
    expect(parseEnvelope('{"partial":')).toBeNull();
    expect(parseEnvelope('[1,2,3]')).toBeNull();
  });
});

describe('interpretCapture', () => {
  it('interprets a success envelope', () => {
    const run = interpretCapture<{ org: string }>(cap({ stdout: auditEnvelope }));
    expect(run.ok).toBe(true);
    expect(run.status).toBe(0);
    expect(run.result?.org).toBe('dev');
    expect(run.noEnvelope).toBe(false);
    expect(run.error).toBeUndefined();
  });

  it('interprets an error envelope (message wins over exit code)', () => {
    const run = interpretCapture(cap({ stdout: errorEnvelope, code: 1 }));
    expect(run.ok).toBe(false);
    expect(run.status).toBe(1);
    expect(run.result).toBeNull();
    expect(run.error).toBe('No org specified');
  });

  it('surfaces envelope warnings', () => {
    const stdout = JSON.stringify({ status: 0, result: {}, warnings: ['below threshold'] });
    const run = interpretCapture(cap({ stdout }));
    expect(run.warnings).toEqual(['below threshold']);
  });

  it('trusts the envelope status over the process exit code', () => {
    // audit sets process exitCode 1 on failing checks but still emits status 0.
    const run = interpretCapture(cap({ stdout: auditEnvelope, code: 1 }));
    expect(run.ok).toBe(true);
  });

  it('fails when --json was expected but no envelope appeared (even exit 0)', () => {
    const run = interpretCapture(cap({ stdout: 'plain text output', code: 0 }));
    expect(run.ok).toBe(false);
    expect(run.noEnvelope).toBe(true);
    expect(run.error).toMatch(/no JSON result/);
  });

  it('uses exit-code semantics when expectEnvelope is false', () => {
    const okRun = interpretCapture(cap({ stdout: 'checks passed', code: 0 }), { expectEnvelope: false });
    expect(okRun.ok).toBe(true);
    expect(okRun.noEnvelope).toBe(true);

    const failRun = interpretCapture(
      cap({ stdout: 'SFDT_LOG:check:Git:FAIL:dirty', stderr: 'preflight failed', code: 2 }),
      { expectEnvelope: false },
    );
    expect(failRun.ok).toBe(false);
    expect(failRun.status).toBe(2);
    expect(failRun.error).toContain('preflight failed');
  });

  it('reports timeouts and spawn errors', () => {
    const timedOut = interpretCapture(cap({ code: null, timedOut: true }));
    expect(timedOut.ok).toBe(false);
    expect(timedOut.timedOut).toBe(true);
    expect(timedOut.error).toMatch(/timed out/);

    const spawnErr = interpretCapture(cap({ code: null, spawnError: 'spawn sfdt ENOENT' }));
    expect(spawnErr.ok).toBe(false);
    expect(spawnErr.error).toMatch(/Could not run the sfdt CLI/);
  });

  it('reports cancelled runs as failures', () => {
    const run = interpretCapture(cap({ code: null, cancelled: true }));
    expect(run.ok).toBe(false);
    expect(run.timedOut).toBe(false);
    expect(run.error).toMatch(/cancelled/);
  });

  it('keeps combined raw output for diagnostics', () => {
    const run = interpretCapture(cap({ stdout: 'out line', stderr: 'err line', code: 3 }), {
      expectEnvelope: false,
    });
    expect(run.raw).toContain('out line');
    expect(run.raw).toContain('err line');
  });
});

/** Build a fake child process that emits the given stdout/stderr then closes. */
function fakeChild(stdout = '', stderr = '', code = 0, neverClose = false) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  queueMicrotask(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    if (!neverClose) child.emit('close', code);
  });
  return child;
}

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.useRealTimers());

describe('captureSfdt', () => {
  it('captures stdout/stderr and the exit code', async () => {
    spawnMock.mockReturnValue(fakeChild('hello', 'warn', 2));
    const res = await captureSfdt(['preflight'], { cliPath: 'sfdt', cwd: '/proj' });
    expect(res).toEqual({ code: 2, stdout: 'hello', stderr: 'warn', timedOut: false });
    expect(spawnMock).toHaveBeenCalledWith(
      'sfdt',
      ['preflight'],
      expect.objectContaining({ cwd: '/proj', shell: false }),
    );
    const env = spawnMock.mock.calls[0][2].env;
    expect(env.SFDT_NON_INTERACTIVE).toBe('true');
  });

  it('appends --org via the shared buildArgs convention', async () => {
    spawnMock.mockReturnValue(fakeChild('', '', 0));
    await captureSfdt(['audit', 'all'], { org: 'dev' });
    expect(spawnMock.mock.calls[0][1]).toEqual(['audit', 'all', '--org', 'dev']);
  });

  it('kills the child and reports timedOut after the timeout', async () => {
    vi.useFakeTimers();
    const child = fakeChild('partial', '', 0, true);
    spawnMock.mockReturnValue(child);
    const promise = captureSfdt(['audit', 'all'], { timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1001);
    const res = await promise;
    expect(res.timedOut).toBe(true);
    expect(res.stdout).toBe('partial');
    expect(child.kill).toHaveBeenCalled();
  });

  it('resolves with spawnError when the binary cannot be started', async () => {
    const child = fakeChild('', '', 0, true);
    spawnMock.mockReturnValue(child);
    queueMicrotask(() => child.emit('error', new Error('spawn sfdt ENOENT')));
    const res = await captureSfdt(['audit']);
    expect(res.spawnError).toBe('spawn sfdt ENOENT');
    expect(res.code).toBeNull();
  });

  it('kills the child and reports cancelled when the abort signal fires', async () => {
    const child = fakeChild('partial', '', 0, true);
    spawnMock.mockReturnValue(child);
    const abort = new AbortController();
    const promise = captureSfdt(['deploy', '--smart', '--dry-run'], { signal: abort.signal });
    await Promise.resolve(); // let the fake child flush its stdout
    abort.abort();
    const res = await promise;
    expect(res.cancelled).toBe(true);
    expect(res.timedOut).toBe(false);
    expect(res.code).toBeNull();
    expect(res.stdout).toBe('partial');
    expect(child.kill).toHaveBeenCalled();
  });

  it('never spawns when the signal is already aborted', async () => {
    const abort = new AbortController();
    abort.abort();
    const res = await captureSfdt(['deploy'], { signal: abort.signal });
    expect(res.cancelled).toBe(true);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('disables the timeout entirely when timeoutMs is 0', async () => {
    vi.useFakeTimers();
    const child = fakeChild('slow output', '', 0, true);
    spawnMock.mockReturnValue(child);
    const promise = captureSfdt(['deploy', '--smart', '--dry-run'], { timeoutMs: 0 });
    // Way past the 10-minute default — a prod validation can run for hours.
    await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
    expect(child.kill).not.toHaveBeenCalled();
    child.emit('close', 0);
    const res = await promise;
    expect(res.timedOut).toBe(false);
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('slow output');
  });
});

describe('runSfdtForResult', () => {
  it('appends --json and parses the envelope end-to-end', async () => {
    spawnMock.mockReturnValue(fakeChild(`noise\n${auditEnvelope}`, '', 0));
    const run = await runSfdtForResult<{ org: string }>(['audit', 'all'], { org: 'dev' });
    expect(run.ok).toBe(true);
    expect(run.result?.org).toBe('dev');
    const argv = spawnMock.mock.calls[0][1];
    expect(argv).toContain('--json');
    expect(argv).toEqual(expect.arrayContaining(['--org', 'dev']));
  });

  it('does not duplicate --json when already present', async () => {
    spawnMock.mockReturnValue(fakeChild(auditEnvelope, '', 0));
    await runSfdtForResult(['audit', 'all', '--json']);
    const argv = spawnMock.mock.calls[0][1] as string[];
    expect(argv.filter((a) => a === '--json')).toHaveLength(1);
  });

  it('omits --json and uses exit-code semantics when json: false', async () => {
    spawnMock.mockReturnValue(fakeChild('SFDT_LOG:check:Git:PASS:clean', '', 0));
    const run = await runSfdtForResult(['preflight'], { json: false });
    expect(spawnMock.mock.calls[0][1]).toEqual(['preflight']);
    expect(run.ok).toBe(true);
    expect(run.noEnvelope).toBe(true);
  });

  it('never rejects on CLI failure', async () => {
    spawnMock.mockReturnValue(fakeChild('', 'boom', 1));
    const run = await runSfdtForResult(['audit', 'all']);
    expect(run.ok).toBe(false);
    expect(run.error).toContain('boom');
  });
});
