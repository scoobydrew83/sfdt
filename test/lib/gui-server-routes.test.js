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

// ─── Security route tests ────────────────────────────────────────────────────

describe('PATCH /api/config — key injection guards', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('blocks mcp.salesforce.command (shell-executable key)', async () => {
    const res = await request(app)
      .patch('/api/config')
      .send({ key: 'mcp.salesforce.command', value: 'evil' });
    expect(res.status).toBe(403);
  });

  it('blocks mcp.salesforce.args (shell-executable key)', async () => {
    const res = await request(app)
      .patch('/api/config')
      .send({ key: 'mcp.salesforce.args', value: 'evil' });
    expect(res.status).toBe(403);
  });

  it('blocks keys nested under mcp.salesforce.command', async () => {
    const res = await request(app)
      .patch('/api/config')
      .send({ key: 'mcp.salesforce.command.sub', value: 'evil' });
    expect(res.status).toBe(403);
  });

  it('rejects missing key', async () => {
    const res = await request(app)
      .patch('/api/config')
      .send({ value: 'x' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/manifest/remove-component — deployed-path guard', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns 403 for a path inside the deployed/ subdirectory', async () => {
    const res = await request(app)
      .post('/api/manifest/remove-component')
      .send({ relPath: 'manifest/release/deployed/rl-1.0.0-package.xml', type: 'ApexClass', member: 'MyClass' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/read-only/i);
  });

  it('returns 400 for path traversal attempt', async () => {
    const res = await request(app)
      .post('/api/manifest/remove-component')
      .send({ relPath: '../../../etc/passwd', type: 'ApexClass', member: 'x' });
    expect(res.status).toBe(400);
  });

  it('returns 400 for absolute path', async () => {
    const res = await request(app)
      .post('/api/manifest/remove-component')
      .send({ relPath: '/etc/passwd', type: 'ApexClass', member: 'x' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/release/deploy — manifest path guard', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns 400 for path traversal in manifest param', async () => {
    const res = await request(app)
      .post('/api/release/deploy')
      .send({ manifest: '../../etc/passwd' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid manifest/i);
  });

  it('returns 400 for absolute path in manifest param', async () => {
    const res = await request(app)
      .post('/api/release/deploy')
      .send({ manifest: '/etc/passwd' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid manifest/i);
  });
});

describe('POST /api/compare/manifest — version conflict (409)', () => {
  let app;

  beforeAll(async () => {
    const { default: fs } = await import('fs-extra');
    vi.mocked(fs.pathExists).mockImplementation(async (p) => String(p).includes('rl-1.0.0'));
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    const { default: fs } = await import('fs-extra');
    vi.mocked(fs.pathExists).mockResolvedValue(false);
    await app.cleanup?.();
  });

  it('returns 409 when the versioned manifest already exists', async () => {
    const res = await request(app)
      .post('/api/compare/manifest')
      .send({ save: true, version: '1.0.0', xml: '<Package/>' });
    expect(res.status).toBe(409);
  });
});

// ─── Dependency graph routes ─────────────────────────────────────────────────

describe('GET /api/dependencies', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns 400 when org param is missing', async () => {
    const res = await request(app).get('/api/dependencies');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/org is required/i);
  });

  it('returns 400 when org param contains invalid characters', async () => {
    const res = await request(app).get('/api/dependencies?org=; rm -rf');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid org alias/i);
  });

  it('returns 400 when all types are invalid', async () => {
    const res = await request(app).get('/api/dependencies?org=dev&types=123bad,__nope__');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/types/i);
  });

  it('returns nodes, edges, nodeCount, edgeCount, and cachedAt on success', async () => {
    const { execa: execaMock } = await import('execa');
    const sfResponse = JSON.stringify({
      result: {
        records: [
          {
            MetadataComponentId: 'aaa',
            MetadataComponentName: 'MyClass',
            MetadataComponentType: 'ApexClass',
            RefMetadataComponentId: 'bbb',
            RefMetadataComponentName: 'HelperClass',
            RefMetadataComponentType: 'ApexClass',
          },
          {
            MetadataComponentId: 'aaa',
            MetadataComponentName: 'MyClass',
            MetadataComponentType: 'ApexClass',
            RefMetadataComponentId: 'ccc',
            RefMetadataComponentName: 'AnotherClass',
            RefMetadataComponentType: 'ApexClass',
          },
        ],
      },
    });
    vi.mocked(execaMock).mockResolvedValueOnce({ exitCode: 0, stdout: sfResponse, stderr: '' });

    const res = await request(app).get('/api/dependencies?org=dev');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.nodes)).toBe(true);
    expect(Array.isArray(res.body.edges)).toBe(true);
    expect(typeof res.body.nodeCount).toBe('number');
    expect(typeof res.body.edgeCount).toBe('number');
    expect(typeof res.body.cachedAt).toBe('string');
    expect(res.body.nodeCount).toBe(3); // aaa, bbb, ccc
    expect(res.body.edgeCount).toBe(2);
  });

  it('deduplicates edges when the same srcId|refId pair appears twice', async () => {
    const { execa: execaMock } = await import('execa');
    const dupResponse = JSON.stringify({
      result: {
        records: [
          {
            MetadataComponentId: 'aaa',
            MetadataComponentName: 'MyClass',
            MetadataComponentType: 'ApexClass',
            RefMetadataComponentId: 'bbb',
            RefMetadataComponentName: 'HelperClass',
            RefMetadataComponentType: 'ApexClass',
          },
          // exact duplicate
          {
            MetadataComponentId: 'aaa',
            MetadataComponentName: 'MyClass',
            MetadataComponentType: 'ApexClass',
            RefMetadataComponentId: 'bbb',
            RefMetadataComponentName: 'HelperClass',
            RefMetadataComponentType: 'ApexClass',
          },
        ],
      },
    });
    vi.mocked(execaMock).mockResolvedValueOnce({ exitCode: 0, stdout: dupResponse, stderr: '' });

    // Use a different org so it doesn't hit the cache from the previous test
    const res = await request(app).get('/api/dependencies?org=dev2');
    expect(res.status).toBe(200);
    expect(res.body.edgeCount).toBe(1); // deduplicated
  });
});

describe('GET /api/dependencies/preflight', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns 400 when manifest param is missing', async () => {
    const res = await request(app).get('/api/dependencies/preflight?org=dev');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/manifest is required/i);
  });

  it('returns 400 when manifest relative path contains path traversal', async () => {
    const res = await request(app).get('/api/dependencies/preflight?manifest=../../etc/passwd&org=dev');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid manifest path/i);
  });

  it('returns 404 when manifest is a valid relative path but file does not exist', async () => {
    const { default: fsMock } = await import('fs-extra');
    fsMock.pathExists.mockResolvedValueOnce(false);
    const res = await request(app).get('/api/dependencies/preflight?manifest=relative/path.xml&org=dev');
    expect(res.status).toBe(404);
  });

  it('returns pass with empty missing/warnings when manifest has no component members', async () => {
    const { default: fsMock } = await import('fs-extra');
    // pathExists returns true so the file is found; readFile returns XML with no <members>
    fsMock.pathExists.mockResolvedValueOnce(true);
    fsMock.readFile.mockResolvedValueOnce('<Package xmlns="http://soap.sforce.com/2006/04/metadata"><version>59.0</version></Package>');

    const res = await request(app).get(`/api/dependencies/preflight?manifest=manifest/release/pkg.xml&org=dev`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pass');
    expect(res.body.missing).toHaveLength(0);
    expect(res.body.warnings).toHaveLength(0);
  });

  it('returns fail with missing entries when a custom-type dep is absent from manifest', async () => {
    const { default: fsMock } = await import('fs-extra');
    const { execa: execaMock } = await import('execa');

    fsMock.pathExists.mockResolvedValueOnce(true);
    fsMock.readFile.mockResolvedValueOnce(
      '<Package><types><members>MyClass</members><name>ApexClass</name></types></Package>',
    );

    const sfResponse = JSON.stringify({
      result: {
        records: [
          {
            MetadataComponentName: 'MyClass',
            MetadataComponentType: 'ApexClass',
            RefMetadataComponentName: 'MissingCustomClass',
            RefMetadataComponentType: 'ApexClass',
          },
        ],
      },
    });
    vi.mocked(execaMock).mockResolvedValueOnce({ exitCode: 0, stdout: sfResponse, stderr: '' });

    const res = await request(app).get(`/api/dependencies/preflight?manifest=manifest/release/pkg.xml&org=dev`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('fail');
    expect(res.body.missing.length).toBeGreaterThan(0);
    expect(res.body.missing[0].name).toBe('MissingCustomClass');
    expect(Array.isArray(res.body.missing[0].referencedBy)).toBe(true);
  });

  it('returns warn when only standard-type deps are missing from manifest', async () => {
    const { default: fsMock } = await import('fs-extra');
    const { execa: execaMock } = await import('execa');

    fsMock.pathExists.mockResolvedValueOnce(true);
    fsMock.readFile.mockResolvedValueOnce(
      '<Package><types><members>MyClass</members><name>ApexClass</name></types></Package>',
    );

    const sfResponse = JSON.stringify({
      result: {
        records: [
          {
            MetadataComponentName: 'MyClass',
            MetadataComponentType: 'ApexClass',
            RefMetadataComponentName: 'Account',
            RefMetadataComponentType: 'StandardEntity',
          },
        ],
      },
    });
    vi.mocked(execaMock).mockResolvedValueOnce({ exitCode: 0, stdout: sfResponse, stderr: '' });

    const res = await request(app).get(`/api/dependencies/preflight?manifest=manifest/release/pkg.xml&org=dev`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('warn');
    expect(res.body.missing).toHaveLength(0);
    expect(res.body.warnings.length).toBeGreaterThan(0);
  });
});

// ─── Mock config.js for PATCH /api/config success tests ─────────────────────
// vi.mock is hoisted — safe to add here even at the bottom of the file.
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

// ─── GET /api/prompts ────────────────────────────────────────────────────────

describe('GET /api/prompts', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns 200 with an array of prompt objects', async () => {
    const res = await request(app).get('/api/prompts');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.prompts)).toBe(true);
    expect(res.body.prompts.length).toBeGreaterThan(0);
  });

  it('each prompt object has key, label, description, default, current, overridden fields', async () => {
    const res = await request(app).get('/api/prompts');
    expect(res.status).toBe(200);
    for (const p of res.body.prompts) {
      expect(p).toHaveProperty('key');
      expect(p).toHaveProperty('label');
      expect(p).toHaveProperty('description');
      expect(p).toHaveProperty('default');
      expect(p).toHaveProperty('current');
      expect(p).toHaveProperty('overridden');
    }
  });
});

// ─── PATCH /api/prompts/:key ─────────────────────────────────────────────────

describe('PATCH /api/prompts/:key', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns 200 with ok and key for a valid key', async () => {
    const { default: fsMock } = await import('fs-extra');
    fsMock.readJson.mockResolvedValueOnce({});

    const res = await request(app)
      .patch('/api/prompts/review')
      .send({ value: 'my custom prompt' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.key).toBe('review');
  });

  it('returns 400 when value is not a string', async () => {
    const res = await request(app)
      .patch('/api/prompts/review')
      .send({ value: 42 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it('returns 400 when value is missing', async () => {
    const res = await request(app)
      .patch('/api/prompts/review')
      .send({});
    expect(res.status).toBe(400);
  });

  it('returns 503 when configDir is absent', async () => {
    const noConfigDirConfig = { ...MOCK_CONFIG, _configDir: undefined };
    const a = createGuiApp(noConfigDirConfig, VERSION, PORT);
    const res = await request(a)
      .patch('/api/prompts/review')
      .send({ value: 'text' });
    expect(res.status).toBe(503);
    await a.cleanup?.();
  });

  it('returns 404 for an unknown prompt key', async () => {
    const res = await request(app)
      .patch('/api/prompts/totally-unknown-key-xyz')
      .send({ value: 'text' });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Unknown/i);
  });
});

// ─── DELETE /api/prompts/:key ─────────────────────────────────────────────────

describe('DELETE /api/prompts/:key', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns 200 with ok and key for a valid key', async () => {
    const { default: fsMock } = await import('fs-extra');
    fsMock.readJson.mockResolvedValueOnce({ review: 'overridden' });

    const res = await request(app).delete('/api/prompts/review');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.key).toBe('review');
  });

  it('returns 503 when configDir is absent', async () => {
    const noConfigDirConfig = { ...MOCK_CONFIG, _configDir: undefined };
    const a = createGuiApp(noConfigDirConfig, VERSION, PORT);
    const res = await request(a).delete('/api/prompts/review');
    expect(res.status).toBe(503);
    await a.cleanup?.();
  });

  it('returns 404 for an unknown prompt key', async () => {
    const res = await request(app).delete('/api/prompts/totally-unknown-key-xyz');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Unknown/i);
  });
});

// ─── PATCH /api/config (success path) ────────────────────────────────────────

describe('PATCH /api/config — success path', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns 200 with ok, key, and value when key and value are valid', async () => {
    const { default: fsMock } = await import('fs-extra');
    fsMock.readJson.mockResolvedValueOnce({ defaultOrg: 'dev' });

    const res = await request(app)
      .patch('/api/config')
      .send({ key: 'defaultOrg', value: 'staging' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.key).toBe('defaultOrg');
  });

  it('returns 400 when value is missing', async () => {
    const res = await request(app)
      .patch('/api/config')
      .send({ key: 'defaultOrg' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });
});

// ─── POST /api/release-notes/save ────────────────────────────────────────────

describe('POST /api/release-notes/save', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns 200 with ok and path when content is valid and file does not yet exist', async () => {
    const { default: fsMock } = await import('fs-extra');
    fsMock.pathExists.mockResolvedValueOnce(false);

    const res = await request(app)
      .post('/api/release-notes/save')
      .send({ content: '## Release Notes\n\nSome notes here.' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.path).toBe('string');
  });

  it('returns 400 when content is missing', async () => {
    const res = await request(app)
      .post('/api/release-notes/save')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/content is required/i);
  });

  it('returns 409 when release notes file already exists', async () => {
    const { default: fsMock } = await import('fs-extra');
    fsMock.pathExists.mockResolvedValueOnce(true);

    const res = await request(app)
      .post('/api/release-notes/save')
      .send({ content: 'some notes' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
  });

  it('returns 413 when content exceeds 1 MB', async () => {
    const bigContent = 'x'.repeat(1_000_001);
    const res = await request(app)
      .post('/api/release-notes/save')
      .send({ content: bigContent });
    expect(res.status).toBe(413);
  });
});

// ─── POST /api/changelog/save ─────────────────────────────────────────────────

describe('POST /api/changelog/save', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns 200 with ok when content is valid and CHANGELOG.md exists', async () => {
    const { default: fsMock } = await import('fs-extra');
    fsMock.pathExists.mockResolvedValueOnce(true);
    fsMock.readFile.mockResolvedValueOnce(
      '# Changelog\n\n## [Unreleased]\n\nOld content.\n\n## [1.0.0]\n'
    );

    const res = await request(app)
      .post('/api/changelog/save')
      .send({ content: '### Added\n- New feature' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('returns 200 when CHANGELOG.md does not exist (creates it)', async () => {
    const { default: fsMock } = await import('fs-extra');
    fsMock.pathExists.mockResolvedValueOnce(false);

    const res = await request(app)
      .post('/api/changelog/save')
      .send({ content: '### Added\n- New feature' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('returns 400 when content is missing', async () => {
    const res = await request(app)
      .post('/api/changelog/save')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/content is required/i);
  });

  it('returns 413 when content exceeds 1 MB', async () => {
    const bigContent = 'x'.repeat(1_000_001);
    const res = await request(app)
      .post('/api/changelog/save')
      .send({ content: bigContent });
    expect(res.status).toBe(413);
  });
});
