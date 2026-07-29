/**
 * Route tests for the Manifest Builder endpoints (PR-1 of the visual manifest
 * builder mini-plan):
 *
 *   GET  /api/manifest/discover-org  (org types / members, scan-snapshot cache, refresh)
 *   POST /api/manifest/render        (additive XML, destructive pair, wildcard)
 *   POST /api/manifest/save          (new rl-… file(s), batch-add into existing manifest)
 *
 * metadata-mapper.js is NOT mocked — the single-writer rule says every surface
 * renders through the real renderPackageXml, so these tests assert its actual
 * output. execa is mocked to emulate `sf org list metadata-types` /
 * `sf org list metadata`; fs-extra is mocked for the save paths.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

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
    readJson: vi.fn().mockRejectedValue(new Error('ENOENT')),
    readdir: vi.fn().mockResolvedValue([]),
    readFile: vi.fn().mockResolvedValue(''),
    writeFile: vi.fn().mockResolvedValue(undefined),
    outputJson: vi.fn().mockResolvedValue(undefined),
    writeJson: vi.fn().mockResolvedValue(undefined),
    ensureDir: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ mtime: new Date(), size: 0, isDirectory: () => false }),
    remove: vi.fn().mockResolvedValue(undefined),
  },
}));

const execa = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({ execa }));

import request from 'supertest';
import fs from 'fs-extra';
import { createGuiApp } from '../../src/lib/gui-server/index.js';

const MOCK_CONFIG = {
  _projectRoot: '/project',
  _configDir: '/project/.sfdt',
  projectName: 'Test Project',
  defaultOrg: 'dev',
  sourceApiVersion: '59.0',
  defaultSourcePath: 'force-app/main/default',
  manifestDir: 'manifest/release',
  logDir: '/project/logs',
  features: {},
};

// Default sf CLI behaviour: types list + ApexClass members.
function mockSfHappyPath() {
  execa.mockImplementation(async (_bin, args = []) => {
    if (args.includes('metadata-types')) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          result: { metadataObjects: [{ xmlName: 'Flow' }, { xmlName: 'ApexClass' }] },
        }),
        stderr: '',
      };
    }
    if (args.includes('metadata')) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          result: [
            { fullName: 'Beta', lastModifiedDate: '2026-01-01' },
            { fullName: 'Alpha', lastModifiedDate: '2026-01-02' },
          ],
        }),
        stderr: '',
      };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });
}

let app;
let csrf;
beforeAll(async () => {
  app = createGuiApp(MOCK_CONFIG, '0.0.0', 7654);
  csrf = (await request(app).get('/api/csrf-token')).body.token;
});

beforeEach(() => {
  vi.clearAllMocks();
  fs.pathExists.mockResolvedValue(false);
  fs.readJson.mockRejectedValue(new Error('ENOENT'));
  mockSfHappyPath();
});

// ─── GET /api/manifest/discover-org ──────────────────────────────────────────

describe('GET /api/manifest/discover-org', () => {
  it('requires an org', async () => {
    const res = await request(app).get('/api/manifest/discover-org');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/org is required/);
  });

  it('rejects an invalid org alias', async () => {
    const res = await request(app).get('/api/manifest/discover-org?org=--danger&types=1');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid org alias/);
  });

  it('lists metadata types with ?types=1 (sorted, live)', async () => {
    const res = await request(app).get('/api/manifest/discover-org?org=dev&types=1');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ org: 'dev', types: ['ApexClass', 'Flow'], cached: false });
  });

  it('requires type when types=1 is not passed', async () => {
    const res = await request(app).get('/api/manifest/discover-org?org=dev');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/type is required/);
  });

  it('rejects an invalid metadata type', async () => {
    const res = await request(app).get('/api/manifest/discover-org?org=dev&type=Apex%20Class;rm');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid metadata type/);
  });

  it('lists members of one type (sorted, live)', async () => {
    const res = await request(app).get('/api/manifest/discover-org?org=dev&type=ApexClass');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      org: 'dev',
      type: 'ApexClass',
      members: ['Alpha', 'Beta'],
      cached: false,
    });
  });

  it('serves types and members from a fresh scan snapshot without shelling out', async () => {
    fs.readJson.mockResolvedValue({
      timestamp: new Date().toISOString(),
      org: 'dev',
      inventory: { ApexClass: ['Zed', 'Abc'], Flow: ['My_Flow'] },
    });

    const typesRes = await request(app).get('/api/manifest/discover-org?org=dev&types=1');
    expect(typesRes.status).toBe(200);
    expect(typesRes.body).toMatchObject({ types: ['ApexClass', 'Flow'], cached: true });

    const membersRes = await request(app).get('/api/manifest/discover-org?org=dev&type=ApexClass');
    expect(membersRes.status).toBe(200);
    expect(membersRes.body).toMatchObject({ members: ['Abc', 'Zed'], cached: true });

    expect(execa).not.toHaveBeenCalled();
  });

  it('ignores a stale scan snapshot', async () => {
    fs.readJson.mockResolvedValue({
      timestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1h old > 15m TTL
      org: 'dev',
      inventory: { ApexClass: ['Cached'] },
    });
    const res = await request(app).get('/api/manifest/discover-org?org=dev&type=ApexClass');
    expect(res.status).toBe(200);
    expect(res.body.cached).toBe(false);
    expect(res.body.members).toEqual(['Alpha', 'Beta']);
  });

  it('ignores a snapshot for a different org', async () => {
    fs.readJson.mockResolvedValue({
      timestamp: new Date().toISOString(),
      org: 'other-org',
      inventory: { ApexClass: ['Cached'] },
    });
    const res = await request(app).get('/api/manifest/discover-org?org=dev&type=ApexClass');
    expect(res.body.cached).toBe(false);
  });

  it('bypasses the snapshot with ?refresh=1', async () => {
    fs.readJson.mockResolvedValue({
      timestamp: new Date().toISOString(),
      org: 'dev',
      inventory: { ApexClass: ['Cached'] },
    });
    const res = await request(app).get('/api/manifest/discover-org?org=dev&type=ApexClass&refresh=1');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ cached: false, members: ['Alpha', 'Beta'] });
    expect(execa).toHaveBeenCalled();
  });

  it('returns 502 (not an empty tree) when sf cannot list a type', async () => {
    execa.mockImplementation(async (_bin, args = []) => {
      if (args.includes('metadata')) throw new Error('listMetadata failed');
      return { exitCode: 0, stdout: '{}', stderr: '' };
    });
    const res = await request(app).get('/api/manifest/discover-org?org=dev&type=WeirdType');
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/Could not list WeirdType members/);
  });

  it('returns 500 with the real message when the types listing fails', async () => {
    execa.mockImplementation(async () => { throw new Error('org unreachable'); });
    const res = await request(app).get('/api/manifest/discover-org?org=dev&types=1');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/org unreachable/);
  });
});

// ─── POST /api/manifest/render ───────────────────────────────────────────────

describe('POST /api/manifest/render', () => {
  it('renders additive XML through renderPackageXml', async () => {
    const res = await request(app)
      .post('/api/manifest/render')
      .set('X-SFDT-CSRF', csrf)
      .send({ items: [{ type: 'ApexClass', member: 'Zed' }, { type: 'ApexClass', member: 'Abc' }] });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('additive');
    expect(res.body.xml).toContain('<members>Abc</members>');
    expect(res.body.xml).toContain('<name>ApexClass</name>');
    expect(res.body.xml).toContain('<version>59.0</version>');
  });

  it('collapses a wildcard member to the whole type', async () => {
    const res = await request(app)
      .post('/api/manifest/render')
      .set('X-SFDT-CSRF', csrf)
      .send({ items: [{ type: 'ApexClass', member: '*' }, { type: 'ApexClass', member: 'Abc' }] });
    expect(res.status).toBe(200);
    expect(res.body.xml).toContain('<members>*</members>');
    expect(res.body.xml).not.toContain('<members>Abc</members>');
  });

  it('honours an explicit apiVersion', async () => {
    const res = await request(app)
      .post('/api/manifest/render')
      .set('X-SFDT-CSRF', csrf)
      .send({ items: [{ type: 'Flow', member: 'F' }], apiVersion: '63.0' });
    expect(res.body.xml).toContain('<version>63.0</version>');
  });

  it('returns the destructive pair in destructive mode', async () => {
    const res = await request(app)
      .post('/api/manifest/render')
      .set('X-SFDT-CSRF', csrf)
      .send({ items: [{ type: 'ApexClass', member: 'Dead' }], mode: 'destructive' });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('destructive');
    expect(res.body.destructiveChangesXml).toContain('<members>Dead</members>');
    expect(res.body.emptyPackageXml).not.toContain('<types>');
    expect(res.body.emptyPackageXml).toContain('<version>59.0</version>');
    expect(res.body.xml).toBeUndefined();
  });

  it('rejects an unknown mode', async () => {
    const res = await request(app)
      .post('/api/manifest/render')
      .set('X-SFDT-CSRF', csrf)
      .send({ items: [{ type: 'ApexClass', member: 'A' }], mode: 'sideways' });
    expect(res.status).toBe(400);
  });

  it('rejects empty items', async () => {
    const res = await request(app)
      .post('/api/manifest/render')
      .set('X-SFDT-CSRF', csrf)
      .send({ items: [] });
    expect(res.status).toBe(400);
  });

  it('rejects a bad apiVersion', async () => {
    const res = await request(app)
      .post('/api/manifest/render')
      .set('X-SFDT-CSRF', csrf)
      .send({ items: [{ type: 'ApexClass', member: 'A' }], apiVersion: '63.0; rm -rf' });
    expect(res.status).toBe(400);
  });

  it('skips XML-injection members and 400s when nothing valid remains', async () => {
    const res = await request(app)
      .post('/api/manifest/render')
      .set('X-SFDT-CSRF', csrf)
      .send({ items: [{ type: 'ApexClass', member: '<script>alert(1)</script>' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No valid items/);
  });

  it('rejects a wrong CSRF token', async () => {
    const res = await request(app)
      .post('/api/manifest/render')
      .set('X-SFDT-CSRF', 'wrong-token')
      .send({ items: [{ type: 'ApexClass', member: 'A' }] });
    expect(res.status).toBe(403);
  });
});

// ─── POST /api/manifest/save ─────────────────────────────────────────────────

describe('POST /api/manifest/save', () => {
  it('saves a new additive rl-<name>-package.xml', async () => {
    const res = await request(app)
      .post('/api/manifest/save')
      .set('X-SFDT-CSRF', csrf)
      .send({ name: '1.2.3', items: [{ type: 'ApexClass', member: 'Foo' }] });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.files).toEqual([
      { filename: 'rl-1.2.3-package.xml', path: 'manifest/release/rl-1.2.3-package.xml' },
    ]);
    expect(fs.writeFile).toHaveBeenCalledTimes(1);
    const [writtenPath, writtenXml] = fs.writeFile.mock.calls[0];
    expect(writtenPath).toBe('/project/manifest/release/rl-1.2.3-package.xml');
    expect(writtenXml).toContain('<members>Foo</members>');
  });

  it('saves the destructive pair (destructiveChanges + empty package)', async () => {
    const res = await request(app)
      .post('/api/manifest/save')
      .set('X-SFDT-CSRF', csrf)
      .send({ name: 'cleanup', mode: 'destructive', items: [{ type: 'ApexClass', member: 'Old' }] });
    expect(res.status).toBe(200);
    expect(res.body.files.map((f) => f.filename)).toEqual([
      'rl-cleanup-destructiveChanges.xml',
      'rl-cleanup-package.xml',
    ]);
    expect(res.body.destructiveChangesXml).toContain('<members>Old</members>');
    expect(res.body.emptyPackageXml).not.toContain('<types>');
    expect(fs.writeFile).toHaveBeenCalledTimes(2);
  });

  it('409s when the package file already exists (before writing anything)', async () => {
    fs.pathExists.mockResolvedValue(true);
    const res = await request(app)
      .post('/api/manifest/save')
      .set('X-SFDT-CSRF', csrf)
      .send({ name: '1.2.3', items: [{ type: 'ApexClass', member: 'Foo' }] });
    expect(res.status).toBe(409);
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it('rejects an invalid release label', async () => {
    const res = await request(app)
      .post('/api/manifest/save')
      .set('X-SFDT-CSRF', csrf)
      .send({ name: '../evil', items: [{ type: 'ApexClass', member: 'Foo' }] });
    expect(res.status).toBe(400);
  });

  it('batch-adds items into an existing manifest via relPath', async () => {
    fs.readFile.mockResolvedValue(
      '<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n    <version>59.0</version>\n</Package>\n',
    );
    const res = await request(app)
      .post('/api/manifest/save')
      .set('X-SFDT-CSRF', csrf)
      .send({
        relPath: 'manifest/release/rl-1.0.0-package.xml',
        items: [
          { type: 'ApexClass', member: 'One' },
          { type: 'ApexClass', member: 'Two' },
          { type: 'Flow', member: 'My_Flow' },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, added: 3, path: 'manifest/release/rl-1.0.0-package.xml' });
    // One read + one write, not one round trip per component.
    expect(fs.readFile).toHaveBeenCalledTimes(1);
    expect(fs.writeFile).toHaveBeenCalledTimes(1);
    const written = fs.writeFile.mock.calls[0][1];
    expect(written).toContain('<members>One</members>');
    expect(written).toContain('<members>Two</members>');
    expect(written).toContain('<name>Flow</name>');
  });

  it('refuses to touch deployed/ manifests', async () => {
    const res = await request(app)
      .post('/api/manifest/save')
      .set('X-SFDT-CSRF', csrf)
      .send({
        relPath: 'manifest/release/deployed/rl-0.9.0-package.xml',
        items: [{ type: 'ApexClass', member: 'Foo' }],
      });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/read-only/);
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it('rejects path traversal in relPath', async () => {
    const res = await request(app)
      .post('/api/manifest/save')
      .set('X-SFDT-CSRF', csrf)
      .send({ relPath: '../outside.xml', items: [{ type: 'ApexClass', member: 'Foo' }] });
    expect(res.status).toBe(400);
  });

  it('rejects empty items', async () => {
    const res = await request(app)
      .post('/api/manifest/save')
      .set('X-SFDT-CSRF', csrf)
      .send({ name: '1.2.3', items: [] });
    expect(res.status).toBe(400);
  });

  it('rejects a wrong CSRF token', async () => {
    const res = await request(app)
      .post('/api/manifest/save')
      .set('X-SFDT-CSRF', 'wrong-token')
      .send({ name: '1.2.3', items: [{ type: 'ApexClass', member: 'Foo' }] });
    expect(res.status).toBe(403);
  });
});
