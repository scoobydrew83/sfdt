/**
 * Route tests for the capability dashboards added for the CLI features that
 * had no GUI page yet:
 *
 *   GET /api/scratch  (sfdt scratch pool status --json + sfdt scratch list --json)
 *   GET /api/data     (sfdt data list --json)
 *   GET /api/coverage (sfdt coverage --json — org-wide + per-class)
 *   GET /api/docs     (configured docs settings — no shell-out)
 *
 * execa is mocked to return the sf-native `{ status, result, warnings }`
 * envelope each command emits, keyed off the subcommand args.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

vi.mock('../../src/lib/log-writer.js', () => ({
  writeLog: vi.fn(),
  parseSfdtLogLines: vi.fn().mockReturnValue({ checks: [], components: [] }),
  readLatestLog: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/lib/update-checker.js', async (importActual) => ({
  ...(await importActual()),
  fetchLatestVersion: vi.fn().mockResolvedValue('1.0.0'),
}));

vi.mock('fs-extra', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(false),
    pathExists: vi.fn().mockResolvedValue(false),
    readJson: vi.fn().mockResolvedValue({}),
    readdir: vi.fn().mockResolvedValue([]),
    readFile: vi.fn().mockResolvedValue(''),
    outputJson: vi.fn().mockResolvedValue(undefined),
    writeJson: vi.fn().mockResolvedValue(undefined),
    ensureDir: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  },
}));

// Dispatch the mocked `sfdt <subcommand> --json` envelope off the args array.
const execa = vi.hoisted(() => vi.fn(async (_bin, args = []) => {
  const sub = args.filter((a) => !a.startsWith('-') && !a.includes('/')).join(' ');
  const env = (result, status = 0, message) => ({
    exitCode: status,
    stdout: JSON.stringify(status === 0 ? { status, result, warnings: [] } : { status, message, warnings: [] }),
    stderr: '',
  });
  if (sub.startsWith('scratch pool status')) return env({ size: 3, members: [{ alias: 'pool-1', orgId: '00D1', createdAt: '2026-06-20T00:00:00.000Z' }] });
  if (sub.startsWith('scratch list'))        return env({ orgs: [{ alias: 'sc1', username: 'a@b.com', orgId: '00D2', expirationDate: '2026-07-01', status: 'Active' }] });
  if (sub.startsWith('data list'))           return env({ sets: ['accounts', 'contacts'] });
  if (sub.startsWith('coverage'))            return env({ org: 'dev', threshold: 75, orgWide: 82, belowThreshold: false, classes: [{ name: 'Foo', covered: 8, uncovered: 2, total: 10, pct: 0.8 }] });
  return env(null);
}));
vi.mock('execa', () => ({ execa }));

import request from 'supertest';
import { createGuiApp } from '../../src/lib/gui-server/index.js';

const MOCK_CONFIG = {
  _projectRoot: '/project',
  _configDir: '/project/.sfdt',
  projectName: 'Test Project',
  defaultOrg: 'dev',
  logDir: '/project/logs',
  features: { ai: true },
  docs: { outputDir: 'site-docs', ai: true, diagrams: true, roleGuides: true, roles: ['developer', 'admin'] },
};

let app;
beforeAll(async () => {
  app = createGuiApp(MOCK_CONFIG, '0.0.0', 7654);
  await request(app).get('/api/csrf-token'); // warm up; these GETs need no CSRF
});
afterAll(async () => { await app.cleanup?.(); });
beforeEach(() => { execa.mockClear(); });

describe('GET /api/scratch', () => {
  it('returns pool status and active scratch orgs', async () => {
    const res = await request(app).get('/api/scratch');
    expect(res.status).toBe(200);
    expect(res.body.pool).toMatchObject({ size: 3 });
    expect(res.body.pool.members).toHaveLength(1);
    expect(res.body.orgs[0]).toMatchObject({ alias: 'sc1', status: 'Active' });
  });

  it('returns 500 when the command errors', async () => {
    execa.mockImplementationOnce(async () => ({ exitCode: 1, stdout: JSON.stringify({ status: 1, message: 'pool boom', warnings: [] }), stderr: '' }));
    const res = await request(app).get('/api/scratch');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/pool boom/);
  });
});

describe('GET /api/data', () => {
  it('returns the configured data sets', async () => {
    const res = await request(app).get('/api/data');
    expect(res.status).toBe(200);
    expect(res.body.sets).toEqual(['accounts', 'contacts']);
  });

  it('returns 500 on non-JSON output', async () => {
    execa.mockImplementationOnce(async () => ({ exitCode: 0, stdout: 'not json', stderr: '' }));
    const res = await request(app).get('/api/data');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/valid JSON/);
  });
});

describe('GET /api/coverage', () => {
  it('returns org-wide coverage and per-class rows', async () => {
    const res = await request(app).get('/api/coverage');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ org: 'dev', orgWide: 82, threshold: 75 });
    expect(res.body.classes[0]).toMatchObject({ name: 'Foo', pct: 0.8 });
  });
});

describe('GET /api/docs', () => {
  it('returns the configured docs settings without shelling out', async () => {
    const res = await request(app).get('/api/docs');
    expect(res.status).toBe(200);
    expect(res.body.config).toMatchObject({ outputDir: 'site-docs', diagrams: true, roleGuides: true });
    expect(res.body.config.roles).toEqual(['developer', 'admin']);
    expect(res.body.aiEnabled).toBe(true);
    expect(res.body.note).toMatch(/docs generate/);
    expect(execa).not.toHaveBeenCalled();
  });
});
