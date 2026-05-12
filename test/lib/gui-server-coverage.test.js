/**
 * Route tests for Coverage page endpoints:
 *   - POST /api/command/run  (testLevel validation + SFDT_TEST_LEVEL injection)
 *   - POST /api/test/classes/sync
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

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
    existsSync:  vi.fn().mockReturnValue(false),
    pathExists:  vi.fn().mockResolvedValue(false),
    readJson:    vi.fn().mockResolvedValue({}),
    readdir:     vi.fn().mockResolvedValue([]),
    readFile:    vi.fn().mockResolvedValue(''),
    outputJson:  vi.fn().mockResolvedValue(undefined),
    stat:        vi.fn().mockResolvedValue({ mtime: new Date(), size: 0 }),
    remove:      vi.fn().mockResolvedValue(undefined),
    ensureDir:   vi.fn().mockResolvedValue(undefined),
    writeFile:   vi.fn().mockResolvedValue(undefined),
    writeJson:   vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('execa', () => ({
  execa: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
}));

vi.mock('glob', () => ({
  glob: vi.fn().mockResolvedValue([]),
}));

// ─── Imports ────────────────────────────────────────────────────────────────

import request from 'supertest';
import { createGuiApp } from '../../src/lib/gui-server/index.js';
import { glob } from 'glob';

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

// ─── Reset mocks before each test ───────────────────────────────────────────

beforeEach(async () => {
  vi.resetAllMocks();
  const { default: fsMock } = await import('fs-extra');
  fsMock.existsSync.mockReturnValue(false);
  fsMock.pathExists.mockResolvedValue(false);
  fsMock.readJson.mockResolvedValue({});
  fsMock.readdir.mockResolvedValue([]);
  fsMock.readFile.mockResolvedValue('');
  fsMock.outputJson.mockResolvedValue(undefined);
  fsMock.stat.mockResolvedValue({ mtime: new Date(), size: 0 });
  fsMock.remove.mockResolvedValue(undefined);
  fsMock.ensureDir.mockResolvedValue(undefined);
  fsMock.writeFile.mockResolvedValue(undefined);
  fsMock.writeJson.mockResolvedValue(undefined);
  vi.mocked(glob).mockResolvedValue([]);
});

// ─── POST /api/command/run — testLevel validation ────────────────────────────

describe('POST /api/command/run — testLevel validation', () => {
  let app;
  let csrf;

  beforeAll(async () => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
    csrf = (await request(app).get('/api/csrf-token')).body.token;
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns 400 for an invalid testLevel value', async () => {
    const res = await request(app)
      .post('/api/command/run')
      .set('X-SFDT-CSRF', csrf)
      .send({ command: 'test', testLevel: 'RunFakeTests' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid testlevel/i);
  });

  it('accepts RunLocalTests and begins streaming', async () => {
    // A valid testLevel should pass validation — server starts SSE stream
    // (execa is mocked so the script exits immediately)
    const res = await request(app)
      .post('/api/command/run')
      .set('X-SFDT-CSRF', csrf)
      .send({ command: 'test', testLevel: 'RunLocalTests' });
    // SSE starts with 200 and the event-stream content type
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
  });

  it('accepts RunAllTestsInOrg and begins streaming', async () => {
    const res = await request(app)
      .post('/api/command/run')
      .set('X-SFDT-CSRF', csrf)
      .send({ command: 'test', testLevel: 'RunAllTestsInOrg' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
  });

  it('accepts RunSpecifiedTests and begins streaming', async () => {
    const res = await request(app)
      .post('/api/command/run')
      .set('X-SFDT-CSRF', csrf)
      .send({ command: 'test', testLevel: 'RunSpecifiedTests' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
  });

  it('omitting testLevel is still valid (defaults to class-batching path)', async () => {
    const res = await request(app)
      .post('/api/command/run')
      .set('X-SFDT-CSRF', csrf)
      .send({ command: 'test' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
  });
});

// ─── POST /api/test/classes/sync ─────────────────────────────────────────────

describe('POST /api/test/classes/sync', () => {
  let app;
  let csrf;

  beforeAll(async () => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
    csrf = (await request(app).get('/api/csrf-token')).body.token;
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns 400 when source path does not exist', async () => {
    const { default: fsMock } = await import('fs-extra');
    fsMock.pathExists.mockResolvedValue(false);

    const res = await request(app)
      .post('/api/test/classes/sync')
      .set('X-SFDT-CSRF', csrf)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/source path not found/i);
  });

  it('returns 400 when no test classes are found in source', async () => {
    const { default: fsMock } = await import('fs-extra');
    fsMock.pathExists.mockResolvedValue(true);
    vi.mocked(glob).mockResolvedValue([]); // no .cls files

    const res = await request(app)
      .post('/api/test/classes/sync')
      .set('X-SFDT-CSRF', csrf)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no test classes found/i);
  });

  it('returns 400 when cls files exist but none match the Test/Tests naming convention', async () => {
    const { default: fsMock } = await import('fs-extra');
    fsMock.pathExists.mockResolvedValue(true);
    // These are production classes, not test classes
    vi.mocked(glob).mockResolvedValue(['classes/AccountService.cls', 'classes/LeadHelper.cls']);

    const res = await request(app)
      .post('/api/test/classes/sync')
      .set('X-SFDT-CSRF', csrf)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no test classes found/i);
  });

  it('returns { added, removed, total } on success', async () => {
    // App must be created with the pre-existing class in in-memory config
    const configWithExisting = {
      ...MOCK_CONFIG,
      testConfig: { testClasses: ['OldClassTest'] },
    };
    const appWithExisting = createGuiApp(configWithExisting, VERSION, PORT);
    const localCsrf = (await request(appWithExisting).get('/api/csrf-token')).body.token;

    const { default: fsMock } = await import('fs-extra');
    fsMock.pathExists.mockResolvedValue(true);
    fsMock.readJson.mockResolvedValue({ testConfig: { testClasses: ['OldClassTest'] } });
    vi.mocked(glob).mockResolvedValue([
      'classes/AccountTest.cls',
      'classes/LeadTests.cls',
    ]);

    const res = await request(appWithExisting)
      .post('/api/test/classes/sync')
      .set('X-SFDT-CSRF', localCsrf)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.added).toBe(2);   // AccountTest + LeadTests are new
    expect(res.body.removed).toBe(1); // OldClassTest was removed

    await appWithExisting.cleanup?.();
  });

  it('writes updated testClasses to config file', async () => {
    const { default: fsMock } = await import('fs-extra');
    fsMock.pathExists.mockResolvedValue(true);
    fsMock.readJson.mockResolvedValue({});
    vi.mocked(glob).mockResolvedValue(['classes/MyTest.cls']);

    await request(app)
      .post('/api/test/classes/sync')
      .set('X-SFDT-CSRF', csrf)
      .send({});

    expect(fsMock.writeJson).toHaveBeenCalledWith(
      expect.stringContaining('config.json'),
      expect.objectContaining({
        testConfig: expect.objectContaining({ testClasses: ['MyTest'] }),
      }),
      expect.objectContaining({ spaces: 2 }),
    );
  });

  it('does not write config when no test classes found', async () => {
    const { default: fsMock } = await import('fs-extra');
    fsMock.pathExists.mockResolvedValue(true);
    vi.mocked(glob).mockResolvedValue([]);

    await request(app)
      .post('/api/test/classes/sync')
      .set('X-SFDT-CSRF', csrf)
      .send({});

    expect(fsMock.writeJson).not.toHaveBeenCalled();
  });

  it('returns 0 added and 0 removed when discovered list is identical to existing', async () => {
    const configWithExisting = {
      ...MOCK_CONFIG,
      testConfig: { testClasses: ['AccountTest'] },
    };
    const appWithExisting = createGuiApp(configWithExisting, VERSION, PORT);
    const localCsrf = (await request(appWithExisting).get('/api/csrf-token')).body.token;

    const { default: fsMock } = await import('fs-extra');
    fsMock.pathExists.mockResolvedValue(true);
    fsMock.readJson.mockResolvedValue({ testConfig: { testClasses: ['AccountTest'] } });
    vi.mocked(glob).mockResolvedValue(['classes/AccountTest.cls']);

    const res = await request(appWithExisting)
      .post('/api/test/classes/sync')
      .set('X-SFDT-CSRF', localCsrf)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.added).toBe(0);
    expect(res.body.removed).toBe(0);
    expect(res.body.total).toBe(1);

    await appWithExisting.cleanup?.();
  });
});
