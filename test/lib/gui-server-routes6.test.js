/**
 * Route tests for the Flow Intelligence endpoints (/api/flow/scan,
 * /api/flow/conflicts, /api/flow/graph) and the audit trail endpoint
 * (/api/audit/logs). Each exercises the cached-snapshot read (GET), the
 * validation + dispatch branches (POST), and the 500 error path.
 *
 * Mirrors the mocking strategy of the sibling gui-server route tests:
 * fs-extra and the heavy collaborators are mocked, the app is built with
 * createGuiApp, and CSRF/Origin are supplied by the setup-supertest-origin
 * shim.
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

vi.mock('../../src/lib/flow-analyzer.js', () => ({
  runFlowScan: vi.fn(),
  runFlowConflicts: vi.fn(),
  runFlowGraph: vi.fn(),
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
  },
}));

vi.mock('execa', () => ({
  execa: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
}));

// ─── Imports ────────────────────────────────────────────────────────────────

import request from 'supertest';
import fs from 'fs-extra';
import { createGuiApp } from '../../src/lib/gui-server/index.js';
import { runFlowScan, runFlowConflicts, runFlowGraph } from '../../src/lib/flow-analyzer.js';

// ─── Shared config ───────────────────────────────────────────────────────────

const MOCK_CONFIG = {
  _projectRoot: '/project',
  _configDir: '/project/.sfdt',
  projectName: 'Test Project',
  defaultOrg: 'dev',
  sourceApiVersion: '59.0',
  defaultSourcePath: 'force-app/main/default',
  logDir: '/project/logs',
  features: { ai: false },
};

const VERSION = '0.0.0';
const PORT = 7654;

let app;
beforeAll(() => {
  app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
});
afterAll(async () => {
  await app.cleanup?.();
});
beforeEach(() => {
  vi.clearAllMocks();
  fs.pathExists.mockResolvedValue(false);
  fs.readJson.mockResolvedValue(null);
  fs.outputJson.mockResolvedValue(undefined);
});

// ─── Flow Intelligence GET endpoints (cached snapshot reads) ──────────────────

// One table drives the three structurally-identical GET routes.
const GET_ENDPOINTS = [
  { route: '/api/flow/scan', file: 'flow-scan-latest.json' },
  { route: '/api/flow/conflicts', file: 'flow-conflicts-latest.json' },
  { route: '/api/flow/graph', file: 'flow-graph-latest.json' },
];

for (const { route, file } of GET_ENDPOINTS) {
  describe(`GET ${route}`, () => {
    it('returns 204 when no snapshot file exists', async () => {
      fs.pathExists.mockResolvedValue(false);
      const res = await request(app).get(route);
      expect(res.status).toBe(204);
    });

    it('returns the cached snapshot when the file exists', async () => {
      fs.pathExists.mockResolvedValue(true);
      fs.readJson.mockResolvedValue({ org: 'dev', source: file, flows: [] });
      const res = await request(app).get(route);
      expect(res.status).toBe(200);
      expect(res.body.org).toBe('dev');
      expect(res.body.source).toBe(file);
    });

    it('returns 500 when reading the snapshot throws', async () => {
      fs.pathExists.mockRejectedValue(new Error('disk gone'));
      const res = await request(app).get(route);
      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/disk gone/);
    });
  });
}

// ─── Flow Intelligence POST endpoints (validation + dispatch) ─────────────────

const POST_ENDPOINTS = [
  { route: '/api/flow/scan', runner: runFlowScan },
  { route: '/api/flow/conflicts', runner: runFlowConflicts },
  { route: '/api/flow/graph', runner: runFlowGraph },
];

for (const { route, runner } of POST_ENDPOINTS) {
  describe(`POST ${route}`, () => {
    it('returns 400 when org is missing', async () => {
      const res = await request(app).post(route).send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/org is required/i);
    });

    it('returns 400 when org alias is malformed', async () => {
      const res = await request(app).post(route).send({ org: '../etc/passwd' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/invalid org alias/i);
    });

    it('runs the analyzer, persists the result, and returns it', async () => {
      vi.mocked(runner).mockResolvedValue({ org: 'dev', ok: true });
      const res = await request(app).post(route).send({ org: 'dev' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ org: 'dev', ok: true });
      expect(runner).toHaveBeenCalledOnce();
      expect(fs.outputJson).toHaveBeenCalledOnce();
    });

    it('returns 500 when the analyzer throws', async () => {
      vi.mocked(runner).mockRejectedValue(new Error('sf cli exploded'));
      const res = await request(app).post(route).send({ org: 'dev' });
      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/sf cli exploded/);
    });
  });
}

// ─── Audit trail ──────────────────────────────────────────────────────────────

describe('GET /api/audit/logs', () => {
  it('returns an empty logs array when audit.json does not exist', async () => {
    fs.pathExists.mockResolvedValue(false);
    const res = await request(app).get('/api/audit/logs');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ logs: [] });
  });

  it('returns the persisted audit log entries when the file exists', async () => {
    fs.pathExists.mockResolvedValue(true);
    const entries = [{ event: 'deploy', at: '2026-06-27T00:00:00Z' }];
    fs.readJson.mockResolvedValue(entries);
    const res = await request(app).get('/api/audit/logs');
    expect(res.status).toBe(200);
    expect(res.body.logs).toEqual(entries);
  });

  it('returns 500 when reading audit.json throws', async () => {
    fs.pathExists.mockRejectedValue(new Error('permission denied'));
    const res = await request(app).get('/api/audit/logs');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/permission denied/);
  });
});
