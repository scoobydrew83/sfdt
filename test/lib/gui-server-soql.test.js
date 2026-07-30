/**
 * Route tests for the SOQL console endpoints (D-4):
 *
 *   GET  /api/soql/sobjects       (schema search)
 *   GET  /api/soql/describe       (fields + child relationships)
 *   GET  /api/soql/relationships  (parents + children)
 *   POST /api/soql/validate       (local checks + org LIMIT 0 round-trip)
 *   POST /api/soql/plan           (REST explain — never executed)
 *   POST /api/soql/query          (bounded SOQL execution + runner-shaped csv)
 *   POST /api/soql/sosl           (bounded SOSL execution)
 *
 * soql-runner.js is NOT mocked — the single-engine rule says the GUI surfaces
 * the same runner as `sfdt soql`, so these tests assert its real behaviour
 * (bound resolution, clamping, truncation metadata, CSV shaping). execa is
 * mocked to emulate the `sf` CLI, matching gui-server-manifest-builder.test.js.
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
  logDir: '/project/logs',
  features: {},
  soql: { defaultLimit: 200, maxLimit: 2000 },
};

const QUERY_RECORDS = [
  { attributes: { type: 'Account' }, Id: '001xx0000000001', Name: 'Acme', Owner: { attributes: { type: 'User' }, Name: 'Drew' } },
  { attributes: { type: 'Account' }, Id: '001xx0000000002', Name: 'Globex', Owner: { attributes: { type: 'User' }, Name: 'Sam' } },
];

// Default sf CLI behaviour for every soql-runner call path.
function mockSfHappyPath() {
  execa.mockImplementation(async (_bin, args = []) => {
    if (args[0] === 'sobject' && args[1] === 'list') {
      return { exitCode: 0, stdout: JSON.stringify({ result: ['Account', 'Asset__c', 'Case'] }), stderr: '' };
    }
    if (args[0] === 'sobject' && args[1] === 'describe') {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          result: {
            name: 'Account', label: 'Account', custom: false, queryable: true, keyPrefix: '001',
            fields: [
              { name: 'Id', label: 'Account ID', type: 'id', nillable: false, custom: false },
              { name: 'Name', label: 'Account Name', type: 'string', length: 255, nillable: false, custom: false },
              { name: 'OwnerId', label: 'Owner ID', type: 'reference', nillable: false, custom: false, referenceTo: ['User'], relationshipName: 'Owner' },
              { name: 'Status__c', label: 'Status', type: 'picklist', nillable: true, custom: true, picklistValues: [{ active: true, value: 'Open' }, { active: false, value: 'Retired' }] },
            ],
            childRelationships: [
              { childSObject: 'Contact', relationshipName: 'Contacts', field: 'AccountId' },
              { childSObject: 'CaseHistory', relationshipName: null, field: 'AccountId' },
            ],
          },
        }),
        stderr: '',
      };
    }
    if (args[0] === 'data' && args[1] === 'query') {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ result: { records: QUERY_RECORDS, totalSize: 2, done: true } }),
        stderr: '',
      };
    }
    if (args[0] === 'data' && args[1] === 'search') {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ result: { searchRecords: [{ attributes: { type: 'Account' }, Id: '001xx0000000001', Name: 'Acme' }] } }),
        stderr: '',
      };
    }
    if (args[0] === 'api') {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          plans: [{
            leadingOperationType: 'Index', relativeCost: 0.4, cardinality: 10,
            sobjectCardinality: 1000, sobjectType: 'Account', fields: ['Name'],
            notes: [{ description: 'Not considering filter', fields: ['IsDeleted'], tableEnumOrId: 'Account' }],
          }],
        }),
        stderr: '',
      };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });
}

/** Error whose stdout carries sf's JSON error envelope (what org-query/runSf parse). */
function sfFailure(message) {
  return Object.assign(new Error('Command failed: sf'), {
    stdout: JSON.stringify({ status: 1, message }),
    stderr: '',
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

// ─── GET /api/soql/sobjects ──────────────────────────────────────────────────

describe('GET /api/soql/sobjects', () => {
  it('lists sObjects filtered by a case-insensitive term', async () => {
    const res = await request(app).get('/api/soql/sobjects?org=dev&term=as');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      org: 'dev',
      term: 'as',
      category: 'all',
      totalScanned: 3,
      totalMatched: 2,
      truncated: false,
      matches: ['Asset__c', 'Case'],
    });
  });

  it('falls back to config.defaultOrg when no org is passed', async () => {
    const res = await request(app).get('/api/soql/sobjects');
    expect(res.status).toBe(200);
    expect(res.body.org).toBe('dev');
  });

  it('rejects an invalid org alias', async () => {
    const res = await request(app).get('/api/soql/sobjects?org=--danger');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid org alias/);
    expect(execa).not.toHaveBeenCalled();
  });

  it('rejects an unknown category', async () => {
    const res = await request(app).get('/api/soql/sobjects?org=dev&category=weird');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/category must be one of/);
  });

  it('surfaces the real sf error, never a fabricated empty list', async () => {
    execa.mockRejectedValue(sfFailure('No authorization information found for dev.'));
    const res = await request(app).get('/api/soql/sobjects?org=dev');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/No authorization information/);
  });
});

// ─── GET /api/soql/describe ──────────────────────────────────────────────────

describe('GET /api/soql/describe', () => {
  it('describes an sObject (fields, picklists, references, children)', async () => {
    const res = await request(app).get('/api/soql/describe?org=dev&name=Account');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ org: 'dev', name: 'Account', fieldCount: 4 });
    const owner = res.body.fields.find((f) => f.name === 'OwnerId');
    expect(owner).toMatchObject({ type: 'reference', referenceTo: ['User'], relationshipName: 'Owner' });
    const status = res.body.fields.find((f) => f.name === 'Status__c');
    expect(status.picklistValues).toEqual(['Open']); // inactive values dropped
    // Relationships without a relationshipName are unusable in SOQL — dropped.
    expect(res.body.childRelationships).toEqual([
      { childSObject: 'Contact', relationshipName: 'Contacts', field: 'AccountId' },
    ]);
  });

  it('applies the field filter (matches API name or label)', async () => {
    const res = await request(app).get('/api/soql/describe?org=dev&name=Account&filter=name');
    expect(res.status).toBe(200);
    expect(res.body.fields.map((f) => f.name)).toEqual(['Name']);
    expect(res.body.fieldCount).toBe(4); // total is unfiltered
  });

  it('rejects a malformed sObject name', async () => {
    const res = await request(app).get('/api/soql/describe?org=dev&name=Account;rm');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid sObject name/);
    expect(execa).not.toHaveBeenCalled();
  });

  it('surfaces the real describe failure', async () => {
    execa.mockRejectedValue(sfFailure('The requested resource does not exist'));
    const res = await request(app).get('/api/soql/describe?org=dev&name=Nope__c');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/resource does not exist/);
  });
});

// ─── GET /api/soql/relationships ─────────────────────────────────────────────

describe('GET /api/soql/relationships', () => {
  it('returns parents (dot notation) and children (subqueries)', async () => {
    const res = await request(app).get('/api/soql/relationships?org=dev&name=Account');
    expect(res.status).toBe(200);
    expect(res.body.parents).toEqual([
      { field: 'OwnerId', relationshipName: 'Owner', referenceTo: ['User'], nillable: false },
    ]);
    expect(res.body.children).toEqual([
      { childSObject: 'Contact', relationshipName: 'Contacts', field: 'AccountId' },
    ]);
  });

  it('rejects an unknown direction', async () => {
    const res = await request(app).get('/api/soql/relationships?org=dev&name=Account&direction=up');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/direction must be one of/);
  });
});

// ─── POST /api/soql/validate ─────────────────────────────────────────────────

describe('POST /api/soql/validate', () => {
  it('round-trips the org with LIMIT 0 and reports an org-mode pass', async () => {
    const res = await request(app)
      .post('/api/soql/validate')
      .set('X-SFDT-CSRF', csrf)
      .send({ query: 'SELECT Id FROM Account', org: 'dev' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ valid: true, mode: 'org', kind: 'soql' });
    // The validation query must never materialise rows.
    const queryArg = execa.mock.calls[0][1][execa.mock.calls[0][1].indexOf('--query') + 1];
    expect(queryArg).toMatch(/LIMIT 0$/);
  });

  it("returns the org's verdict verbatim for an invalid query (200, valid:false)", async () => {
    execa.mockRejectedValue(sfFailure("SELECT Nope FROM Account\nERROR at Row:1:Column:8\nNo such column 'Nope' on entity 'Account'."));
    const res = await request(app)
      .post('/api/soql/validate')
      .set('X-SFDT-CSRF', csrf)
      .send({ query: 'SELECT Nope FROM Account', org: 'dev' });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.mode).toBe('org');
    expect(res.body.errors[0]).toMatch(/No such column 'Nope'/);
  });

  it('degrades to a local-only verdict (never a fabricated org pass) when the org is unreachable', async () => {
    execa.mockRejectedValue(sfFailure('No authorization information found for dev.'));
    const res = await request(app)
      .post('/api/soql/validate')
      .set('X-SFDT-CSRF', csrf)
      .send({ query: 'SELECT Id FROM Account LIMIT 5', org: 'dev' });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('local');
    expect(res.body.valid).toBe(true);
    expect(res.body.warnings.join(' ')).toMatch(/not reachable.*local checks only/);
  });

  it('requires a query', async () => {
    const res = await request(app)
      .post('/api/soql/validate')
      .set('X-SFDT-CSRF', csrf)
      .send({ org: 'dev' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/query is required/);
  });

  it('rejects a wrong CSRF token', async () => {
    const res = await request(app)
      .post('/api/soql/validate')
      .set('X-SFDT-CSRF', 'wrong-token')
      .send({ query: 'SELECT Id FROM Account' });
    expect(res.status).toBe(403);
  });
});

// ─── POST /api/soql/plan ─────────────────────────────────────────────────────

describe('POST /api/soql/plan', () => {
  it('returns the mapped query plans without executing the query', async () => {
    const res = await request(app)
      .post('/api/soql/plan')
      .set('X-SFDT-CSRF', csrf)
      .send({ query: 'SELECT Id FROM Account', org: 'dev' });
    expect(res.status).toBe(200);
    expect(res.body.apiVersion).toBe('59.0');
    expect(res.body.plans).toHaveLength(1);
    expect(res.body.plans[0]).toMatchObject({ leadingOperationType: 'Index', relativeCost: 0.4 });
    // Only the REST explain endpoint is hit — no `sf data query` execution.
    expect(execa.mock.calls.every(([, args]) => args[0] === 'api')).toBe(true);
    expect(execa.mock.calls[0][1][3]).toContain('/query/?explain=');
  });

  it('rejects a malformed apiVersion', async () => {
    const res = await request(app)
      .post('/api/soql/plan')
      .set('X-SFDT-CSRF', csrf)
      .send({ query: 'SELECT Id FROM Account', apiVersion: '64.0; rm -rf' });
    expect(res.status).toBe(400);
  });

  it('surfaces the REST error array as the real message', async () => {
    execa.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify([{ errorCode: 'INVALID_FIELD', message: "No such column 'Nope'" }]),
      stderr: '',
    });
    const res = await request(app)
      .post('/api/soql/plan')
      .set('X-SFDT-CSRF', csrf)
      .send({ query: 'SELECT Nope FROM Account', org: 'dev' });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/INVALID_FIELD: No such column 'Nope'/);
  });
});

// ─── POST /api/soql/query ────────────────────────────────────────────────────

describe('POST /api/soql/query', () => {
  it('applies the configured default bound to an unbounded query', async () => {
    const res = await request(app)
      .post('/api/soql/query')
      .set('X-SFDT-CSRF', csrf)
      .send({ query: 'SELECT Id, Name FROM Account', org: 'dev' });
    expect(res.status).toBe(200);
    expect(res.body.bound).toEqual({ limit: 200, max: 2000, action: 'appended' });
    expect(res.body.query).toMatch(/LIMIT 200$/);
    expect(res.body.returned).toBe(2);
    expect(res.body.truncated).toBe(false);
    // The sf CLI ran the BOUNDED query, not the raw one.
    const queryArg = execa.mock.calls[0][1][execa.mock.calls[0][1].indexOf('--query') + 1];
    expect(queryArg).toMatch(/LIMIT 200$/);
    // Records are cleaned of the sf `attributes` wrapper.
    expect(res.body.records[0]).toEqual({ Id: '001xx0000000001', Name: 'Acme', Owner: { Name: 'Drew' } });
  });

  it('clamps a requested limit above soql.maxLimit', async () => {
    const res = await request(app)
      .post('/api/soql/query')
      .set('X-SFDT-CSRF', csrf)
      .send({ query: 'SELECT Id FROM Account', org: 'dev', limit: 99999 });
    expect(res.status).toBe(200);
    expect(res.body.bound).toEqual({ limit: 2000, max: 2000, action: 'appended' });
    expect(res.body.query).toMatch(/LIMIT 2000$/);
  });

  it('keeps an in-query LIMIT at or under the cap', async () => {
    const res = await request(app)
      .post('/api/soql/query')
      .set('X-SFDT-CSRF', csrf)
      .send({ query: 'SELECT Id FROM Account LIMIT 5', org: 'dev' });
    expect(res.status).toBe(200);
    expect(res.body.bound).toEqual({ limit: 5, max: 2000, action: 'kept' });
  });

  it('reports truncation when the org has more rows than were returned', async () => {
    execa.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ result: { records: QUERY_RECORDS, totalSize: 5000, done: false } }),
      stderr: '',
    });
    const res = await request(app)
      .post('/api/soql/query')
      .set('X-SFDT-CSRF', csrf)
      .send({ query: 'SELECT Id FROM Account', org: 'dev' });
    expect(res.body.truncated).toBe(true);
    expect(res.body.totalSize).toBe(5000);
  });

  it("includes the runner's own CSV shaping (dot-path parent columns)", async () => {
    const res = await request(app)
      .post('/api/soql/query')
      .set('X-SFDT-CSRF', csrf)
      .send({ query: 'SELECT Id, Name, Owner.Name FROM Account', org: 'dev' });
    const [header, first] = res.body.csv.split('\n');
    expect(header).toBe('Id,Name,Owner.Name');
    expect(first).toBe('001xx0000000001,Acme,Drew');
  });

  it('rejects invalid SOQL with the real validation message (400)', async () => {
    const res = await request(app)
      .post('/api/soql/query')
      .set('X-SFDT-CSRF', csrf)
      .send({ query: 'SELECT * FROM Account', org: 'dev' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid SOQL: SOQL has no `SELECT \*`/);
    expect(execa).not.toHaveBeenCalled();
  });

  it('rejects a non-SELECT statement (400)', async () => {
    const res = await request(app)
      .post('/api/soql/query')
      .set('X-SFDT-CSRF', csrf)
      .send({ query: 'DELETE FROM Account', org: 'dev' });
    expect(res.status).toBe(400);
    expect(execa).not.toHaveBeenCalled();
  });

  it('refuses SOSL on the query route (400, pointing at sosl)', async () => {
    const res = await request(app)
      .post('/api/soql/query')
      .set('X-SFDT-CSRF', csrf)
      .send({ query: 'FIND {Acme} IN ALL FIELDS', org: 'dev' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/SOSL/);
  });

  it('rejects a non-numeric limit (400)', async () => {
    const res = await request(app)
      .post('/api/soql/query')
      .set('X-SFDT-CSRF', csrf)
      .send({ query: 'SELECT Id FROM Account', org: 'dev', limit: 'lots' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/--limit must be a positive integer/);
  });

  it('surfaces the real org failure (500), never fabricated empty rows', async () => {
    execa.mockRejectedValue(sfFailure('INVALID_TYPE: sObject type Secret__x is not supported'));
    const res = await request(app)
      .post('/api/soql/query')
      .set('X-SFDT-CSRF', csrf)
      .send({ query: 'SELECT Id FROM Secret__x', org: 'dev' });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/INVALID_TYPE/);
  });

  it('never writes files — an `out` path in the body is ignored', async () => {
    const res = await request(app)
      .post('/api/soql/query')
      .set('X-SFDT-CSRF', csrf)
      .send({ query: 'SELECT Id FROM Account', org: 'dev', out: '/tmp/evil.json', format: 'json' });
    expect(res.status).toBe(200);
    expect(res.body.export).toBeUndefined();
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it('rejects a wrong CSRF token', async () => {
    const res = await request(app)
      .post('/api/soql/query')
      .set('X-SFDT-CSRF', 'wrong-token')
      .send({ query: 'SELECT Id FROM Account' });
    expect(res.status).toBe(403);
  });
});

// ─── POST /api/soql/sosl ─────────────────────────────────────────────────────

describe('POST /api/soql/sosl', () => {
  it('executes a bounded SOSL search via sf data search', async () => {
    const res = await request(app)
      .post('/api/soql/sosl')
      .set('X-SFDT-CSRF', csrf)
      .send({ query: 'FIND {Acme} IN ALL FIELDS RETURNING Account(Id, Name)', org: 'dev' });
    expect(res.status).toBe(200);
    expect(res.body.bound).toEqual({ limit: 200, max: 2000, action: 'appended' });
    expect(res.body.returned).toBe(1);
    expect(res.body.records[0]).toEqual({ Id: '001xx0000000001', Name: 'Acme' });
    expect(res.body.csv.split('\n')[0]).toBe('Id,Name');
    expect(execa.mock.calls[0][1].slice(0, 2)).toEqual(['data', 'search']);
  });

  it('refuses SOQL on the sosl route (400)', async () => {
    const res = await request(app)
      .post('/api/soql/sosl')
      .set('X-SFDT-CSRF', csrf)
      .send({ query: 'SELECT Id FROM Account', org: 'dev' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/SOSL|SOQL/);
  });
});
