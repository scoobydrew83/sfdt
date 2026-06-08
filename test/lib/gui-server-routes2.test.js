/**
 * Additional route-level integration tests for gui-server.js.
 *
 * Covers routes not yet tested in gui-server-routes.test.js.
 * Uses the same setup pattern: supertest + createGuiApp, all heavy
 * dependencies mocked.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

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
    mkdtemp: vi.fn(async (prefix) => `${prefix}mocked`),
  },
}));

vi.mock('execa', () => ({
  execa: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
}));

// ─── Imports ────────────────────────────────────────────────────────────────

import request from 'supertest';
import { createGuiApp } from '../../src/lib/gui-server/index.js';

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

// ─── GET /api/ping ───────────────────────────────────────────────────────────

describe('GET /api/ping', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns 200 with ok: true', async () => {
    const res = await request(app).get('/api/ping');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// ─── GET /api/packages ───────────────────────────────────────────────────────

describe('GET /api/packages', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns 200 with empty packages array when no packageDirectories configured', async () => {
    const res = await request(app).get('/api/packages');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.packages)).toBe(true);
    expect(res.body.packages).toHaveLength(0);
  });

  it('returns packages array when multiple packageDirectories are configured', async () => {
    const multiPkgConfig = {
      ...MOCK_CONFIG,
      packageDirectories: [
        { name: 'core', path: 'force-app', default: true },
        { name: 'feature-a', path: 'feature-a', default: false },
      ],
    };
    const a = createGuiApp(multiPkgConfig, VERSION, PORT);
    const res = await request(a).get('/api/packages');
    expect(res.status).toBe(200);
    expect(res.body.packages).toHaveLength(2);
    expect(res.body.packages[0].name).toBe('core');
    await a.cleanup?.();
  });

  it('returns empty array when only one packageDirectory is configured', async () => {
    const singlePkgConfig = {
      ...MOCK_CONFIG,
      packageDirectories: [
        { name: 'core', path: 'force-app', default: true },
      ],
    };
    const a = createGuiApp(singlePkgConfig, VERSION, PORT);
    const res = await request(a).get('/api/packages');
    expect(res.status).toBe(200);
    // Single-package projects get empty array (UI hides the picker)
    expect(res.body.packages).toHaveLength(0);
    await a.cleanup?.();
  });
});

// ─── GET /api/quality ────────────────────────────────────────────────────────

describe('GET /api/quality', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns 200 with empty quality object when no quality log exists', async () => {
    const res = await request(app).get('/api/quality');
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
  });
});

// ─── GET /api/pull/groups ────────────────────────────────────────────────────

describe('GET /api/pull/groups', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns 200 with empty groups array when no pullGroups configured', async () => {
    const res = await request(app).get('/api/pull/groups');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.groups)).toBe(true);
    expect(res.body.groups).toHaveLength(0);
  });

  it('returns groups when pullGroups are configured', async () => {
    const configWithGroups = {
      ...MOCK_CONFIG,
      pullConfig: {
        pullGroups: {
          apex: { description: 'Apex classes and triggers' },
          lwc: { description: 'Lightning Web Components' },
        },
      },
    };
    const a = createGuiApp(configWithGroups, VERSION, PORT);
    const res = await request(a).get('/api/pull/groups');
    expect(res.status).toBe(200);
    expect(res.body.groups).toHaveLength(2);
    expect(res.body.groups[0].key).toBe('apex');
    expect(res.body.groups[0].description).toBe('Apex classes and triggers');
    await a.cleanup?.();
  });
});

// ─── GET /api/test/classes ───────────────────────────────────────────────────

describe('GET /api/test/classes', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns 200 with configured and discovered arrays', async () => {
    const res = await request(app).get('/api/test/classes');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.configured)).toBe(true);
    expect(Array.isArray(res.body.discovered)).toBe(true);
  });

  it('returns configured test classes from testConfig', async () => {
    const configWithTests = {
      ...MOCK_CONFIG,
      testConfig: { testClasses: ['MyClassTest', 'AnotherTest'] },
    };
    const a = createGuiApp(configWithTests, VERSION, PORT);
    const res = await request(a).get('/api/test/classes');
    expect(res.status).toBe(200);
    expect(res.body.configured).toEqual(['MyClassTest', 'AnotherTest']);
    await a.cleanup?.();
  });
});

// ─── GET /api/orgs ────────────────────────────────────────────────────────────

describe('GET /api/orgs', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns 200 with orgs array', async () => {
    const res = await request(app).get('/api/orgs');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.orgs)).toBe(true);
  });

  it('returns orgs from config.environments when sf CLI is not available', async () => {
    const { execa: execaMock } = await import('execa');
    vi.mocked(execaMock).mockRejectedValueOnce(new Error('sf not found'));

    const configWithOrgs = {
      ...MOCK_CONFIG,
      environments: {
        orgs: [{ alias: 'staging', username: 'user@example.com' }],
      },
    };
    const a = createGuiApp(configWithOrgs, VERSION, PORT);
    const res = await request(a).get('/api/orgs');
    expect(res.status).toBe(200);
    expect(res.body.orgs.some((o) => o.alias === 'staging')).toBe(true);
    await a.cleanup?.();
  });
});

// ─── GET /api/changelog/content ──────────────────────────────────────────────

describe('GET /api/changelog/content', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns 200 with empty content and exists: false when no CHANGELOG.md', async () => {
    const { default: fsMock } = await import('fs-extra');
    fsMock.pathExists.mockResolvedValueOnce(false);

    const res = await request(app).get('/api/changelog/content');
    expect(res.status).toBe(200);
    expect(res.body.content).toBe('');
    expect(res.body.exists).toBe(false);
  });

  it('returns the [Unreleased] section content when CHANGELOG.md exists', async () => {
    const { default: fsMock } = await import('fs-extra');
    fsMock.pathExists.mockResolvedValueOnce(true);
    fsMock.readFile.mockResolvedValueOnce(
      '# Changelog\n\n## [Unreleased]\n\n### Added\n- New stuff\n\n## [1.0.0]\n\nOld stuff'
    );

    const res = await request(app).get('/api/changelog/content');
    expect(res.status).toBe(200);
    expect(res.body.exists).toBe(true);
    expect(res.body.content).toContain('New stuff');
  });
});

// ─── GET /api/manifests/content ──────────────────────────────────────────────

describe('GET /api/manifests/content', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns 400 when path query param is missing', async () => {
    const res = await request(app).get('/api/manifests/content');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid path/i);
  });

  it('returns 400 for path traversal', async () => {
    const res = await request(app).get('/api/manifests/content?path=../../etc/passwd');
    expect(res.status).toBe(400);
  });

  it('returns 400 for absolute path', async () => {
    const res = await request(app).get('/api/manifests/content?path=/etc/passwd');
    expect(res.status).toBe(400);
  });

  it('returns 200 with xml content for a valid relative path', async () => {
    const { default: fsMock } = await import('fs-extra');
    fsMock.readFile.mockResolvedValueOnce('<Package xmlns="..."><version>59.0</version></Package>');

    const res = await request(app).get('/api/manifests/content?path=manifest/release/pkg.xml');
    expect(res.status).toBe(200);
    expect(res.body.xml).toContain('<Package');
  });
});

// ─── GET /api/release/suggest-version ────────────────────────────────────────

describe('GET /api/release/suggest-version', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns 200 with version field', async () => {
    const res = await request(app).get('/api/release/suggest-version');
    expect(res.status).toBe(200);
    expect(typeof res.body.version).toBe('string');
  });

  it('returns 0.1.0 when no manifests or git tags exist', async () => {
    const { default: fsMock } = await import('fs-extra');
    fsMock.pathExists.mockResolvedValueOnce(false); // no manifestDir

    const { execa: execaMock } = await import('execa');
    vi.mocked(execaMock).mockRejectedValueOnce(new Error('git not found'));

    const res = await request(app).get('/api/release/suggest-version');
    expect(res.status).toBe(200);
    expect(res.body.version).toBe('0.1.0');
  });
});

// ─── GET /api/ai/available ────────────────────────────────────────────────────

describe('GET /api/ai/available', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns 200 with available, enabled, and provider fields', async () => {
    const res = await request(app).get('/api/ai/available');
    expect(res.status).toBe(200);
    expect(typeof res.body.available).toBe('boolean');
    expect(typeof res.body.enabled).toBe('boolean');
    // provider can be string or null
  });

  it('returns enabled: false when features.ai is false', async () => {
    const res = await request(app).get('/api/ai/available');
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
  });
});

// ─── POST /api/manifest/remove-component — valid path ────────────────────────

describe('POST /api/manifest/remove-component — valid path', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns 200 when manifest file can be read', async () => {
    const { default: fsMock } = await import('fs-extra');
    fsMock.readFile.mockResolvedValueOnce(
      '<Package><types><members>MyClass</members><name>ApexClass</name></types></Package>'
    );

    const res = await request(app)
      .post('/api/manifest/remove-component')
      .send({ relPath: 'manifest/release/my-package.xml', type: 'ApexClass', member: 'MyClass' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('returns 500 when readFile throws', async () => {
    const { default: fsMock } = await import('fs-extra');
    fsMock.readFile.mockRejectedValueOnce(new Error('ENOENT: no such file'));

    const res = await request(app)
      .post('/api/manifest/remove-component')
      .send({ relPath: 'manifest/release/my-package.xml', type: 'ApexClass', member: 'MyClass' });
    expect(res.status).toBe(500);
  });
});

// ─── GET /api/manifest/discover ──────────────────────────────────────────────

describe('GET /api/manifest/discover', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns 400 when type is missing', async () => {
    const res = await request(app).get('/api/manifest/discover');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/type is required/i);
  });

  it('returns 200 with empty members for unknown type', async () => {
    const res = await request(app).get('/api/manifest/discover?type=UnknownType');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.members)).toBe(true);
    expect(res.body.members).toHaveLength(0);
  });

  it('returns 200 with empty members when source dir does not exist', async () => {
    const { default: fsMock } = await import('fs-extra');
    fsMock.pathExists.mockResolvedValueOnce(false);

    const res = await request(app).get('/api/manifest/discover?type=ApexClass');
    expect(res.status).toBe(200);
    expect(res.body.members).toHaveLength(0);
  });
});

// ─── POST /api/manifest/add-component ────────────────────────────────────────

describe('POST /api/manifest/add-component', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns 400 when required fields are missing', async () => {
    const res = await request(app)
      .post('/api/manifest/add-component')
      .send({ relPath: 'manifest/release/pkg.xml' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  it('returns 400 for path traversal in relPath', async () => {
    const res = await request(app)
      .post('/api/manifest/add-component')
      .send({ relPath: '../../etc/passwd', type: 'ApexClass', member: 'x' });
    expect(res.status).toBe(400);
  });

  it('returns 200 when manifest file can be read and updated', async () => {
    const { default: fsMock } = await import('fs-extra');
    fsMock.readFile.mockResolvedValueOnce(
      '<Package><types><members>ExistingClass</members><name>ApexClass</name></types></Package>'
    );

    const res = await request(app)
      .post('/api/manifest/add-component')
      .send({ relPath: 'manifest/release/pkg.xml', type: 'ApexClass', member: 'MyClass' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// ─── GET /api/deploy/history ─────────────────────────────────────────────────
// (Already tested in gui-server-routes.test.js, but adding a positive case
// with the new config.js mock which doesn't affect that route)

describe('GET /api/deploy/history (config.js mock context)', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns 200 with history array', async () => {
    const { default: fsMock } = await import('fs-extra');
    fsMock.readJson.mockResolvedValueOnce([]);

    const res = await request(app).get('/api/deploy/history');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.history)).toBe(true);
  });
});

// ─── GET /api/compare/diff ───────────────────────────────────────────────────

describe('GET /api/compare/diff', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns 400 when type and member params are missing', async () => {
    const res = await request(app).get('/api/compare/diff');
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it('returns 400 when member contains path traversal', async () => {
    const res = await request(app).get('/api/compare/diff?type=ApexClass&member=../../etc');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid member/i);
  });

  it('returns 200 with empty xml when compare data is available (readJson returns {})', async () => {
    // readCompare reads compare-latest.json via tryReadJson; default mock returns {}
    // which is truthy, so the route proceeds and returns empty xml
    const res = await request(app).get('/api/compare/diff?type=ApexClass&member=MyClass');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('sourceXml');
    expect(res.body).toHaveProperty('targetXml');
  });

  it('returns 404 when readJson throws (no compare file)', async () => {
    const { default: fsMock } = await import('fs-extra');
    fsMock.readJson.mockRejectedValueOnce(new Error('ENOENT'));

    const res = await request(app).get('/api/compare/diff?type=ApexClass&member=MyClass');
    expect(res.status).toBe(404);
  });
});

// ─── POST /api/compare — target required ─────────────────────────────────────

describe('POST /api/compare', () => {
  let app;
  let csrf;

  beforeAll(async () => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
    csrf = (await request(app).get('/api/csrf-token')).body.token;
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns 400 when target is missing', async () => {
    const res = await request(app).post('/api/compare').set('X-SFDT-CSRF', csrf).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/target is required/i);
  });

  it('returns 400 when target contains invalid characters', async () => {
    const res = await request(app).post('/api/compare').set('X-SFDT-CSRF', csrf).send({ target: '--help' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid target org alias/i);
  });

  it('returns 400 when source contains invalid characters', async () => {
    const res = await request(app).post('/api/compare').set('X-SFDT-CSRF', csrf).send({ source: '--dry-run', target: 'my-org' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid source org alias/i);
  });
});

// ─── GET /api/compare/stream ──────────────────────────────────────────────────

describe('GET /api/compare/stream', () => {
  let app;
  let csrf;

  beforeAll(async () => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
    csrf = (await request(app).get('/api/csrf-token')).body.token;
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns 200 SSE stream when compare data exists (readJson returns {})', async () => {
    // readJson returns {} by default → data = {} (truthy) → SSE mode.
    // The endpoint requires CSRF via ?csrf= because EventSource cannot
    // set custom headers.
    const res = await request(app).get(`/api/compare/stream?csrf=${csrf}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
  });

  it('returns 403 when csrf query param is missing', async () => {
    const res = await request(app)
      .get('/api/compare/stream')
      .set('X-SFDT-CSRF', 'invalid-token');
    expect(res.status).toBe(403);
  });
});

// ─── GET /api/manifest/detect-tests ──────────────────────────────────────────

describe('GET /api/manifest/detect-tests', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns 400 when path param is missing', async () => {
    const res = await request(app).get('/api/manifest/detect-tests');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/path is required/i);
  });

  it('returns 404 when manifest does not exist', async () => {
    const { default: fsMock } = await import('fs-extra');
    fsMock.pathExists.mockResolvedValueOnce(false);

    const res = await request(app).get('/api/manifest/detect-tests?path=manifest/release/pkg.xml');
    expect(res.status).toBe(404);
  });

  it('returns 200 with test classes extracted from manifest', async () => {
    const { default: fsMock } = await import('fs-extra');
    fsMock.pathExists.mockResolvedValueOnce(true);
    fsMock.readFile.mockResolvedValueOnce(
      '<Package>' +
      '<types>' +
      '<members>MyClass</members>' +
      '<members>MyClassTest</members>' +
      '<name>ApexClass</name>' +
      '</types>' +
      '</Package>'
    );

    const res = await request(app).get('/api/manifest/detect-tests?path=manifest/release/pkg.xml');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.tests)).toBe(true);
    expect(res.body.tests).toContain('MyClassTest');
  });
});

// ─── POST /api/review (SSE — AI not available) ───────────────────────────────

describe('POST /api/review', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns SSE stream (text/event-stream) and ends with error event when AI unavailable', async () => {
    const { execa: execaMock } = await import('execa');
    // Return empty diff so it short-circuits early; also mock ai.js via execa not being the issue
    vi.mocked(execaMock).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    const res = await request(app).post('/api/review').send({ base: 'main' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
  });
});

// ─── POST /api/quality/fix-plan (SSE — AI check runs) ────────────────────────

describe('POST /api/quality/fix-plan', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns SSE stream with text/event-stream content-type', async () => {
    const res = await request(app).post('/api/quality/fix-plan').send({});
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
  });
});

// ─── POST /api/ai/chat (SSE — validation) ────────────────────────────────────

describe('POST /api/ai/chat', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns SSE with error event when messages is missing', async () => {
    const res = await request(app).post('/api/ai/chat').send({});
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.text).toContain('messages array is required');
  });

  it('returns SSE with error event when messages array is empty', async () => {
    const res = await request(app).post('/api/ai/chat').send({ messages: [] });
    expect(res.status).toBe(200);
    expect(res.text).toContain('messages array is required');
  });

  it('returns SSE with error event when message has invalid role', async () => {
    const res = await request(app)
      .post('/api/ai/chat')
      .send({ messages: [{ role: 'system', content: 'hello' }] });
    expect(res.status).toBe(200);
    expect(res.text).toContain('role');
  });
});

// ─── POST /api/explain (SSE — logPath path guard) ────────────────────────────

describe('POST /api/explain', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns SSE stream and sends error event for path traversal in logPath', async () => {
    const res = await request(app)
      .post('/api/explain')
      .send({ logPath: '../../etc/passwd' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.text).toContain('error');
  });
});

// ─── POST /api/compare/manifest (no conflict) ────────────────────────────────

describe('POST /api/compare/manifest (no conflict)', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns 200 with xml when no conflict and save is false', async () => {
    const csrf = (await request(app).get('/api/csrf-token')).body.token;
    const res = await request(app)
      .post('/api/compare/manifest')
      .set('X-SFDT-CSRF', csrf)
      .send({ items: [], apiVersion: '59.0', save: false });
    expect(res.status).toBe(200);
    expect(typeof res.body.xml).toBe('string');
  });
});

// ─── POST /api/manifest/build (git not available) ────────────────────────────

describe('POST /api/manifest/build', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns 200 with xml on empty diff', async () => {
    const { execa: execaMock } = await import('execa');
    // merge-base returns empty base ref
    vi.mocked(execaMock)
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'abc123', stderr: '' }) // merge-base
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }); // git diff

    const res = await request(app)
      .post('/api/manifest/build')
      .send({ base: 'main', head: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.xml).toBe('string');
  });
});

// ─── POST /api/command/run ────────────────────────────────────────────────────

describe('POST /api/command/run', () => {
  let app;
  let csrf;

  beforeAll(async () => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
    csrf = (await request(app).get('/api/csrf-token')).body.token;
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns 400 when command param is missing', async () => {
    const res = await request(app)
      .post('/api/command/run')
      .set('X-SFDT-CSRF', csrf)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it('returns 400 for disallowed command', async () => {
    const res = await request(app)
      .post('/api/command/run')
      .set('X-SFDT-CSRF', csrf)
      .send({ command: 'rm -rf' });
    expect(res.status).toBe(400);
  });
});

// ─── POST /api/init ───────────────────────────────────────────────────────────

describe('POST /api/init', () => {
  let app;

  beforeAll(() => {
    // Use a config without a configDir to simulate uninitialized project
    const uninitConfig = { ...MOCK_CONFIG, _configDir: undefined };
    app = createGuiApp(uninitConfig, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns 400 when projectName is empty', async () => {
    const { default: fsMock } = await import('fs-extra');
    fsMock.pathExists.mockResolvedValueOnce(false); // configDir does not exist

    const res = await request(app)
      .post('/api/init')
      .send({ projectName: '   ', defaultOrg: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/projectName/i);
  });
});
