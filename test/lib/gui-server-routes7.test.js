/**
 * Route tests for the execa-streaming SSE handlers whose success paths the
 * existing suites only touch on their validation/error branches:
 *
 *   POST /api/command/run     (structured + non-structured command runs)
 *   POST /api/release/deploy  (preflight gate, deploy, dry-run, job-id capture)
 *
 * These handlers spawn a child process via `execa`, pipe its stdout/stderr
 * through `readline`, and post-process the buffered lines. To exercise the
 * real streaming + post-processing code we replace the global execa mock with
 * a fake child: a promise that resolves only AFTER its readable stdout/stderr
 * have been fully drained, so the per-line handlers run before the post-await
 * logic. Mirrors the mocking convention of the sibling gui-server route tests.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { Readable } from 'stream';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../../src/lib/log-writer.js', () => ({
  writeLog: vi.fn().mockResolvedValue(undefined),
  parseSfdtLogLines: vi.fn().mockReturnValue({ checks: [], components: [] }),
  readLatestLog: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/lib/update-checker.js', async (importActual) => ({
  ...(await importActual()),
  fetchLatestVersion: vi.fn().mockResolvedValue('1.0.0'),
}));

vi.mock('../../src/lib/audit-logger.js', () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
  redactSensitiveData: vi.fn((s) => s),
}));

vi.mock('fs-extra', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(false),
    pathExists: vi.fn().mockResolvedValue(false),
    readJson: vi.fn().mockResolvedValue([]),
    readdir: vi.fn().mockResolvedValue([]),
    readFile: vi.fn().mockResolvedValue(''),
    outputJson: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ mtime: new Date(), size: 0, isDirectory: () => false }),
    remove: vi.fn().mockResolvedValue(undefined),
    ensureDir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    writeJson: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

// ─── Imports ────────────────────────────────────────────────────────────────

import request from 'supertest';
import fs from 'fs-extra';
import { execa } from 'execa';
import { createGuiApp } from '../../src/lib/gui-server/index.js';
import { writeLog } from '../../src/lib/log-writer.js';
import { logAuditEvent } from '../../src/lib/audit-logger.js';

// ─── Shared config & helpers ──────────────────────────────────────────────────

const MOCK_CONFIG = {
  _projectRoot: '/project',
  _configDir: '/project/.sfdt',
  projectName: 'Test Project',
  defaultOrg: 'dev',
  sourceApiVersion: '59.0',
  defaultSourcePath: 'force-app/main/default',
  logDir: '/project/logs',
  features: { ai: false },
};

const VERSION = '0.0.0';
const PORT = 7654;

/**
 * Build an execa-style child: a promise that exposes readable stdout/stderr
 * and only settles once BOTH streams have been drained, guaranteeing the
 * readline 'line' handlers fire before the handler closes them.
 */
function fakeChild({ stdout = [], stderr = [], exitCode = 0 } = {}) {
  const outStream = Readable.from(stdout.map((l) => l + '\n'));
  const errStream = Readable.from(stderr.map((l) => l + '\n'));
  let resolveFn;
  let rejectFn;
  const promise = new Promise((res, rej) => { resolveFn = res; rejectFn = rej; });
  let ended = 0;
  const settle = () => {
    if (++ended < 2) return;
    if (exitCode === 0) resolveFn({ exitCode, stdout: '', stderr: '' });
    else rejectFn(Object.assign(new Error('command failed'), { exitCode }));
  };
  outStream.on('end', settle);
  errStream.on('end', settle);
  promise.stdout = outStream;
  promise.stderr = errStream;
  promise.killed = false;
  promise.kill = vi.fn();
  return promise;
}

function collectSse(text) {
  return text
    .split('\n\n')
    .filter((c) => c.startsWith('data:'))
    .map((c) => JSON.parse(c.replace(/^data:\s*/, '')));
}

let app;
let csrf;
beforeAll(async () => {
  app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  csrf = (await request(app).get('/api/csrf-token')).body.token;
});
afterAll(async () => {
  await app.cleanup?.();
});
beforeEach(() => {
  vi.clearAllMocks();
  fs.readJson.mockResolvedValue([]);
  fs.outputJson.mockResolvedValue(undefined);
});

// ─── POST /api/update/stream — streaming (non-zero exit, no process.exit) ─────

describe('POST /api/update/stream', () => {
  it('returns 405 on GET', async () => {
    const res = await request(app).get('/api/update/stream');
    expect(res.status).toBe(405);
  });

  it('streams npm output and a non-zero result without restarting', async () => {
    // A non-zero exit avoids the success branch's process.exit(0).
    execa.mockReturnValue(fakeChild({ stdout: ['npm WARN', 'install failed'], exitCode: 1 }));

    const res = await request(app)
      .post('/api/update/stream')
      .set('X-SFDT-CSRF', csrf)
      .send({});

    expect(res.status).toBe(200);
    const events = collectSse(res.text);
    expect(events.some((e) => e.type === 'log' && e.line === 'npm WARN')).toBe(true);
    expect(events.some((e) => e.type === 'result' && e.exitCode === 1)).toBe(true);
    // No 'restarting' event on a failed update.
    expect(events.some((e) => e.type === 'restarting')).toBe(false);
  });
});

// ─── POST /api/command/run — streaming success paths ──────────────────────────

describe('POST /api/command/run — streaming success', () => {
  it('streams logs and writes a structured log for preflight', async () => {
    execa.mockReturnValue(fakeChild({ stdout: ['Running preflight', 'OK'], exitCode: 0 }));
    const res = await request(app)
      .post('/api/command/run')
      .set('X-SFDT-CSRF', csrf)
      .send({ command: 'preflight' });

    expect(res.status).toBe(200);
    const events = collectSse(res.text);
    expect(events.some((e) => e.type === 'log' && e.line === 'Running preflight')).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'result', exitCode: 0 });
    expect(writeLog).toHaveBeenCalledOnce();
    expect(writeLog.mock.calls[0][1]).toBe('preflight');
  });

  it('writes a test-run structured log for the test command', async () => {
    execa.mockReturnValue(fakeChild({ stdout: ['test output'], exitCode: 0 }));
    const res = await request(app)
      .post('/api/command/run')
      .set('X-SFDT-CSRF', csrf)
      .send({ command: 'test' });

    expect(res.status).toBe(200);
    expect(writeLog).toHaveBeenCalledOnce();
    expect(writeLog.mock.calls[0][1]).toBe('test-run');
  });

  it('writes a structured drift log for the drift command', async () => {
    execa.mockReturnValue(fakeChild({ stdout: ['scanning'], exitCode: 0 }));
    const res = await request(app)
      .post('/api/command/run')
      .set('X-SFDT-CSRF', csrf)
      .send({ command: 'drift' });

    expect(res.status).toBe(200);
    expect(writeLog).toHaveBeenCalledOnce();
    expect(writeLog.mock.calls[0][1]).toBe('drift');
  });

  it('writes a raw JSON log for a non-structured command (deploy)', async () => {
    execa.mockReturnValue(fakeChild({ stdout: ['Deploying...'], exitCode: 0 }));
    const res = await request(app)
      .post('/api/command/run')
      .set('X-SFDT-CSRF', csrf)
      .send({ command: 'deploy', targetOrg: 'dev' });

    expect(res.status).toBe(200);
    expect(writeLog).not.toHaveBeenCalled();
    expect(fs.outputJson).toHaveBeenCalledOnce();
    const payload = fs.outputJson.mock.calls[0][1];
    expect(payload.command).toBe('deploy');
    expect(payload.exitCode).toBe(0);
  });

  it('reports a non-zero exit code from the child', async () => {
    execa.mockReturnValue(fakeChild({ stderr: ['boom'], exitCode: 2 }));
    const res = await request(app)
      .post('/api/command/run')
      .set('X-SFDT-CSRF', csrf)
      .send({ command: 'quality' });

    expect(res.status).toBe(200);
    const events = collectSse(res.text);
    expect(events.at(-1)).toEqual({ type: 'result', exitCode: 2 });
  });

  it('passes test classes and a valid testLevel through without error', async () => {
    execa.mockReturnValue(fakeChild({ stdout: ['ok'], exitCode: 0 }));
    const res = await request(app)
      .post('/api/command/run')
      .set('X-SFDT-CSRF', csrf)
      .send({ command: 'test', classes: 'MyTest, OtherTest', testLevel: 'RunSpecifiedTests' });

    expect(res.status).toBe(200);
    expect(writeLog).toHaveBeenCalledOnce();
  });

  it('emits an SSE error when the child cannot be spawned', async () => {
    execa.mockImplementation(() => { throw new Error('spawn ENOENT'); });
    const res = await request(app)
      .post('/api/command/run')
      .set('X-SFDT-CSRF', csrf)
      .send({ command: 'preflight' });

    const events = collectSse(res.text);
    expect(events.some((e) => e.type === 'error' && /spawn ENOENT/.test(e.message))).toBe(true);
  });
});

// ─── POST /api/release/deploy — streaming success paths ───────────────────────

describe('POST /api/release/deploy — streaming success', () => {
  it('runs preflight then deploy, appends history, and emits result', async () => {
    // Both the preflight child and the deploy child succeed.
    execa
      .mockReturnValueOnce(fakeChild({ stdout: ['preflight pass'], exitCode: 0 }))
      .mockReturnValueOnce(fakeChild({ stdout: ['Deploy succeeded'], exitCode: 0 }));

    const res = await request(app)
      .post('/api/release/deploy')
      .set('X-SFDT-CSRF', csrf)
      .send({ org: 'dev' });

    expect(res.status).toBe(200);
    const events = collectSse(res.text);
    expect(events.at(-1)).toEqual({ type: 'result', exitCode: 0 });
    expect(fs.outputJson).toHaveBeenCalledOnce(); // deploy-history append
    // start + end audit events
    expect(logAuditEvent).toHaveBeenCalledTimes(2);
    expect(logAuditEvent.mock.calls[0][0]).toBe('deployment-start');
    expect(logAuditEvent.mock.calls[1][0]).toBe('deployment-end');
  });

  it('short-circuits with the preflight exit code when preflight fails', async () => {
    execa.mockReturnValueOnce(fakeChild({ stderr: ['preflight FAIL'], exitCode: 1 }));

    const res = await request(app)
      .post('/api/release/deploy')
      .set('X-SFDT-CSRF', csrf)
      .send({ org: 'dev' });

    const events = collectSse(res.text);
    expect(events.at(-1)).toEqual({ type: 'result', exitCode: 1 });
    // Only the preflight child ran — deploy was never reached.
    expect(execa).toHaveBeenCalledTimes(1);
    // No history append and no deployment-end audit on the preflight gate.
    expect(fs.outputJson).not.toHaveBeenCalled();
  });

  it('logs validation audit events and captures a validation job id on dry-run', async () => {
    execa.mockReturnValueOnce(
      fakeChild({ stdout: ['Validation Job ID: 0Af000000000001AAA'], exitCode: 0 })
    );

    const res = await request(app)
      .post('/api/release/deploy')
      .set('X-SFDT-CSRF', csrf)
      .send({ org: 'dev', dryRun: true, skipPreflight: true });

    expect(res.status).toBe(200);
    const events = collectSse(res.text);
    const result = events.at(-1);
    expect(result.type).toBe('result');
    expect(result.content.validationJobId).toBe('0Af000000000001AAA');
    expect(logAuditEvent.mock.calls[0][0]).toBe('validation-start');
    expect(logAuditEvent.mock.calls[1][0]).toBe('validation-end');
  });

  it('accepts a manifest, sourceDir, validationJobId and destructiveTiming and deploys', async () => {
    execa.mockReturnValueOnce(fakeChild({ stdout: ['quick deploy ok'], exitCode: 0 }));

    const res = await request(app)
      .post('/api/release/deploy')
      .set('X-SFDT-CSRF', csrf)
      .send({
        org: 'dev',
        skipPreflight: true,
        manifest: 'manifest/release/rl-1.0.0-package.xml',
        sourceDir: 'force-app/main/default',
        validationJobId: '0Af000000000001AAA',
        destructiveTiming: 'pre',
        testLevel: 'RunLocalTests',
        testClasses: 'MyTest,OtherTest',
      });

    expect(res.status).toBe(200);
    const events = collectSse(res.text);
    expect(events.at(-1)).toEqual({ type: 'result', exitCode: 0 });
  });

  it('emits an SSE error when the deploy child throws', async () => {
    execa.mockImplementation(() => { throw new Error('deploy exploded'); });

    const res = await request(app)
      .post('/api/release/deploy')
      .set('X-SFDT-CSRF', csrf)
      .send({ org: 'dev', skipPreflight: true });

    const events = collectSse(res.text);
    expect(events.some((e) => e.type === 'error' && /deploy exploded/.test(e.message))).toBe(true);
  });
});
