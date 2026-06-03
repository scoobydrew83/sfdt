/**
 * Additional route tests for gui-server.js — round 4.
 * Covers: /api/health, /api/project, /api/check-updates,
 *         /api/changelog/generate (AI unavailable),
 *         /api/release-notes/generate (AI unavailable).
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../../src/lib/log-writer.js', () => ({
  writeLog: vi.fn(),
  parseSfdtLogLines: vi.fn().mockReturnValue({ checks: [], components: [] }),
  readLatestLog: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/lib/update-checker.js', async (importActual) => ({
  ...(await importActual()),
  fetchLatestVersion: vi.fn().mockResolvedValue('1.0.0'),
}));

vi.mock('../../src/lib/config-utils.js', () => ({
  setNestedValue: vi.fn(),
  coerceConfigValue: vi.fn((v) => v),
}));

vi.mock('../../src/lib/config.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({
    _projectRoot: '/project',
    _configDir: '/project/.sfdt',
    projectName: 'Test Project',
    defaultOrg: 'dev',
    sourceApiVersion: '59.0',
    features: { ai: false },
  }),
  getConfigDir: vi.fn().mockReturnValue('/project/.sfdt'),
}));

vi.mock('fs-extra', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(false),
    pathExists: vi.fn().mockResolvedValue(false),
    readJson: vi.fn().mockResolvedValue({}),
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
  execa: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
}));

// ─── Imports ────────────────────────────────────────────────────────────────

import request from 'supertest';
import { createGuiApp } from '../../src/lib/gui-server/index.js';
import { fetchLatestVersion } from '../../src/lib/update-checker.js';

// ─── Shared config ───────────────────────────────────────────────────────────

const MOCK_CONFIG = {
  _projectRoot: '/project',
  _configDir: '/project/.sfdt',
  projectName: 'My SF Project',
  defaultOrg: 'dev',
  sourceApiVersion: '59.0',
  defaultSourcePath: 'force-app/main/default',
  manifestDir: 'manifest/release',
  releaseNotesDir: 'release-notes',
  logDir: '/project/logs',
  features: { ai: false },
  deployment: { coverageThreshold: 80 },
};

const VERSION = '1.2.3';
const PORT = 7654;

// ─── Reset mocks between tests ───────────────────────────────────────────────
beforeEach(async () => {
  vi.resetAllMocks();
  const { default: fsMock } = await import('fs-extra');
  fsMock.existsSync.mockReturnValue(false);
  fsMock.pathExists.mockResolvedValue(false);
  fsMock.readJson.mockResolvedValue({});
  fsMock.readdir.mockResolvedValue([]);
  fsMock.readFile.mockResolvedValue('');
  fsMock.outputJson.mockResolvedValue(undefined);
  fsMock.stat.mockResolvedValue({ mtime: new Date(), size: 0, isDirectory: () => false });
  fsMock.remove.mockResolvedValue(undefined);
  fsMock.ensureDir.mockResolvedValue(undefined);
  fsMock.writeFile.mockResolvedValue(undefined);
  fsMock.writeJson.mockResolvedValue(undefined);
  vi.mocked(fetchLatestVersion).mockResolvedValue('1.0.0');
});

// ─── GET /api/health ─────────────────────────────────────────────────────────

describe('GET /api/health', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns ok: true with a timestamp', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.timestamp).toBe('string');
  });
});

// ─── GET /api/project ────────────────────────────────────────────────────────

describe('GET /api/project', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns project metadata from config', async () => {
    const res = await request(app).get('/api/project');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('My SF Project');
    expect(res.body.org).toBe('dev');
    expect(res.body.apiVersion).toBe('59.0');
    expect(res.body.coverageThreshold).toBe(80);
    expect(res.body.version).toBe(VERSION);
    expect(res.body.features).toEqual({ ai: false });
  });
});

// ─── GET /api/check-updates ──────────────────────────────────────────────────

describe('GET /api/check-updates', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns current and latest version with updateAvailable flag when newer', async () => {
    vi.mocked(fetchLatestVersion).mockResolvedValue('2.0.0');

    const res = await request(app).get('/api/check-updates');
    expect(res.status).toBe(200);
    expect(res.body.current).toBe(VERSION);
    expect(res.body.latest).toBe('2.0.0');
    expect(res.body.updateAvailable).toBe(true);
  });

  it('returns updateAvailable false when already on latest version', async () => {
    vi.mocked(fetchLatestVersion).mockResolvedValue(VERSION);

    const res = await request(app).get('/api/check-updates');
    expect(res.status).toBe(200);
    expect(res.body.updateAvailable).toBe(false);
  });

  it('returns 502 when fetchLatestVersion throws', async () => {
    vi.mocked(fetchLatestVersion).mockRejectedValue(new Error('network error'));

    const res = await request(app).get('/api/check-updates');
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/network error/);
  });
});

// ─── POST /api/changelog/generate — AI unavailable ──────────────────────────

describe('POST /api/changelog/generate — AI unavailable', () => {
  let app;

  beforeAll(() => {
    // config with ai=false → isAiAvailable returns false immediately
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('sends SSE error event and ends stream when AI is not available', async () => {
    const res = await request(app).post('/api/changelog/generate').send({});
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    // Response should contain SSE error event
    expect(res.text).toContain('"type":"error"');
    expect(res.text).toContain('AI is not available');
  });
});

// ─── POST /api/release-notes/generate — AI unavailable ──────────────────────

describe('POST /api/release-notes/generate — AI unavailable', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('sends SSE error event and ends stream when AI is not available', async () => {
    const res = await request(app).post('/api/release-notes/generate').send({});
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.text).toContain('"type":"error"');
    expect(res.text).toContain('AI is not available');
  });
});

// ─── GET /api/session/org ────────────────────────────────────────────────────

describe('GET /api/session/org', () => {
  let app;
  let csrf;

  beforeAll(async () => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
    csrf = (await request(app).get('/api/csrf-token')).body.token;
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns config defaultOrg when no session org is set', async () => {
    const res = await request(app).get('/api/session/org');
    expect(res.status).toBe(200);
    expect(res.body.org).toBe('dev');
  });

  it('returns session org after POST sets it', async () => {
    await request(app).post('/api/session/org').set('X-SFDT-CSRF', csrf).send({ org: 'staging' });
    const res = await request(app).get('/api/session/org');
    expect(res.status).toBe(200);
    expect(res.body.org).toBe('staging');
  });
});

// ─── POST /api/session/org ───────────────────────────────────────────────────

describe('POST /api/session/org', () => {
  let app;
  let csrf;

  beforeAll(async () => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
    csrf = (await request(app).get('/api/csrf-token')).body.token;
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('sets and returns the session org', async () => {
    const res = await request(app).post('/api/session/org').set('X-SFDT-CSRF', csrf).send({ org: 'DevHub' });
    expect(res.status).toBe(200);
    expect(res.body.org).toBe('DevHub');
  });

  it('returns 400 when org is missing', async () => {
    const res = await request(app).post('/api/session/org').set('X-SFDT-CSRF', csrf).send({});
    expect(res.status).toBe(400);
  });

  it('returns 400 when org is empty string', async () => {
    const res = await request(app).post('/api/session/org').set('X-SFDT-CSRF', csrf).send({ org: '  ' });
    expect(res.status).toBe(400);
  });
});
