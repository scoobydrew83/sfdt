/**
 * Route tests for GET /api/scan and POST /api/scan.
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

vi.mock('../../src/lib/org-inventory.js', () => ({
  fetchOrgInventory: vi.fn(),
  fetchInventory: vi.fn().mockResolvedValue(new Map()),
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
import { createGuiApp } from '../../src/lib/gui-server/index.js';
import { fetchInventory } from '../../src/lib/org-inventory.js';

// ─── Shared config ───────────────────────────────────────────────────────────

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

// ─── Reset mocks ─────────────────────────────────────────────────────────────

beforeEach(async () => {
  vi.resetAllMocks();
  const { default: fsMock } = await import('fs-extra');
  fsMock.existsSync.mockReturnValue(false);
  fsMock.pathExists.mockResolvedValue(false);
  fsMock.readJson.mockResolvedValue(null);
  fsMock.readdir.mockResolvedValue([]);
  fsMock.readFile.mockResolvedValue('');
  fsMock.outputJson.mockResolvedValue(undefined);
  fsMock.stat.mockResolvedValue({ mtime: new Date(), size: 0, isDirectory: () => false });
  fsMock.remove.mockResolvedValue(undefined);
  fsMock.ensureDir.mockResolvedValue(undefined);
  fsMock.writeFile.mockResolvedValue(undefined);
  fsMock.writeJson.mockResolvedValue(undefined);
  vi.mocked(fetchInventory).mockResolvedValue(new Map());
});

// ─── GET /api/scan ────────────────────────────────────────────────────────────

describe('GET /api/scan', () => {
  let app;

  beforeAll(() => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns 204 when scan-latest.json does not exist', async () => {
    // readJson default mock returns null (set in beforeEach)
    const res = await request(app).get('/api/scan');
    expect(res.status).toBe(204);
  });

  it('returns scan data when scan-latest.json exists', async () => {
    const scanPayload = {
      timestamp: '2026-05-09T10:15:00.000Z',
      org: 'my-sandbox',
      inventory: { ApexClass: ['Foo', 'Bar'], Flow: ['OnboardingFlow'] },
      summary: { totalTypes: 2, totalMembers: 3 },
    };
    const { default: fsMock } = await import('fs-extra');
    fsMock.readJson.mockResolvedValue(scanPayload);

    const res = await request(app).get('/api/scan');
    expect(res.status).toBe(200);
    expect(res.body.org).toBe('my-sandbox');
    expect(res.body.summary.totalTypes).toBe(2);
    expect(res.body.inventory.ApexClass).toEqual(['Foo', 'Bar']);
  });
});

// ─── POST /api/scan ───────────────────────────────────────────────────────────

describe('POST /api/scan', () => {
  let app;
  let csrf;

  beforeAll(async () => {
    app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
    csrf = (await request(app).get('/api/csrf-token')).body.token;
  });

  afterAll(async () => {
    await app.cleanup?.();
  });

  it('returns 400 when org is missing from request body', async () => {
    const res = await request(app).post('/api/scan').set('X-SFDT-CSRF', csrf).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/org is required/i);
  });

  it('returns 400 when org is an empty string', async () => {
    const res = await request(app).post('/api/scan').set('X-SFDT-CSRF', csrf).send({ org: '  ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/org is required/i);
  });

  it('returns 400 when org contains invalid characters', async () => {
    const res = await request(app).post('/api/scan').set('X-SFDT-CSRF', csrf).send({ org: '--dry-run' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid org alias/i);
  });

  it('returns 200 with correct scan shape when fetchInventory succeeds', async () => {
    vi.mocked(fetchInventory).mockResolvedValue(
      new Map([
        ['ApexClass', new Set(['Foo', 'Bar'])],
        ['Flow', new Set(['OnboardingFlow'])],
      ])
    );

    const res = await request(app).post('/api/scan').set('X-SFDT-CSRF', csrf).send({ org: 'my-sandbox' });
    expect(res.status).toBe(200);
    expect(res.body.org).toBe('my-sandbox');
    expect(typeof res.body.timestamp).toBe('string');
    expect(res.body.summary.totalTypes).toBe(2);
    expect(res.body.summary.totalMembers).toBe(3);
    expect(res.body.inventory.ApexClass).toEqual(expect.arrayContaining(['Foo', 'Bar']));
    expect(res.body.inventory.Flow).toEqual(['OnboardingFlow']);
  });

  it('writes scan-latest.json when fetchInventory succeeds', async () => {
    vi.mocked(fetchInventory).mockResolvedValue(
      new Map([['ApexClass', new Set(['MyClass'])]])
    );
    const { default: fsMock } = await import('fs-extra');

    await request(app).post('/api/scan').set('X-SFDT-CSRF', csrf).send({ org: 'dev' });

    expect(fsMock.outputJson).toHaveBeenCalledWith(
      expect.stringContaining('scan-latest.json'),
      expect.objectContaining({ org: 'dev' }),
      { spaces: 2 }
    );
  });

  it('returns 500 when fetchInventory throws', async () => {
    vi.mocked(fetchInventory).mockRejectedValue(new Error('sf CLI not found'));

    const res = await request(app).post('/api/scan').set('X-SFDT-CSRF', csrf).send({ org: 'dev' });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/sf CLI not found/);
  });
});
