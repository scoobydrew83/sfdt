/**
 * Route tests for the GUI run-from-dashboard endpoints added for the
 * snapshot-only pages:
 *
 *   POST /api/audit/run    (SSE — runs `sfdt audit all`)
 *   POST /api/monitor/run  (SSE — runs `sfdt monitor all`)
 *   POST /api/command/run  (native-CLI allowlist: scratch/data/docs actions)
 *
 * plus unit tests for the argv builder in src/lib/gui-server/cli-run.js.
 *
 * The handlers re-invoke the sfdt CLI entrypoint via execa and stream its
 * stdout/stderr over SSE, so execa is mocked with the fake-child convention
 * of the sibling gui-server route tests (a promise exposing readable
 * stdout/stderr that settles once both streams drain).
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
    readJson: vi.fn().mockResolvedValue({}),
    readdir: vi.fn().mockResolvedValue([]),
    readFile: vi.fn().mockResolvedValue(''),
    outputJson: vi.fn().mockResolvedValue(undefined),
    writeJson: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    ensureDir: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ mtime: new Date(), size: 0, isDirectory: () => false }),
  },
}));

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

// ─── Imports ────────────────────────────────────────────────────────────────

import request from 'supertest';
import { execa } from 'execa';
import { createGuiApp } from '../../src/lib/gui-server/index.js';
import { logAuditEvent } from '../../src/lib/audit-logger.js';
import { isCliRunCommand, buildCliRunArgv } from '../../src/lib/gui-server/cli-run.js';

// ─── Shared config & helpers ────────────────────────────────────────────────

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

/** The CLI argv passed to the fake execa child, minus the node entrypoint. */
function spawnedCliArgs(callIndex = 0) {
  const [bin, args] = execa.mock.calls[callIndex];
  expect(bin).toBe(process.argv[0]);
  expect(args[0]).toBe(process.argv[1]);
  return args.slice(1);
}

// ─── buildCliRunArgv (pure) ─────────────────────────────────────────────────

describe('cli-run buildCliRunArgv', () => {
  it('recognises exactly the allowlisted commands', () => {
    for (const name of ['audit', 'monitor', 'scratch-create', 'scratch-delete', 'scratch-pool-fill', 'data-export', 'data-import', 'data-delete', 'docs-generate']) {
      expect(isCliRunCommand(name)).toBe(true);
    }
    expect(isCliRunCommand('deploy')).toBe(false);
    expect(isCliRunCommand('rm -rf')).toBe(false);
  });

  it('builds audit/monitor argv without --org when none is given', () => {
    expect(buildCliRunArgv('audit')).toEqual({ argv: ['audit', 'all'], mutating: false });
    expect(buildCliRunArgv('monitor', {}, '')).toEqual({ argv: ['monitor', 'all'], mutating: false });
  });

  it('prefers body.targetOrg over the fallback org', () => {
    expect(buildCliRunArgv('audit', { targetOrg: 'qa' }, 'sess').argv).toEqual(['audit', 'all', '--org', 'qa']);
    expect(buildCliRunArgv('audit', {}, 'sess').argv).toEqual(['audit', 'all', '--org', 'sess']);
  });

  it('rejects invalid org aliases', () => {
    expect(buildCliRunArgv('audit', { targetOrg: '--target-org=evil' })).toEqual({ error: 'Invalid targetOrg' });
    expect(buildCliRunArgv('monitor', {}, '-leadingdash')).toEqual({ error: 'Invalid targetOrg' });
  });

  it('builds scratch-create argv with validated alias and days', () => {
    expect(buildCliRunArgv('scratch-create').argv).toEqual(['scratch', 'create']);
    expect(buildCliRunArgv('scratch-create', { alias: 'my-org', days: 7 }).argv)
      .toEqual(['scratch', 'create', '--alias', 'my-org', '--days', '7']);
    expect(buildCliRunArgv('scratch-create', { alias: '-bad' }).error).toMatch(/alias/i);
    expect(buildCliRunArgv('scratch-create', { days: 0 }).error).toMatch(/days/i);
    expect(buildCliRunArgv('scratch-create', { days: 'NaN' }).error).toMatch(/days/i);
    expect(buildCliRunArgv('scratch-create', { days: 31 }).error).toMatch(/days/i);
  });

  it('builds scratch-delete argv with a required target and forced --yes', () => {
    expect(buildCliRunArgv('scratch-delete', { target: 'sc1' }))
      .toEqual({ argv: ['scratch', 'delete', 'sc1', '--yes'], mutating: true });
    expect(buildCliRunArgv('scratch-delete', {}).error).toMatch(/target/i);
    expect(buildCliRunArgv('scratch-delete', { target: 'a b' }).error).toMatch(/target/i);
    expect(buildCliRunArgv('scratch-delete', { target: '--yes' }).error).toMatch(/target/i);
  });

  it('builds scratch-pool-fill argv with a bounded size', () => {
    expect(buildCliRunArgv('scratch-pool-fill').argv).toEqual(['scratch', 'pool', 'fill']);
    expect(buildCliRunArgv('scratch-pool-fill', { size: 5 }).argv).toEqual(['scratch', 'pool', 'fill', '--size', '5']);
    expect(buildCliRunArgv('scratch-pool-fill', { size: 0 }).error).toMatch(/size/i);
    expect(buildCliRunArgv('scratch-pool-fill', { size: 101 }).error).toMatch(/size/i);
  });

  it('builds data argv with a validated set name and org', () => {
    expect(buildCliRunArgv('data-export', { set: 'accounts' }))
      .toEqual({ argv: ['data', 'export', 'accounts'], mutating: true });
    expect(buildCliRunArgv('data-import', { set: 'accounts', targetOrg: 'qa' }).argv)
      .toEqual(['data', 'import', 'accounts', '--org', 'qa']);
    expect(buildCliRunArgv('data-delete', { set: 'accounts' }, 'sess').argv)
      .toEqual(['data', 'delete', 'accounts', '--org', 'sess', '--yes']);
    expect(buildCliRunArgv('data-export', {}).error).toMatch(/data set/i);
    expect(buildCliRunArgv('data-export', { set: '../etc' }).error).toMatch(/data set/i);
    expect(buildCliRunArgv('data-export', { set: 'a/b' }).error).toMatch(/data set/i);
    expect(buildCliRunArgv('data-export', { set: '-x' }).error).toMatch(/data set/i);
  });

  it('builds docs-generate with a fixed argv', () => {
    expect(buildCliRunArgv('docs-generate', { set: 'ignored', anything: true }))
      .toEqual({ argv: ['docs', 'generate'], mutating: true });
  });

  it('returns an error for unknown commands', () => {
    expect(buildCliRunArgv('nope').error).toMatch(/unknown/i);
  });
});

// ─── /api/audit/run + /api/monitor/run ──────────────────────────────────────

describe('POST /api/audit/run and /api/monitor/run', () => {
  let app;
  let csrf;

  beforeAll(async () => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
    csrf = (await request(app).get('/api/csrf-token')).body.token;
  });
  afterAll(async () => { await app.cleanup?.(); });
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 405 on GET', async () => {
    expect((await request(app).get('/api/audit/run')).status).toBe(405);
    expect((await request(app).get('/api/monitor/run')).status).toBe(405);
  });

  it('rejects a wrong CSRF token', async () => {
    const res = await request(app)
      .post('/api/audit/run')
      .set('X-SFDT-CSRF', 'wrong')
      .send({});
    expect(res.status).toBe(403);
    expect(execa).not.toHaveBeenCalled();
  });

  it('runs `sfdt audit all` and streams log + result events', async () => {
    execa.mockReturnValue(fakeChild({ stdout: ['Running check mfa', 'audit done'], exitCode: 0 }));
    const res = await request(app)
      .post('/api/audit/run')
      .set('X-SFDT-CSRF', csrf)
      .send({});

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);

    const events = collectSse(res.text);
    expect(events.some((e) => e.type === 'log' && e.line === 'Running check mfa')).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'result', exitCode: 0 });

    expect(spawnedCliArgs()).toEqual(['audit', 'all']);
    const opts = execa.mock.calls[0][2];
    expect(opts.cwd).toBe('/project');
    expect(opts.env.SFDT_NON_INTERACTIVE).toBe('true');
  });

  it('passes a validated targetOrg through as --org', async () => {
    execa.mockReturnValue(fakeChild({ stdout: ['ok'], exitCode: 0 }));
    const res = await request(app)
      .post('/api/audit/run')
      .set('X-SFDT-CSRF', csrf)
      .send({ targetOrg: 'qa' });

    expect(res.status).toBe(200);
    expect(spawnedCliArgs()).toEqual(['audit', 'all', '--org', 'qa']);
  });

  it('rejects an invalid targetOrg with 400 before spawning anything', async () => {
    const res = await request(app)
      .post('/api/audit/run')
      .set('X-SFDT-CSRF', csrf)
      .send({ targetOrg: '--target-org=evil' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/targetOrg/);
    expect(execa).not.toHaveBeenCalled();
  });

  it('runs `sfdt monitor all` and reports a non-zero exit code', async () => {
    execa.mockReturnValue(fakeChild({ stderr: ['limit check boom'], exitCode: 2 }));
    const res = await request(app)
      .post('/api/monitor/run')
      .set('X-SFDT-CSRF', csrf)
      .send({});

    expect(res.status).toBe(200);
    const events = collectSse(res.text);
    expect(events.some((e) => e.type === 'log' && e.line === 'limit check boom')).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'result', exitCode: 2 });
    expect(spawnedCliArgs()).toEqual(['monitor', 'all']);
  });

  it('falls back to the session org when no targetOrg is sent', async () => {
    // Fresh app so the session-org state does not leak into the other tests.
    const sessionApp = createGuiApp({ ...MOCK_CONFIG }, VERSION, PORT);
    const sessionCsrf = (await request(sessionApp).get('/api/csrf-token')).body.token;

    const setRes = await request(sessionApp)
      .post('/api/session/org')
      .set('X-SFDT-CSRF', sessionCsrf)
      .send({ org: 'uat' });
    expect(setRes.status).toBe(200);

    execa.mockReturnValue(fakeChild({ stdout: ['ok'], exitCode: 0 }));
    const res = await request(sessionApp)
      .post('/api/monitor/run')
      .set('X-SFDT-CSRF', sessionCsrf)
      .send({});

    expect(res.status).toBe(200);
    expect(spawnedCliArgs()).toEqual(['monitor', 'all', '--org', 'uat']);
    await sessionApp.cleanup?.();
  });
});

// ─── /api/command/run — native-CLI allowlist ────────────────────────────────

describe('POST /api/command/run — native CLI commands', () => {
  let app;
  let csrf;

  beforeAll(async () => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
    csrf = (await request(app).get('/api/csrf-token')).body.token;
  });
  afterAll(async () => { await app.cleanup?.(); });
  beforeEach(() => { vi.clearAllMocks(); });

  it('runs scratch-delete with a forced --yes and records an audit event', async () => {
    execa.mockReturnValue(fakeChild({ stdout: ['Deleted sc1'], exitCode: 0 }));
    const res = await request(app)
      .post('/api/command/run')
      .set('X-SFDT-CSRF', csrf)
      .send({ command: 'scratch-delete', target: 'sc1' });

    expect(res.status).toBe(200);
    const events = collectSse(res.text);
    expect(events.some((e) => e.type === 'log' && e.line === 'Deleted sc1')).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'result', exitCode: 0 });

    expect(spawnedCliArgs()).toEqual(['scratch', 'delete', 'sc1', '--yes']);
    expect(logAuditEvent).toHaveBeenCalledWith(
      'command-run',
      expect.objectContaining({ command: 'scratch-delete' }),
      expect.objectContaining({ actor: 'GUI Operator' }),
    );
  });

  it('rejects scratch-delete without a valid target', async () => {
    const res = await request(app)
      .post('/api/command/run')
      .set('X-SFDT-CSRF', csrf)
      .send({ command: 'scratch-delete' });
    expect(res.status).toBe(400);
    expect(execa).not.toHaveBeenCalled();
  });

  it('runs scratch-create with alias and days', async () => {
    execa.mockReturnValue(fakeChild({ stdout: ['created'], exitCode: 0 }));
    const res = await request(app)
      .post('/api/command/run')
      .set('X-SFDT-CSRF', csrf)
      .send({ command: 'scratch-create', alias: 'feature-x', days: 7 });

    expect(res.status).toBe(200);
    expect(spawnedCliArgs()).toEqual(['scratch', 'create', '--alias', 'feature-x', '--days', '7']);
  });

  it('runs scratch-pool-fill', async () => {
    execa.mockReturnValue(fakeChild({ stdout: ['pool filled'], exitCode: 0 }));
    const res = await request(app)
      .post('/api/command/run')
      .set('X-SFDT-CSRF', csrf)
      .send({ command: 'scratch-pool-fill' });

    expect(res.status).toBe(200);
    expect(spawnedCliArgs()).toEqual(['scratch', 'pool', 'fill']);
  });

  it('runs data-export for a set with a validated targetOrg', async () => {
    execa.mockReturnValue(fakeChild({ stdout: ['exported'], exitCode: 0 }));
    const res = await request(app)
      .post('/api/command/run')
      .set('X-SFDT-CSRF', csrf)
      .send({ command: 'data-export', set: 'accounts', targetOrg: 'qa' });

    expect(res.status).toBe(200);
    expect(spawnedCliArgs()).toEqual(['data', 'export', 'accounts', '--org', 'qa']);
  });

  it('runs data-delete with a forced --yes', async () => {
    execa.mockReturnValue(fakeChild({ stdout: ['deleted'], exitCode: 0 }));
    const res = await request(app)
      .post('/api/command/run')
      .set('X-SFDT-CSRF', csrf)
      .send({ command: 'data-delete', set: 'accounts' });

    expect(res.status).toBe(200);
    expect(spawnedCliArgs()).toEqual(['data', 'delete', 'accounts', '--yes']);
  });

  it('rejects a path-traversal data set name', async () => {
    const res = await request(app)
      .post('/api/command/run')
      .set('X-SFDT-CSRF', csrf)
      .send({ command: 'data-export', set: '../secrets' });
    expect(res.status).toBe(400);
    expect(execa).not.toHaveBeenCalled();
  });

  it('runs docs-generate and does not write a raw command log', async () => {
    const { default: fsMock } = await import('fs-extra');
    execa.mockReturnValue(fakeChild({ stdout: ['docs written'], exitCode: 0 }));
    const res = await request(app)
      .post('/api/command/run')
      .set('X-SFDT-CSRF', csrf)
      .send({ command: 'docs-generate' });

    expect(res.status).toBe(200);
    const events = collectSse(res.text);
    expect(events.at(-1)).toEqual({ type: 'result', exitCode: 0 });
    expect(spawnedCliArgs()).toEqual(['docs', 'generate']);
    // The CLI writes its own artifacts — the server must not add a raw log.
    expect(fsMock.outputJson).not.toHaveBeenCalled();
  });

  it('does not audit-log the non-mutating audit/monitor runs', async () => {
    execa.mockReturnValue(fakeChild({ stdout: ['ok'], exitCode: 0 }));
    const res = await request(app)
      .post('/api/command/run')
      .set('X-SFDT-CSRF', csrf)
      .send({ command: 'audit' });

    expect(res.status).toBe(200);
    expect(spawnedCliArgs()).toEqual(['audit', 'all']);
    expect(logAuditEvent).not.toHaveBeenCalled();
  });

  it('still rejects commands outside both allowlists', async () => {
    const res = await request(app)
      .post('/api/command/run')
      .set('X-SFDT-CSRF', csrf)
      .send({ command: 'rm -rf /' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unknown command/);
    expect(execa).not.toHaveBeenCalled();
  });
});
