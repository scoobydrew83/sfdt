/**
 * Route tests for the pull SSE handler's mode branches and the compare/stream
 * diff loop — paths the existing suites only touch on their validation/error
 * branches.
 *
 *   POST /api/pull           (delta / full / preview / group / unknown modes)
 *   GET  /api/compare/stream (per-type batch diff loop body)
 *
 * The delta mode is driven by mocked org-inventory / pull-cache /
 * parallel-retrieve collaborators; the full/preview/group modes shell out via
 * child_process.spawn, which we replace with a fake EventEmitter child that
 * drains its streams then emits 'close'. compare/stream is driven by a mocked
 * readCompare + batchRetrieveTypeMembers.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { Readable } from 'stream';
import { EventEmitter } from 'events';

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

vi.mock('../../src/lib/org-inventory.js', () => ({
  fetchOrgInventory: vi.fn(),
  fetchInventory: vi.fn(),
}));

vi.mock('../../src/lib/pull-cache.js', () => ({
  initCache: vi.fn(() => ({ close: vi.fn() })),
  getDelta: vi.fn(() => new Map()),
  updateCache: vi.fn(),
}));

vi.mock('../../src/lib/parallel-retrieve.js', () => ({
  parallelRetrieve: vi.fn(),
}));

vi.mock('../../src/lib/source-dirs.js', () => ({
  buildSourceDirArgs: vi.fn(() => []),
}));

vi.mock('../../src/lib/gui-server/parsers.js', () => ({
  parseTestRunLines: vi.fn(() => ({})),
  parseQualityLines: vi.fn(() => ({})),
  readTestRuns: vi.fn().mockResolvedValue([]),
  readPreflight: vi.fn().mockResolvedValue(null),
  readQuality: vi.fn().mockResolvedValue(null),
  readDrift: vi.fn().mockResolvedValue(null),
  readCompare: vi.fn().mockResolvedValue(null),
  readScan: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/lib/gui-server/handlers.js', () => ({
  removeComponentFromXml: vi.fn((xml) => xml),
  addComponentToXml: vi.fn((xml) => xml),
  retrieveComponentXml: vi.fn().mockResolvedValue(null),
  batchRetrieveTypeMembers: vi.fn().mockResolvedValue(new Map()),
  readLocalComponentXml: vi.fn().mockResolvedValue(null),
}));

vi.mock('fs-extra', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(false),
    pathExists: vi.fn().mockResolvedValue(false),
    readJson: vi.fn().mockResolvedValue(null),
    readdir: vi.fn().mockResolvedValue([]),
    readFile: vi.fn().mockResolvedValue(''),
    outputJson: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ mtime: new Date(), size: 0, isDirectory: () => false }),
    remove: vi.fn().mockResolvedValue(undefined),
    ensureDir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    writeJson: vi.fn().mockResolvedValue(undefined),
    mkdtemp: vi.fn(async (prefix) => `${prefix}mock`),
  },
}));

vi.mock('execa', () => ({ execa: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }) }));

vi.mock('child_process', () => ({ spawn: vi.fn() }));

// ─── Imports ────────────────────────────────────────────────────────────────

import request from 'supertest';
import { spawn } from 'child_process';
import { createGuiApp } from '../../src/lib/gui-server/index.js';
import { fetchOrgInventory } from '../../src/lib/org-inventory.js';
import { getDelta, updateCache } from '../../src/lib/pull-cache.js';
import { parallelRetrieve } from '../../src/lib/parallel-retrieve.js';
import { readCompare } from '../../src/lib/gui-server/parsers.js';
import { batchRetrieveTypeMembers } from '../../src/lib/gui-server/handlers.js';

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
  pullConfig: {
    pullGroups: {
      ui: { metadata: ['ApexClass:Foo', 'LightningComponentBundle:bar'] },
      empty: { metadata: [] },
      bad: { metadata: ['Not A Valid Entry'] },
    },
  },
};

const VERSION = '0.0.0';
const PORT = 7654;

function fakeSpawnChild({ stdout = [], stderr = [], code = 0 } = {}) {
  const child = new EventEmitter();
  child.stdout = Readable.from(stdout.map((l) => l + '\n'));
  child.stderr = Readable.from(stderr.map((l) => l + '\n'));
  child.killed = false;
  child.kill = vi.fn();
  let ended = 0;
  const done = () => { if (++ended === 2) child.emit('close', code); };
  child.stdout.on('end', done);
  child.stderr.on('end', done);
  return child;
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
});

// ─── POST /api/pull — mode branches ───────────────────────────────────────────

describe('POST /api/pull — delta mode', () => {
  it('reports "nothing to pull" when the delta is empty', async () => {
    fetchOrgInventory.mockResolvedValue(new Map([['ApexClass', new Map([['Foo', {}]])]]));
    getDelta.mockReturnValue(new Map()); // empty delta

    const res = await request(app)
      .post('/api/pull')
      .set('X-SFDT-CSRF', csrf)
      .send({ mode: 'delta', targetOrg: 'dev' });

    expect(res.status).toBe(200);
    const events = collectSse(res.text);
    expect(events.some((e) => e.type === 'log' && /up to date/i.test(e.line))).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'result', exitCode: 0, retrieved: 0 });
  });

  it('retrieves the delta and updates the cache on success', async () => {
    fetchOrgInventory.mockResolvedValue(new Map([['ApexClass', new Map([['Foo', { a: 1 }]])]]));
    getDelta.mockReturnValue(new Map([['ApexClass', new Set(['Foo'])]]));
    parallelRetrieve.mockResolvedValue({
      retrieved: 1,
      successfulMembers: ['ApexClass:Foo'],
      errors: [],
    });

    const res = await request(app)
      .post('/api/pull')
      .set('X-SFDT-CSRF', csrf)
      .send({ mode: 'delta', targetOrg: 'dev' });

    expect(res.status).toBe(200);
    expect(parallelRetrieve).toHaveBeenCalledOnce();
    expect(updateCache).toHaveBeenCalledOnce();
    const events = collectSse(res.text);
    expect(events.at(-1)).toMatchObject({ type: 'result', exitCode: 0, retrieved: 1 });
  });

  it('reports an error result when the delta retrieve has errors', async () => {
    fetchOrgInventory.mockResolvedValue(new Map([['ApexClass', new Map([['Foo', {}]])]]));
    getDelta.mockReturnValue(new Map([['ApexClass', new Set(['Foo'])]]));
    parallelRetrieve.mockResolvedValue({ retrieved: 0, successfulMembers: [], errors: ['nope'] });

    const res = await request(app)
      .post('/api/pull')
      .set('X-SFDT-CSRF', csrf)
      .send({ mode: 'delta', targetOrg: 'dev' });

    const events = collectSse(res.text);
    expect(events.at(-1)).toMatchObject({ type: 'result', exitCode: 1 });
    expect(updateCache).not.toHaveBeenCalled();
  });

  it('emits a pull-failed result when inventory fetch throws', async () => {
    fetchOrgInventory.mockRejectedValue(new Error('org unreachable'));

    const res = await request(app)
      .post('/api/pull')
      .set('X-SFDT-CSRF', csrf)
      .send({ mode: 'delta', targetOrg: 'dev' });

    const events = collectSse(res.text);
    expect(events.some((e) => e.type === 'log' && /Pull failed: org unreachable/.test(e.line))).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'result', exitCode: 1 });
  });
});

describe('POST /api/pull — validation guards', () => {
  it('emits an error result when no target org is configured', async () => {
    const noOrgApp = createGuiApp({ ...MOCK_CONFIG, defaultOrg: undefined }, VERSION, PORT);
    const tok = (await request(noOrgApp).get('/api/csrf-token')).body.token;
    const res = await request(noOrgApp)
      .post('/api/pull')
      .set('X-SFDT-CSRF', tok)
      .send({ mode: 'delta' });
    const events = collectSse(res.text);
    expect(events.some((e) => /No target org/i.test(e.line))).toBe(true);
    await noOrgApp.cleanup?.();
  });

  it('rejects a malformed org alias', async () => {
    const res = await request(app)
      .post('/api/pull')
      .set('X-SFDT-CSRF', csrf)
      .send({ mode: 'delta', targetOrg: '../evil' });
    const events = collectSse(res.text);
    expect(events.some((e) => /Invalid org alias/i.test(e.line))).toBe(true);
  });

  it('reports an unknown mode', async () => {
    const res = await request(app)
      .post('/api/pull')
      .set('X-SFDT-CSRF', csrf)
      .send({ mode: 'sideways', targetOrg: 'dev' });
    const events = collectSse(res.text);
    expect(events.some((e) => /Unknown pull mode: sideways/.test(e.line))).toBe(true);
  });
});

describe('POST /api/pull — spawning modes', () => {
  it('streams sf retrieve output and exit code for full mode', async () => {
    spawn.mockReturnValue(fakeSpawnChild({ stdout: ['Retrieving...', 'Done'], code: 0 }));

    const res = await request(app)
      .post('/api/pull')
      .set('X-SFDT-CSRF', csrf)
      .send({ mode: 'full', targetOrg: 'dev' });

    expect(spawn).toHaveBeenCalledOnce();
    const events = collectSse(res.text);
    expect(events.some((e) => e.type === 'log' && e.line === 'Retrieving...')).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'result', exitCode: 0 });
  });

  it('handles preview mode and propagates a non-zero exit code', async () => {
    spawn.mockReturnValue(fakeSpawnChild({ stderr: ['error'], code: 1 }));

    const res = await request(app)
      .post('/api/pull')
      .set('X-SFDT-CSRF', csrf)
      .send({ mode: 'preview', targetOrg: 'dev' });

    const events = collectSse(res.text);
    expect(events.at(-1)).toMatchObject({ type: 'result', exitCode: 1 });
  });

  it('retrieves a configured pull group', async () => {
    spawn.mockReturnValue(fakeSpawnChild({ stdout: ['ok'], code: 0 }));

    const res = await request(app)
      .post('/api/pull')
      .set('X-SFDT-CSRF', csrf)
      .send({ mode: 'group', targetOrg: 'dev', groupKey: 'ui' });

    expect(spawn).toHaveBeenCalledOnce();
    const events = collectSse(res.text);
    expect(events.at(-1)).toMatchObject({ type: 'result', exitCode: 0 });
  });

  // Regression: these two branches `return` early out of the mode dispatch.
  // Before the `finally { res.end() }` fix they left the SSE stream open, so
  // supertest would hang. The request resolving at all proves it now closes.
  it('rejects an invalid groupKey and still closes the stream', async () => {
    const res = await request(app)
      .post('/api/pull')
      .set('X-SFDT-CSRF', csrf)
      .send({ mode: 'group', targetOrg: 'dev', groupKey: 'bad key' });
    expect(spawn).not.toHaveBeenCalled();
    const events = collectSse(res.text);
    expect(events.some((e) => /Invalid groupKey/.test(e.line))).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'result', exitCode: 1 });
  });

  it('rejects a group with a malformed metadata entry and still closes the stream', async () => {
    const res = await request(app)
      .post('/api/pull')
      .set('X-SFDT-CSRF', csrf)
      .send({ mode: 'group', targetOrg: 'dev', groupKey: 'bad' });
    expect(spawn).not.toHaveBeenCalled();
    const events = collectSse(res.text);
    expect(events.some((e) => /Invalid metadata entry in pull group/.test(e.line))).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'result', exitCode: 1 });
  });

  it('reports an unknown pull group', async () => {
    const res = await request(app)
      .post('/api/pull')
      .set('X-SFDT-CSRF', csrf)
      .send({ mode: 'group', targetOrg: 'dev', groupKey: 'nope' });
    const events = collectSse(res.text);
    expect(events.some((e) => /Unknown pull group: nope/.test(e.line))).toBe(true);
  });

  it('reports an empty pull group', async () => {
    const res = await request(app)
      .post('/api/pull')
      .set('X-SFDT-CSRF', csrf)
      .send({ mode: 'group', targetOrg: 'dev', groupKey: 'empty' });
    const events = collectSse(res.text);
    expect(events.some((e) => /no metadata entries/.test(e.line))).toBe(true);
  });
});

// ─── GET /api/compare/stream — per-type diff loop ─────────────────────────────

describe('GET /api/compare/stream — diff loop', () => {
  it('streams per-member diff + progress events for "both" items', async () => {
    readCompare.mockResolvedValue({
      target: 'prod',
      source: 'dev',
      items: [
        { type: 'ApexClass', member: 'Foo', status: 'both' },
        { type: 'ApexClass', member: 'Bar', status: 'both' },
        { type: 'Flow', member: 'Baz', status: 'only-source' },
      ],
    });
    // target side has Foo (identical) ; source side returns different xml for Bar
    batchRetrieveTypeMembers.mockImplementation((org, type, members) => {
      if (org === 'prod') return Promise.resolve(new Map([['Foo', '<x/>'], ['Bar', '<a/>']]));
      return Promise.resolve(new Map([['Foo', '<x/>'], ['Bar', '<b/>']]));
    });

    const res = await request(app).get(`/api/compare/stream?csrf=${csrf}`);
    expect(res.status).toBe(200);
    const events = collectSse(res.text);
    const diffs = events.filter((e) => e.type === 'diff');
    expect(diffs.length).toBe(2);
    expect(diffs.find((d) => d.member === 'Foo').status).toBe('identical');
    expect(diffs.find((d) => d.member === 'Bar').status).toBe('modified');
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  it('returns 404 when no comparison result exists', async () => {
    readCompare.mockResolvedValue(null);
    const res = await request(app).get(`/api/compare/stream?csrf=${csrf}`);
    expect(res.status).toBe(404);
  });

  it('emits an SSE error when batch retrieve throws mid-loop', async () => {
    readCompare.mockResolvedValue({
      target: 'prod',
      source: 'local',
      items: [{ type: 'ApexClass', member: 'Foo', status: 'both' }],
    });
    batchRetrieveTypeMembers.mockRejectedValue(new Error('retrieve failed'));

    const res = await request(app).get(`/api/compare/stream?csrf=${csrf}`);
    const events = collectSse(res.text);
    expect(events.some((e) => e.type === 'error' && /retrieve failed/.test(e.message))).toBe(true);
  });
});
