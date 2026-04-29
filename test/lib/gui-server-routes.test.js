/**
 * Route-level integration tests for gui-server.js.
 *
 * Uses supertest to make HTTP requests against the Express app returned by
 * createGuiApp() without binding to a real port.
 *
 * All heavy dependencies are mocked at the top so no real file I/O, shell
 * execution, or network calls occur.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

// ─── Mock all heavy dependencies before any imports ────────────────────────

vi.mock('../../src/lib/log-writer.js', () => ({
  writeLog: vi.fn(),
  parseSfdtLogLines: vi.fn().mockReturnValue({ checks: [], components: [] }),
  readLatestLog: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/lib/update-checker.js', () => ({
  fetchLatestVersion: vi.fn().mockResolvedValue('1.0.0'),
}));

vi.mock('../../src/lib/config-utils.js', () => ({
  setNestedValue: vi.fn(),
  coerceConfigValue: vi.fn((v) => v),
}));

vi.mock('fs-extra', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(false),
    pathExists: vi.fn().mockResolvedValue(false),
    readJson: vi.fn().mockResolvedValue({}),
    readdir: vi.fn().mockResolvedValue([]),
    readFile: vi.fn().mockResolvedValue(''),
    outputJson: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ mtime: new Date(), size: 0 }),
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
import { createGuiApp } from '../../src/lib/gui-server.js';

// ─── Shared config ──────────────────────────────────────────────────────────

const MOCK_CONFIG = {
  _projectRoot: '/project',
  _configDir: '/project/.sfdt',
  projectName: 'Test Project',
  defaultOrg: 'dev',
  sourceApiVersion: '59.0',
  defaultSourcePath: 'force-app/main/default',
  manifestDir: 'manifest/release',
  releaseNotesDir: 'release-notes',
  logDir: '/project/logs',
  features: { ai: false },
};

const VERSION = '0.0.0';
const PORT = 7654;

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('GET /api/health', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns 200 with ok and timestamp', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.timestamp).toBe('string');
  });
});

describe('GET /api/project', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns 200 with project info', async () => {
    const res = await request(app).get('/api/project');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Test Project');
    expect(res.body.org).toBe('dev');
    expect(res.body.apiVersion).toBe('59.0');
    expect(res.body.version).toBe(VERSION);
    expect(typeof res.body.features).toBe('object');
  });

  it('returns coverageThreshold with default 75 when not set', async () => {
    const res = await request(app).get('/api/project');
    expect(res.status).toBe(200);
    expect(res.body.coverageThreshold).toBe(75);
  });

  it('uses fallback name when projectName is absent', async () => {
    const noNameConfig = { ...MOCK_CONFIG, projectName: undefined };
    const a = createGuiApp(noNameConfig, VERSION, PORT);
    const res = await request(a).get('/api/project');
    expect(res.body.name).toBe('Salesforce Project');
    await a.cleanup?.();
  });
});

describe('GET /api/config', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns 200 and an object when config file is readable', async () => {
    const { default: fsMock } = await import('fs-extra');
    fsMock.readJson.mockResolvedValueOnce({ projectName: 'Test Project', defaultOrg: 'dev' });

    const res = await request(app).get('/api/config');
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
  });

  it('returns 503 when _configDir is absent', async () => {
    const noConfigDirConfig = { ...MOCK_CONFIG, _configDir: undefined };
    const a = createGuiApp(noConfigDirConfig, VERSION, PORT);
    const res = await request(a).get('/api/config');
    expect(res.status).toBe(503);
    await a.cleanup?.();
  });

  it('returns 500 when readJson throws', async () => {
    const { default: fsMock } = await import('fs-extra');
    fsMock.readJson.mockRejectedValueOnce(new Error('ENOENT: no such file'));

    const res = await request(app).get('/api/config');
    expect(res.status).toBe(500);
    expect(res.body.error).toBeTruthy();
  });
});

describe('GET /api/test-runs', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns 200 with empty runs array when no log dir exists', async () => {
    const res = await request(app).get('/api/test-runs');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.runs)).toBe(true);
    expect(res.body.runs).toHaveLength(0);
  });
});

describe('GET /api/preflight', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns 200 with empty object when no preflight log exists', async () => {
    const res = await request(app).get('/api/preflight');
    expect(res.status).toBe(200);
    // readLatestLog is mocked to return null; readPreflight falls back to {}
    expect(typeof res.body).toBe('object');
  });

  it('returns shaped data when readLatestLog returns a preflight log', async () => {
    const { readLatestLog } = await import('../../src/lib/log-writer.js');
    readLatestLog.mockResolvedValueOnce({
      timestamp: '2026-04-28T00:00:00.000Z',
      data: {
        status: 'PASS',
        checks: [{ name: 'git', status: 'PASS', message: 'ok' }],
      },
    });

    const res = await request(app).get('/api/preflight');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('PASS');
    expect(Array.isArray(res.body.checks)).toBe(true);
    expect(res.body.checks[0].name).toBe('git');
  });
});

describe('GET /api/drift', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns 200 with empty object when no drift log exists', async () => {
    const res = await request(app).get('/api/drift');
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
  });

  it('returns shaped data when readLatestLog returns a drift log', async () => {
    const { readLatestLog } = await import('../../src/lib/log-writer.js');
    readLatestLog.mockResolvedValueOnce({
      timestamp: '2026-04-28T00:00:00.000Z',
      data: {
        status: 'drift',
        components: [{ name: 'MyClass', type: 'ApexClass', drift: 'Modified' }],
      },
    });

    const res = await request(app).get('/api/drift');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('drift');
    expect(Array.isArray(res.body.components)).toBe(true);
  });
});

describe('GET /api/deploy/history', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns 200 with empty history array when no deploy-history file exists', async () => {
    const { default: fsMock } = await import('fs-extra');
    // readJson catches its own error internally — mock it to throw to hit the .catch(() => []) path
    fsMock.readJson.mockRejectedValueOnce(new Error('ENOENT'));

    const res = await request(app).get('/api/deploy/history');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.history)).toBe(true);
  });

  it('returns history array from file when present', async () => {
    const { default: fsMock } = await import('fs-extra');
    fsMock.readJson.mockResolvedValueOnce([
      { date: '2026-04-28T00:00:00.000Z', manifest: 'rl-1.0.0-package.xml', org: 'prod', dryRun: false, exitCode: 0 },
    ]);

    const res = await request(app).get('/api/deploy/history');
    expect(res.status).toBe(200);
    expect(res.body.history).toHaveLength(1);
    expect(res.body.history[0].org).toBe('prod');
  });
});

describe('GET /api/check-updates', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns 200 with current, latest, and updateAvailable', async () => {
    const res = await request(app).get('/api/check-updates');
    expect(res.status).toBe(200);
    expect(res.body.current).toBe(VERSION);
    expect(typeof res.body.latest).toBe('string');
    expect(typeof res.body.updateAvailable).toBe('boolean');
  });

  it('sets updateAvailable true when latest differs from current', async () => {
    const { fetchLatestVersion } = await import('../../src/lib/update-checker.js');
    fetchLatestVersion.mockResolvedValueOnce('9.9.9');

    const res = await request(app).get('/api/check-updates');
    expect(res.status).toBe(200);
    expect(res.body.latest).toBe('9.9.9');
    expect(res.body.updateAvailable).toBe(true);
  });

  it('returns 502 when fetchLatestVersion throws', async () => {
    const { fetchLatestVersion } = await import('../../src/lib/update-checker.js');
    fetchLatestVersion.mockRejectedValueOnce(new Error('network error'));

    const res = await request(app).get('/api/check-updates');
    expect(res.status).toBe(502);
    expect(res.body.error).toBeTruthy();
  });
});

describe('GET /api/manifests', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns 200 with empty manifests array when directories are empty', async () => {
    const res = await request(app).get('/api/manifests');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.manifests)).toBe(true);
  });
});

describe('GET /api/compare', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns 200 with empty object when no compare result exists', async () => {
    // readJson is mocked to return {} by default (tryReadJson returns null on ENOENT — but mock returns {})
    const res = await request(app).get('/api/compare');
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
  });
});

describe('Origin guard', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('allows requests without an Origin header (same-origin GET from React app)', async () => {
    // No Origin header is set — should pass the guard
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
  });

  it('returns 403 for requests with a disallowed Origin', async () => {
    const res = await request(app)
      .get('/api/health')
      .set('Origin', 'http://evil.example.com');
    expect(res.status).toBe(403);
  });

  it('allows requests with a matching localhost Origin', async () => {
    const res = await request(app)
      .get('/api/health')
      .set('Origin', `http://localhost:${PORT}`);
    expect(res.status).toBe(200);
  });
});

describe('GET /api/logs', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns 200 with empty logs array when log dirs are absent', async () => {
    const res = await request(app).get('/api/logs');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.logs)).toBe(true);
  });

  it('accepts a type query param without erroring', async () => {
    const res = await request(app).get('/api/logs?type=preflight');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.logs)).toBe(true);
  });
});
