/**
 * Route tests for the glob-backed discovery handlers and the flow/quality
 * endpoint — success paths the existing suites skip:
 *
 *   GET  /api/test/classes      (Apex test-class discovery via glob)
 *   GET  /api/manifest/discover (metadata-type member discovery via glob)
 *   POST /api/flow/quality      (@sfdt/flow-core report over a metadata payload)
 *
 * glob and flow-quality.js are mocked so discovery + report are deterministic.
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

vi.mock('../../src/lib/flow-quality.js', () => ({
  runFlowQuality: vi.fn(() => ({ score: 90, violations: [] })),
}));

vi.mock('glob', () => ({
  glob: vi.fn().mockResolvedValue([]),
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

vi.mock('execa', () => ({ execa: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }) }));

// ─── Imports ────────────────────────────────────────────────────────────────

import request from 'supertest';
import fs from 'fs-extra';
import { glob } from 'glob';
import { createGuiApp } from '../../src/lib/gui-server/index.js';
import { runFlowQuality } from '../../src/lib/flow-quality.js';

// ─── Shared config & helpers ──────────────────────────────────────────────────

const MOCK_CONFIG = {
  _projectRoot: '/project',
  _configDir: '/project/.sfdt',
  projectName: 'Test Project',
  defaultOrg: 'dev',
  sourceApiVersion: '59.0',
  defaultSourcePath: 'force-app/main/default',
  logDir: '/project/logs',
  testConfig: { testClasses: ['ExistingTest'] },
  features: { ai: false },
};

const VERSION = '0.0.0';
const PORT = 7654;

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
  fs.pathExists.mockResolvedValue(false);
  glob.mockResolvedValue([]);
});

// ─── GET /api/test/classes — discovery ────────────────────────────────────────

describe('GET /api/test/classes', () => {
  it('returns configured classes and discovered *Test classes from globbed files', async () => {
    fs.pathExists.mockResolvedValue(true);
    glob.mockResolvedValue([
      'classes/FooTest.cls',
      'classes/BarTests.cls',
      'classes/Helper.cls',   // filtered out (no Test suffix)
      'classes/ExistingTest.cls', // filtered out (already configured)
    ]);

    const res = await request(app).get('/api/test/classes');
    expect(res.status).toBe(200);
    expect(res.body.configured).toEqual(['ExistingTest']);
    expect(res.body.discovered).toEqual(['BarTests', 'FooTest']);
  });

  it('returns empty discovered list when the source path is absent', async () => {
    fs.pathExists.mockResolvedValue(false);
    const res = await request(app).get('/api/test/classes');
    expect(res.status).toBe(200);
    expect(res.body.discovered).toEqual([]);
  });
});

// ─── GET /api/manifest/discover ───────────────────────────────────────────────

describe('GET /api/manifest/discover', () => {
  it('returns 400 when type is missing', async () => {
    const res = await request(app).get('/api/manifest/discover');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/type is required/);
  });

  it('discovers ApexClass members, excluding requested names', async () => {
    fs.pathExists.mockResolvedValue(true);
    glob.mockResolvedValue(['classes/Alpha.cls', 'classes/Beta.cls', 'classes/Gamma.cls']);

    const res = await request(app).get('/api/manifest/discover?type=ApexClass&exclude=Beta');
    expect(res.status).toBe(200);
    expect(res.body.members).toEqual(['Alpha', 'Gamma']);
  });

  it('returns an empty list for an unknown metadata type', async () => {
    const res = await request(app).get('/api/manifest/discover?type=NotARealType');
    expect(res.status).toBe(200);
    expect(res.body.members).toEqual([]);
  });

  it('returns an empty list when the source path does not exist', async () => {
    fs.pathExists.mockResolvedValue(false);
    const res = await request(app).get('/api/manifest/discover?type=ApexClass');
    expect(res.status).toBe(200);
    expect(res.body.members).toEqual([]);
  });
});

// ─── POST /api/flow/quality ───────────────────────────────────────────────────

describe('POST /api/flow/quality', () => {
  it('returns 400 when metadata is missing', async () => {
    const res = await request(app)
      .post('/api/flow/quality')
      .set('X-SFDT-CSRF', csrf)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/metadata/);
  });

  it('runs flow-core and returns the report for a metadata payload', async () => {
    const res = await request(app)
      .post('/api/flow/quality')
      .set('X-SFDT-CSRF', csrf)
      .send({ metadata: { processType: 'Flow' }, flowApiName: 'My_Flow' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ score: 90, violations: [] });
    expect(runFlowQuality).toHaveBeenCalledOnce();
  });

  it('returns 500 when the flow-core engine throws', async () => {
    runFlowQuality.mockImplementation(() => { throw new Error('bad flow metadata'); });
    const res = await request(app)
      .post('/api/flow/quality')
      .set('X-SFDT-CSRF', csrf)
      .send({ metadata: { processType: 'Flow' } });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/bad flow metadata/);
  });
});
