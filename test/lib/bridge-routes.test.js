import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
const FIXED_TOKEN = 'test-bridge-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TOKEN_PATH_SUFFIX = '/.sfdt/bridge-token';
const isTokenPath = (p) => typeof p === 'string' && p.endsWith(TOKEN_PATH_SUFFIX);
vi.mock('fs-extra', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(false),
    pathExists: vi.fn(async (p) => isTokenPath(p)),
    readJson: vi.fn().mockResolvedValue({}),
    readdir: vi.fn().mockResolvedValue([]),
    readFile: vi.fn(async (p) => (isTokenPath(p) ? `${FIXED_TOKEN}\n` : '')),
    outputJson: vi.fn().mockResolvedValue(undefined),
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
vi.mock('../../src/lib/update-checker.js', () => ({
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
      data: { pong: true, serverVersion: VERSION, transport: 'localhost', disabledFeatures: [] },
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
      .set('Origin', 'chrome-extension://abcdef0123456789')
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'authorization, content-type');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('chrome-extension://abcdef0123456789');
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
      data: { pong: true, serverVersion: VERSION, transport: 'localhost', disabledFeatures: [] },
    });
  });
});
describe('POST /api/bridge/exchange — contract validation', () => {
  it('rejects a payload that fails the SfdtRequest validator', async () => {
    const res = await request(app)
      .post('/api/bridge/exchange')
      .set('Authorization', `Bearer ${FIXED_TOKEN}`)
      .send({ requestId: 'r1', kind: 'rollback', flowId: '301AB'  });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('REQUEST_INVALID');
  });
  it('echoes requestId back even on validation failure', async () => {
    const res = await request(app)
      .post('/api/bridge/exchange')
      .set('Authorization', `Bearer ${FIXED_TOKEN}`)
      .send({ requestId: 'echo-me', kind: 'compare', left: 'a'  });
    expect(res.body.requestId).toBe('echo-me');
  });
});
describe('POST /api/bridge/exchange — dispatch', () => {
  it('returns NOT_IMPLEMENTED for kinds still pending implementation (drift)', async () => {
    const res = await request(app)
      .post('/api/bridge/exchange')
      .set('Authorization', `Bearer ${FIXED_TOKEN}`)
      .send({ requestId: 'r2', kind: 'drift', component: 'Flow:X' });
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
  it('runs flow-core for the quality kind and returns a score', async () => {
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
describe('POST /api/flow/quality (direct endpoint)', () => {
  it('returns a flow-core report for valid metadata', async () => {
    const res = await request(app)
      .post('/api/flow/quality')
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
    const res = await request(app)
      .post('/api/flow/quality')
      .send({ metadata: 'not an object' });
    expect(res.status).toBe(400);
  });
});
