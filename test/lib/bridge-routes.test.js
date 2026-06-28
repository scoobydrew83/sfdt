/**
 * Integration tests for the /api/bridge/* HTTP routes.
 *
 * Mocks fs-extra so the token file appears to exist with a known value, then
 * exercises the routes via supertest. Mirrors the mocking strategy used by
 * the other gui-server test files in this directory.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FIXED_TOKEN = 'test-bridge-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

// ─── Mock fs-extra so the bridge token loader reads a known value. ───────────
// Match the token file by suffix rather than full path — this stays correct
// regardless of what the real homedir resolves to on the test machine, so we
// don't have to mock the `os` built-in (which is fragile through Vitest ESM).

const TOKEN_PATH_SUFFIX = '/.sfdt/bridge-token';
const isTokenPath = (p) => typeof p === 'string' && p.endsWith(TOKEN_PATH_SUFFIX);

const { outputJsonSpy } = vi.hoisted(() => ({
  outputJsonSpy: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('fs-extra', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(false),
    pathExists: vi.fn(async (p) => isTokenPath(p)),
    readJson: vi.fn().mockResolvedValue({}),
    readdir: vi.fn().mockResolvedValue([]),
    readFile: vi.fn(async (p) => (isTokenPath(p) ? `${FIXED_TOKEN}\n` : '')),
    outputJson: outputJsonSpy,
    stat: vi.fn().mockResolvedValue({ mtime: new Date(), size: 0 }),
    remove: vi.fn().mockResolvedValue(undefined),
    ensureDir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    writeJson: vi.fn().mockResolvedValue(undefined),
    chmod: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('execa', () => ({
  execa: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
}));

vi.mock('../../src/lib/log-writer.js', () => ({
  writeLog: vi.fn(),
  parseSfdtLogLines: vi.fn().mockReturnValue({ checks: [], components: [] }),
  readLatestLog: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/lib/update-checker.js', async (importActual) => ({
  ...(await importActual()),
  fetchLatestVersion: vi.fn().mockResolvedValue('1.0.0'),
}));

import request from 'supertest';
import { createGuiApp } from '../../src/lib/gui-server/index.js';
import { clearBridgeTokenCache } from '../../src/lib/bridge/token.js';

const MOCK_CONFIG = {
  _projectRoot: '/project',
  _configDir: '/project/.sfdt',
  projectName: 'Test',
  defaultOrg: 'dev',
  features: {},
};

const VERSION = '0.99.9';
const PORT = 7654;

let app;
beforeAll(() => {
  app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
});
beforeEach(() => clearBridgeTokenCache());
afterAll(async () => {
  await app.cleanup?.();
});

describe('GET /api/bridge/ping', () => {
  it('returns the server version without requiring a bearer token', async () => {
    const res = await request(app).get('/api/bridge/ping');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      data: { pong: true, serverVersion: VERSION, protocolVersion: '1.2', transport: 'localhost', disabledFeatures: [] },
    });
  });

  it('echoes CORS headers for an allowed salesforce origin', async () => {
    const res = await request(app)
      .get('/api/bridge/ping')
      .set('Origin', 'https://example.lightning.force.com');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('https://example.lightning.force.com');
    expect(res.headers['vary']).toBe('Origin');
  });

  it('rejects an origin that is not in the allowlist', async () => {
    const res = await request(app)
      .get('/api/bridge/ping')
      .set('Origin', 'https://evil.example.com');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('BRIDGE_FORBIDDEN');
  });

  it('accepts an OPTIONS preflight with 204 and CORS headers', async () => {
    const res = await request(app)
      .options('/api/bridge/ping')
      .set('Origin', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop')
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'authorization, content-type');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('chrome-extension://abcdefghijklmnopabcdefghijklmnop');
    expect(res.headers['access-control-allow-headers']).toMatch(/Authorization/i);
  });
});

describe('POST /api/bridge/exchange — authentication', () => {
  it('returns 401 with no Authorization header', async () => {
    const res = await request(app)
      .post('/api/bridge/exchange')
      .send({ requestId: 'r1', kind: 'ping' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('BRIDGE_UNAUTHORIZED');
  });

  it('returns 403 with the wrong bearer token', async () => {
    const res = await request(app)
      .post('/api/bridge/exchange')
      .set('Authorization', 'Bearer wrong-token-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')
      .send({ requestId: 'r1', kind: 'ping' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('BRIDGE_UNAUTHORIZED');
  });

  it('accepts the correct bearer token and dispatches ping', async () => {
    const res = await request(app)
      .post('/api/bridge/exchange')
      .set('Authorization', `Bearer ${FIXED_TOKEN}`)
      .send({ requestId: 'r1', kind: 'ping' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      requestId: 'r1',
      data: { pong: true, serverVersion: VERSION, protocolVersion: '1.2', transport: 'localhost', disabledFeatures: [] },
    });
  });
});

describe('POST /api/bridge/exchange — contract validation', () => {
  it('rejects a payload that fails the SfdtRequest validator', async () => {
    const res = await request(app)
      .post('/api/bridge/exchange')
      .set('Authorization', `Bearer ${FIXED_TOKEN}`)
      .send({ requestId: 'r1', kind: 'rollback', flowId: '301AB' /* no toVersion */ });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('REQUEST_INVALID');
  });

  it('echoes requestId back even on validation failure', async () => {
    const res = await request(app)
      .post('/api/bridge/exchange')
      .set('Authorization', `Bearer ${FIXED_TOKEN}`)
      .send({ requestId: 'echo-me', kind: 'compare', left: 'a' /* no right */ });
    expect(res.body.requestId).toBe('echo-me');
  });
});

describe('POST /api/bridge/exchange — dispatch', () => {
  it('returns NOT_IMPLEMENTED for kinds still pending implementation (ai)', async () => {
    const res = await request(app)
      .post('/api/bridge/exchange')
      .set('Authorization', `Bearer ${FIXED_TOKEN}`)
      .send({ requestId: 'r2', kind: 'ai', prompt: 'hello' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBe('NOT_IMPLEMENTED');
    expect(res.body.requestId).toBe('r2');
  });

  it('returns the version for the version kind', async () => {
    const res = await request(app)
      .post('/api/bridge/exchange')
      .set('Authorization', `Bearer ${FIXED_TOKEN}`)
      .send({ requestId: 'r3', kind: 'version' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      requestId: 'r3',
      data: { version: VERSION },
    });
  });

  it('returns null snapshots for org-health when no logs exist', async () => {
    const res = await request(app)
      .post('/api/bridge/exchange')
      .set('Authorization', `Bearer ${FIXED_TOKEN}`)
      .send({ requestId: 'oh1', kind: 'org-health' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toEqual({ audit: null, monitor: null });
  });

  it('returns the latest audit and monitor snapshots for org-health', async () => {
    const fs = (await import('fs-extra')).default;
    const isSnap = (p) => typeof p === 'string' && /(audit|monitor)-latest\.json$/.test(p);
    fs.pathExists.mockImplementation(async (p) => isSnap(p) || p.endsWith('/.sfdt/bridge-token'));
    fs.readJson.mockImplementation(async (p) => {
      if (p.endsWith('audit-latest.json')) return { timestamp: 't-a', org: 'dev', checks: [{ id: 'mfa' }], summary: {} };
      if (p.endsWith('monitor-latest.json')) return { timestamp: 't-m', org: 'dev', checks: [{ id: 'limits' }], summary: {} };
      return {};
    });
    try {
      const res = await request(app)
        .post('/api/bridge/exchange')
        .set('Authorization', `Bearer ${FIXED_TOKEN}`)
        .send({ requestId: 'oh2', kind: 'org-health' });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data.audit).toMatchObject({ timestamp: 't-a', data: { org: 'dev' } });
      expect(res.body.data.monitor).toMatchObject({ timestamp: 't-m', data: { org: 'dev' } });
    } finally {
      // Restore the default suffix-based mocks for subsequent tests.
      fs.pathExists.mockImplementation(async (p) => typeof p === 'string' && p.endsWith('/.sfdt/bridge-token'));
      fs.readJson.mockResolvedValue({});
    }
  });

  it('runs flow-core for the quality kind and returns a score', async () => {
    // Phase 5: the bridge now wires `quality` through to @sfdt/flow-core.
    // The contract field is named `flowXml` for the eventual file-path
    // shape; for now we ship JSON-stringified Tooling-API Metadata.
    const flowMetadata = {
      label: 'Demo',
      description: 'present',
      apiVersion: 60,
      processType: 'Flow',
      assignments: [{ name: 'A', label: 'Set', description: 'present' }],
    };
    const res = await request(app)
      .post('/api/bridge/exchange')
      .set('Authorization', `Bearer ${FIXED_TOKEN}`)
      .send({
        requestId: 'r4',
        kind: 'quality',
        flowXml: JSON.stringify(flowMetadata),
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.requestId).toBe('r4');
    expect(res.body.data.overallScore).toBe(100);
    expect(res.body.data.rating).toBe('Excellent');
  });

  it('accepts a legitimate 300 KB flowXml payload (above Express default but under MAX_FLOW_XML_BYTES)', async () => {
    // Express's default body limit is 100 KB; the bridge mounts a 6 MB
    // parser on /api/bridge so realistic Flow.Metadata (200–800 KB)
    // reaches the handler. This test exists to prevent a regression that
    // would silently truncate complex flows.
    const flow = {
      label: 'Big',
      description: 'present',
      apiVersion: 60,
      processType: 'Flow',
      // pad with assignments to push the payload well over the 100 KB Express default
      assignments: Array.from({ length: 5000 }, (_, i) => ({
        name: `A_${i}`,
        label: 'Set',
        description: 'present',
      })),
    };
    const flowXml = JSON.stringify(flow);
    expect(flowXml.length).toBeGreaterThan(150_000); // sanity: well above 100 KB
    const res = await request(app)
      .post('/api/bridge/exchange')
      .set('Authorization', `Bearer ${FIXED_TOKEN}`)
      .send({ requestId: 'r-300k', kind: 'quality', flowXml });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('rejects an over-the-5MB-cap flowXml at the route guard (REQUEST_INVALID, not Express 413)', async () => {
    // 6 MB string — above MAX_FLOW_XML_BYTES (5 MB) but under the express.json
    // limit (6 MB) so the route guard is what fires, not the body parser.
    const oversized = '"' + 'a'.repeat(5 * 1024 * 1024 + 1024) + '"';
    const res = await request(app)
      .post('/api/bridge/exchange')
      .set('Authorization', `Bearer ${FIXED_TOKEN}`)
      .send({ requestId: 'r-big', kind: 'quality', flowXml: oversized });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBe('REQUEST_INVALID');
    expect(res.body.error).toMatch(/exceeds/i);
  });

  it('returns REQUEST_INVALID when flowXml is not valid JSON', async () => {
    const res = await request(app)
      .post('/api/bridge/exchange')
      .set('Authorization', `Bearer ${FIXED_TOKEN}`)
      .send({ requestId: 'r5', kind: 'quality', flowXml: '<Flow/>' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBe('REQUEST_INVALID');
  });
});

describe('POST /api/bridge/exchange — telemetry.snapshot dispatch', () => {
  // The bridge resolves the snapshot file against the projectRoot threaded
  // through mountBridgeRoutes (MOCK_CONFIG._projectRoot === '/project'), and
  // fs-extra.outputJson is mocked at the top of this file — no real disk I/O
  // happens, so no temp dir or chdir is required.

  it('writes a snapshot to .sfdt/telemetry-snapshot.json and echoes the path back', async () => {
    outputJsonSpy.mockClear();
    const res = await request(app)
      .post('/api/bridge/exchange')
      .set('Authorization', `Bearer ${FIXED_TOKEN}`)
      .send({
        requestId: 'tel-1',
        kind: 'telemetry.snapshot',
        monthKey: '2026-05',
        counters: {
          'canvas-search': { activated: 3, errored: 0, disabled_remote: 0 },
          'flow-deploy': { activated: 1, errored: 1, disabled_remote: 0 },
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.requestId).toBe('tel-1');
    expect(res.body.data.writtenTo).toContain('telemetry-snapshot.json');
    expect(outputJsonSpy).toHaveBeenCalledOnce();
    const [file, payload] = outputJsonSpy.mock.calls[0];
    expect(file).toContain('.sfdt/telemetry-snapshot.json');
    expect(payload.monthKey).toBe('2026-05');
    expect(payload.counters['canvas-search'].activated).toBe(3);
    expect(payload.writtenAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('returns REQUEST_INVALID when monthKey does not match YYYY-MM', async () => {
    const res = await request(app)
      .post('/api/bridge/exchange')
      .set('Authorization', `Bearer ${FIXED_TOKEN}`)
      .send({
        requestId: 'tel-2',
        kind: 'telemetry.snapshot',
        monthKey: 'May 2026',
        counters: {},
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('REQUEST_INVALID');
  });

  it('returns REQUEST_INVALID when a counter has a non-number field', async () => {
    const res = await request(app)
      .post('/api/bridge/exchange')
      .set('Authorization', `Bearer ${FIXED_TOKEN}`)
      .send({
        requestId: 'tel-3',
        kind: 'telemetry.snapshot',
        monthKey: '2026-05',
        counters: { 'canvas-search': { activated: 'three', errored: 0, disabled_remote: 0 } },
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('REQUEST_INVALID');
  });
});

describe('GET /api/bridge/ping — disabledFeatures wiring', () => {
  // Integration test: build a fresh app whose projectRoot points at a temp
  // dir, write a real .sfdt/feature-flags.json there, and assert the disabled
  // array flows through. The bridge resolves feature-flags.json against the
  // explicit projectRoot passed to mountBridgeRoutes (NOT process.cwd()), so
  // each case stands up its own app instance scoped to its temp dir.
  let tmp;
  let localApp;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'sfdt-bridge-ff-'));
    await mkdir(join(tmp, '.sfdt'), { recursive: true });
    localApp = createGuiApp(
      { ...MOCK_CONFIG, _projectRoot: tmp, _configDir: join(tmp, '.sfdt') },
      VERSION,
      PORT,
    );
  });
  afterEach(async () => {
    await localApp?.cleanup?.();
    await rm(tmp, { recursive: true, force: true });
  });

  it('returns the disabled list on GET /api/bridge/ping', async () => {
    await writeFile(
      join(tmp, '.sfdt', 'feature-flags.json'),
      JSON.stringify({ disabled: ['canvas-search', 'flow-deploy'] }),
    );
    const res = await request(localApp).get('/api/bridge/ping');
    expect(res.status).toBe(200);
    expect(res.body.data.disabledFeatures).toEqual(['canvas-search', 'flow-deploy']);
  });

  it('exchange ping kind also returns disabledFeatures', async () => {
    await writeFile(
      join(tmp, '.sfdt', 'feature-flags.json'),
      JSON.stringify({ disabled: ['canvas-search'] }),
    );
    const res = await request(localApp)
      .post('/api/bridge/exchange')
      .set('Authorization', `Bearer ${FIXED_TOKEN}`)
      .send({ requestId: 'r-ff', kind: 'ping' });
    expect(res.status).toBe(200);
    expect(res.body.data.disabledFeatures).toEqual(['canvas-search']);
  });

  it('returns [] when .sfdt/feature-flags.json contains malformed JSON', async () => {
    await writeFile(join(tmp, '.sfdt', 'feature-flags.json'), '{ this is not json');
    const res = await request(localApp).get('/api/bridge/ping');
    expect(res.status).toBe(200);
    expect(res.body.data.disabledFeatures).toEqual([]);
  });
});

describe('POST /api/flow/quality (direct endpoint)', () => {
  it('returns a flow-core report for valid metadata', async () => {
    const csrf = (await request(app).get('/api/csrf-token')).body.token;
    const res = await request(app)
      .post('/api/flow/quality')
      .set('X-SFDT-CSRF', csrf)
      .send({
        metadata: {
          label: 'Standalone',
          description: 'present',
          apiVersion: 60,
          processType: 'Flow',
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.summary.overallScore).toBe(100);
    expect(res.body.meta.flowLabel).toBe('Standalone');
  });

  it('returns 400 when metadata is missing or not an object', async () => {
    const csrf = (await request(app).get('/api/csrf-token')).body.token;
    const res = await request(app)
      .post('/api/flow/quality')
      .set('X-SFDT-CSRF', csrf)
      .send({ metadata: 'not an object' });
    expect(res.status).toBe(400);
  });
});
