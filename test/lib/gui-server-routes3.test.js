/**
 * Additional route tests for gui-server.js — round 3.
 * Focuses on SSE routes with validation paths and more API coverage.
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

// ─── Reset mocks between tests ───────────────────────────────────────────────
// vi.resetAllMocks() clears the Once queue AND implementations. Re-setup defaults here.
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
  // Reset log-writer and other mocks to their module-level defaults
  const { readLatestLog } = await import('../../src/lib/log-writer.js');
  vi.mocked(readLatestLog).mockResolvedValue(null);
});

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

// ─── POST /api/pull (SSE — validation paths) ─────────────────────────────────

describe('POST /api/pull — SSE validation', () => {
  let app;
  let csrf;

  beforeAll(async () => {
    // Config without defaultOrg to trigger the "no org" path
    const noOrgConfig = { ...MOCK_CONFIG, defaultOrg: '' };
    app = createGuiApp(noOrgConfig, VERSION, PORT);
    csrf = (await request(app).get('/api/csrf-token')).body.token;
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('sends error SSE event when no org is configured and no targetOrg param', async () => {
    const res = await request(app)
      .post('/api/pull')
      .set('X-SFDT-CSRF', csrf)
      .send({});
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.text).toContain('No target org configured');
  });
});

describe('POST /api/pull — invalid org alias', () => {
  let app;
  let csrf;

  beforeAll(async () => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
    csrf = (await request(app).get('/api/csrf-token')).body.token;
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('sends error SSE event when org alias contains invalid characters', async () => {
    const res = await request(app)
      .post('/api/pull')
      .set('X-SFDT-CSRF', csrf)
      .send({ targetOrg: '; rm -rf' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.text).toContain('Invalid org alias');
  });
});

describe('POST /api/flow/scan — invalid org alias', () => {
  let app;
  let csrf;

  beforeAll(async () => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
    csrf = (await request(app).get('/api/csrf-token')).body.token;
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns 400 when org alias contains invalid characters', async () => {
    const res = await request(app)
      .post('/api/flow/scan')
      .set('X-SFDT-CSRF', csrf)
      .send({ org: '-target=evil' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid org alias/);
  });

  it('returns 400 when org is missing', async () => {
    const res = await request(app)
      .post('/api/flow/scan')
      .set('X-SFDT-CSRF', csrf)
      .send({});
    expect(res.status).toBe(400);
  });
});

// ─── POST /api/init (already initialized) ────────────────────────────────────

describe('POST /api/init — already initialized', () => {
  let app;

  beforeAll(() => {
    // Config WITH a configDir means already initialized
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns 409 when project is already initialized', async () => {
    const res = await request(app)
      .post('/api/init')
      .send({ projectName: 'New Project', defaultOrg: 'org' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already initialized/i);
  });
});

// ─── DELETE /api/test-runs/:filename ──────────────────────────────────────────

describe('DELETE /api/test-runs/:filename', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes a valid log file', async () => {
    const fsMock = await import('fs-extra');
    fsMock.default.pathExists.mockResolvedValueOnce(true);

    const res = await request(app)
      .delete('/api/test-runs/my-test-run.json')
      .set('Authorization', `Bearer ${app.launchToken}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(fsMock.default.remove).toHaveBeenCalled();
  });

  it('rejects path traversal attempts', async () => {
    // Note: express router naturally blocks / in params by 404ing
    // So we test encoded slashes or backslashes which would make it into the parameter
    const maliciousPaths = [
      '..%5Ctest-runs%5Cmy-test-run.json', // ..\test-runs\my-test-run.json
      '%2e%2e%2fmy-test-run.json', // ../my-test-run.json
      'subdir%2fmy-test-run.json', // subdir/my-test-run.json
      '..%2fmy-test-run.json' // ../my-test-run.json
    ];

    for (const p of maliciousPaths) {
      const res = await request(app)
        .delete(`/api/test-runs/${p}`) // already URI encoded in the strings above for slashes
        .set('Authorization', `Bearer ${app.launchToken}`);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid filename');
    }
  });

  it('returns 404 for non-existent file', async () => {
    const fsMock = await import('fs-extra');
    fsMock.default.pathExists.mockResolvedValueOnce(false);

    const res = await request(app)
      .delete('/api/test-runs/non-existent.json')
      .set('Authorization', `Bearer ${app.launchToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not found');
  });

  it('rejects non-json files', async () => {
    const res = await request(app)
      .delete('/api/test-runs/not-json.txt')
      .set('Authorization', `Bearer ${app.launchToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid filename');
  });
});

// ─── GET /api/test-runs (with data) ──────────────────────────────────────────

describe('GET /api/test-runs with test results directory', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns 200 with runs from test-results directory', async () => {
    const { default: fsMock } = await import('fs-extra');
    // pathExists for test-results dir returns true, then readdir returns files
    fsMock.pathExists.mockResolvedValueOnce(true);
    fsMock.readdir.mockResolvedValueOnce(['run-001.json', 'run-002.json', 'latest.json']);
    // readJson for each file
    fsMock.readJson
      .mockResolvedValueOnce({
        schemaVersion: '1',
        type: 'test-run',
        timestamp: '2026-05-01T00:00:00Z',
        durationMs: 5000,
        data: { passed: 10, failed: 0, errors: 0, coverage: 85.5 },
      })
      .mockResolvedValueOnce({
        schemaVersion: '1',
        type: 'test-run',
        timestamp: '2026-05-02T00:00:00Z',
        durationMs: 6000,
        data: { passed: 12, failed: 1, errors: 0, coverage: 80.0 },
      });

    const res = await request(app).get('/api/test-runs');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.runs)).toBe(true);
    expect(res.body.runs.length).toBeGreaterThan(0);
    expect(res.body.runs[0].passed).toBe(10);
  });
});

// ─── GET /api/preflight (with data from readLatestLog) ───────────────────────

describe('GET /api/preflight with data', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns shaped preflight with normalized null messages', async () => {
    const { readLatestLog } = await import('../../src/lib/log-writer.js');
    vi.mocked(readLatestLog).mockResolvedValueOnce({
      timestamp: '2026-05-01T00:00:00Z',
      data: {
        status: 'PASS',
        checks: [
          { name: 'git', status: 'PASS', message: '' },
          { name: 'changelog', status: 'WARN', message: 'Missing entry' },
        ],
      },
    });

    const res = await request(app).get('/api/preflight');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('PASS');
    expect(res.body.checks[0].message).toBeNull(); // empty → null normalization
    expect(res.body.checks[1].message).toBe('Missing entry');
  });
});

// ─── GET /api/drift (with data) ───────────────────────────────────────────────

describe('GET /api/drift with data', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns shaped drift data', async () => {
    const { readLatestLog } = await import('../../src/lib/log-writer.js');
    vi.mocked(readLatestLog).mockResolvedValueOnce({
      timestamp: '2026-05-01T00:00:00Z',
      data: {
        status: 'no-drift',
        components: [],
      },
    });

    const res = await request(app).get('/api/drift');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('no-drift');
    expect(Array.isArray(res.body.components)).toBe(true);
  });
});

// ─── GET /api/quality (with data from readLatestLog) ─────────────────────────

describe('GET /api/quality with data', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns quality data from log', async () => {
    const { readLatestLog } = await import('../../src/lib/log-writer.js');
    vi.mocked(readLatestLog).mockResolvedValueOnce({
      timestamp: '2026-05-01T00:00:00Z',
      data: {
        status: 'FAIL',
        summary: { critical: 1, high: 2, medium: 3, low: 4 },
        violations: [{ file: 'MyClass.cls', line: 5, rule: 'NoPM', severity: 1, message: 'Bad' }],
      },
    });

    const res = await request(app).get('/api/quality');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('FAIL');
    expect(res.body.summary.critical).toBe(1);
  });
});

// ─── GET /api/manifests with files ───────────────────────────────────────────

describe('GET /api/manifests with files present', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns manifests list when XML files are present', async () => {
    const { default: fsMock } = await import('fs-extra');
    // flat layout → readdir called twice: logDir (compare files), then release dir
    fsMock.readdir
      .mockResolvedValueOnce([]) // log files
      .mockResolvedValueOnce(['rl-1.0.0-package.xml', 'rl-0.9.0-package.xml']); // release manifests

    fsMock.stat.mockResolvedValue({ mtime: new Date('2026-05-01'), size: 1024, isDirectory: () => false });

    const res = await request(app).get('/api/manifests');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.manifests)).toBe(true);
    expect(res.body.manifests.length).toBeGreaterThan(0);
    expect(res.body.manifests[0].name).toBe('rl-1.0.0-package.xml');
  });
});

// ─── GET /api/manifests — subpath layout excludes deploy/ and deployed/ ───────

describe('GET /api/manifests — subpath excludes deploy/ and deployed/', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp({ ...MOCK_CONFIG, manifestLayout: 'subpath' }, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('lists only real package subdirs, not deploy/ or deployed/ artifacts', async () => {
    const { default: fsMock } = await import('fs-extra');
    fsMock.readdir
      .mockResolvedValueOnce([]) // logDir compare files
      .mockResolvedValueOnce([]) // release dir top-level xml
      .mockResolvedValueOnce(['all', 'deploy', 'deployed']) // subdirs
      .mockResolvedValueOnce(['rl-1.0.0-package.xml']); // files inside 'all' (deploy/deployed skipped, never read)

    // Every stat resolves as a directory; file entries just use mtime/size.
    fsMock.stat.mockResolvedValue({ mtime: new Date('2026-05-01'), size: 1024, isDirectory: () => true });

    const res = await request(app).get('/api/manifests');
    expect(res.status).toBe(200);
    const names = res.body.manifests.map((m) => m.name);
    expect(names).toEqual(['all/rl-1.0.0-package.xml']);
    expect(names.some((n) => n.startsWith('deploy/') || n.startsWith('deployed/'))).toBe(false);
  });
});

// ─── GET /api/logs with various types ────────────────────────────────────────

describe('GET /api/logs with filter types', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns 200 with deploy logs when type=deploy', async () => {
    const res = await request(app).get('/api/logs?type=deploy');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.logs)).toBe(true);
  });

  it('returns 200 with test logs when type=test', async () => {
    const res = await request(app).get('/api/logs?type=test');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.logs)).toBe(true);
  });

  it('returns 200 with quality logs when type=quality', async () => {
    const res = await request(app).get('/api/logs?type=quality');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.logs)).toBe(true);
  });

  it('returns deploy raw logs from deploy-results/ archive', async () => {
    const { default: fsMock } = await import('fs-extra');
    const { loadConfig } = await import('../../src/lib/config.js');
    vi.mocked(loadConfig).mockResolvedValue({
      ...MOCK_CONFIG,
      logDir: '/project/logs',
      logRetention: 50,
    });

    const fakeEnvelope = {
      schemaVersion: 'raw-1',
      type: 'deploy',
      timestamp: '2026-05-09T10:00:00Z',
      org: 'staging',
      exitCode: 0,
      durationMs: 5000,
      rawOutput: 'Deployment complete.',
    };

    fsMock.pathExists.mockResolvedValue(true);
    fsMock.readdir.mockResolvedValue(['2026-05-09T10-00-00Z-abc12.json']);
    fsMock.readJson.mockResolvedValue(fakeEnvelope);

    const app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
    const res = await request(app).get('/api/logs?type=deploy');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.logs)).toBe(true);
    const deployLogs = res.body.logs.filter((l) => l.type === 'deploy');
    expect(deployLogs).toHaveLength(1);
    expect(deployLogs[0]).toMatchObject({
      schemaVersion: 'raw-1',
      type: 'deploy',
      rawOutput: 'Deployment complete.',
    });
  });
});

// ─── GET /api/release/suggest-version with manifests ─────────────────────────

describe('GET /api/release/suggest-version with versioned manifests', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('increments patch version when versioned manifests exist', async () => {
    const { default: fsMock } = await import('fs-extra');
    fsMock.pathExists.mockResolvedValueOnce(true); // manifestDir exists
    fsMock.readdir
      .mockResolvedValueOnce(['rl-1.2.3-package.xml', 'rl-1.2.0-package.xml']) // manifestDir files
      .mockResolvedValueOnce(false); // deployed dir doesn't exist (pathExists returns false above)

    // The second readdir call is for deployedDir — pathExists is already false
    // Actually let me simplify: just mock pathExists for deployed to false
    fsMock.pathExists.mockResolvedValueOnce(false); // deployedDir

    const res = await request(app).get('/api/release/suggest-version');
    expect(res.status).toBe(200);
    expect(res.body.version).toBe('1.2.4');
  });
});

// ─── GET /api/test-runs — legacy formats ─────────────────────────────────────
// Each test gets its own app instance to avoid mock state bleed-through

describe('GET /api/test-runs — legacy raw.result format', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns run with passed/failed/coverage from raw.result', async () => {
    const { default: fsMock } = await import('fs-extra');
    fsMock.pathExists.mockResolvedValueOnce(true);
    fsMock.readdir.mockResolvedValueOnce(['run-legacy.json']);
    fsMock.readJson.mockResolvedValueOnce({
      result: {
        summary: { testStartTime: '2026-05-01', passing: 5, failing: 1, skipped: 0, testRunCoverage: '78%', testExecutionTimeInMs: 3000 },
        tests: [],
      },
    });

    const res = await request(app).get('/api/test-runs');
    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(1);
    expect(res.body.runs[0].passed).toBe(5);
    expect(res.body.runs[0].failed).toBe(1);
    expect(res.body.runs[0].coverage).toBeCloseTo(78);
  });
});

describe('GET /api/test-runs — legacy raw.summary format', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns run from raw.summary format', async () => {
    const { default: fsMock } = await import('fs-extra');
    fsMock.pathExists.mockResolvedValueOnce(true);
    fsMock.readdir.mockResolvedValueOnce(['run-summary.json']);
    fsMock.readJson.mockResolvedValueOnce({
      summary: { testStartTime: '2026-05-01', passing: 3, failing: 0, skipped: 0 },
    });

    const res = await request(app).get('/api/test-runs');
    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(1);
    expect(res.body.runs[0].passed).toBe(3);
  });
});

describe('GET /api/test-runs — legacy array format', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns run from legacy array format', async () => {
    const { default: fsMock } = await import('fs-extra');
    fsMock.pathExists.mockResolvedValueOnce(true);
    fsMock.readdir.mockResolvedValueOnce(['run-array.json']);
    fsMock.readJson.mockResolvedValueOnce([
      { outcome: 'Pass', testTimestamp: '2026-05-01T00:00:00Z' },
      { outcome: 'Fail', testTimestamp: '2026-05-01T00:00:00Z' },
      { outcome: 'Pass', testTimestamp: '2026-05-01T00:00:00Z' },
    ]);

    const res = await request(app).get('/api/test-runs');
    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(1);
    expect(res.body.runs[0].passed).toBe(2);
    expect(res.body.runs[0].failed).toBe(1);
  });
});

// ─── GET /api/preflight — legacy fallback ────────────────────────────────────

describe('GET /api/preflight — legacy file fallback', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('falls back to legacy preflight_*.json files when readLatestLog returns null', async () => {
    const { readLatestLog } = await import('../../src/lib/log-writer.js');
    vi.mocked(readLatestLog).mockResolvedValueOnce(null);

    const { default: fsMock } = await import('fs-extra');
    // safeReaddir for logDir returns a legacy file
    fsMock.readdir.mockResolvedValueOnce(['preflight_2026-05-01.json']);
    fsMock.readJson.mockResolvedValueOnce({
      status: 'PASS',
      checks: [{ name: 'git', status: 'PASS', message: '' }],
    });

    const res = await request(app).get('/api/preflight');
    expect(res.status).toBe(200);
  });
});

// ─── GET /api/drift — legacy fallback ────────────────────────────────────────

describe('GET /api/drift — legacy file fallback', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('falls back to legacy drift_*.json files when readLatestLog returns null', async () => {
    const { readLatestLog } = await import('../../src/lib/log-writer.js');
    vi.mocked(readLatestLog).mockResolvedValueOnce(null);

    const { default: fsMock } = await import('fs-extra');
    fsMock.readdir.mockResolvedValueOnce(['drift_2026-05-01.json']);
    fsMock.readJson.mockResolvedValueOnce({
      status: 'drift',
      components: [{ name: 'MyClass', type: 'ApexClass', drift: 'Modified' }],
    });

    const res = await request(app).get('/api/drift');
    expect(res.status).toBe(200);
  });
});

// ─── GET /api/logs — with actual log files ────────────────────────────────────

describe('GET /api/logs — with actual envelope files', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns structured log envelopes from archive directories', async () => {
    const { default: fsMock } = await import('fs-extra');
    // pathExists for preflight-results dir returns true
    fsMock.pathExists.mockResolvedValueOnce(true);
    fsMock.readdir.mockResolvedValueOnce(['preflight-2026-05-01.json']);
    fsMock.readJson.mockResolvedValueOnce({
      schemaVersion: '1',
      type: 'preflight',
      timestamp: '2026-05-01T00:00:00Z',
      data: { status: 'PASS', checks: [] },
    });

    const res = await request(app).get('/api/logs?type=preflight');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.logs)).toBe(true);
    expect(res.body.logs[0].schemaVersion).toBe('1');
  });
});
