import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs-extra';

vi.mock('execa', () => ({ execa: vi.fn() }));

import { execa } from 'execa';
import {
  SOQL_DEFAULTS,
  DEFAULT_PLAN_API_VERSION,
  resolveBounds,
  parseLimit,
  applyLimit,
  validateLocal,
  rewriteForValidation,
  validateQuery,
  searchSObjects,
  describeSObject,
  discoverRelationships,
  explainQuery,
  runQuery,
  runSearch,
  stripAttributes,
  toCsv,
  writeExport,
} from '../../src/lib/soql-runner.js';

const CONFIG = { defaultOrg: 'dev', soql: { defaultLimit: 200, maxLimit: 2000 } };

const sfJson = (result) => ({ stdout: JSON.stringify({ status: 0, result }) });

beforeEach(() => vi.resetAllMocks());

describe('resolveBounds', () => {
  it('uses config soql.defaultLimit when no limit is requested', () => {
    expect(resolveBounds({ soql: { defaultLimit: 50, maxLimit: 100 } })).toEqual({ limit: 50, max: 100, clamped: false });
  });

  it('falls back to SOQL_DEFAULTS without a soql config block', () => {
    expect(resolveBounds({})).toEqual({ limit: SOQL_DEFAULTS.defaultLimit, max: SOQL_DEFAULTS.maxLimit, clamped: false });
  });

  it('clamps a requested limit above maxLimit', () => {
    expect(resolveBounds(CONFIG, 99999)).toEqual({ limit: 2000, max: 2000, clamped: true });
  });

  it('accepts a numeric string from the CLI flag', () => {
    expect(resolveBounds(CONFIG, '25')).toEqual({ limit: 25, max: 2000, clamped: false });
  });

  it('rejects a non-positive or non-integer limit', () => {
    expect(() => resolveBounds(CONFIG, 0)).toThrow(/--limit/);
    expect(() => resolveBounds(CONFIG, 'abc')).toThrow(/--limit/);
  });
});

describe('parseLimit / applyLimit', () => {
  it('parses a trailing LIMIT', () => {
    expect(parseLimit('SELECT Id FROM Account LIMIT 10')).toBe(10);
    expect(parseLimit('SELECT Id FROM Account limit 10 offset 5')).toBe(10);
  });

  it('does not treat a subquery LIMIT as the outer bound', () => {
    expect(parseLimit('SELECT Id, (SELECT Id FROM Contacts LIMIT 5) FROM Account')).toBeNull();
  });

  it('appends a LIMIT when the query has none', () => {
    expect(applyLimit('SELECT Id FROM Account', 200)).toEqual({
      query: 'SELECT Id FROM Account LIMIT 200',
      effectiveLimit: 200,
      action: 'appended',
    });
  });

  it('inserts LIMIT before a trailing OFFSET', () => {
    const r = applyLimit('SELECT Id FROM Account OFFSET 10', 50);
    expect(r.query).toBe('SELECT Id FROM Account LIMIT 50 OFFSET 10');
    expect(r.action).toBe('appended');
  });

  it('keeps an existing LIMIT at or under the cap', () => {
    expect(applyLimit('SELECT Id FROM Account LIMIT 5', 200)).toEqual({
      query: 'SELECT Id FROM Account LIMIT 5',
      effectiveLimit: 5,
      action: 'kept',
    });
  });

  it('clamps an existing LIMIT above the cap (preserving OFFSET)', () => {
    const r = applyLimit('SELECT Id FROM Account LIMIT 9999 OFFSET 20', 200);
    expect(r.query).toBe('SELECT Id FROM Account LIMIT 200 OFFSET 20');
    expect(r).toMatchObject({ effectiveLimit: 200, action: 'clamped' });
  });
});

describe('validateLocal', () => {
  it('accepts a straightforward SOQL query', () => {
    const r = validateLocal("SELECT Id, Name FROM Account WHERE Name = 'Acme' LIMIT 5");
    expect(r).toMatchObject({ valid: true, kind: 'soql', errors: [] });
  });

  it('classifies FIND {…} as SOSL', () => {
    expect(validateLocal('FIND {Acme} IN ALL FIELDS RETURNING Account(Id)')).toMatchObject({ valid: true, kind: 'sosl' });
  });

  it('rejects empty input, SELECT *, missing FROM, and semicolons', () => {
    expect(validateLocal('').valid).toBe(false);
    expect(validateLocal('SELECT * FROM Account').errors.join(' ')).toMatch(/SELECT \*/);
    expect(validateLocal('SELECT Id').errors.join(' ')).toMatch(/FROM/);
    expect(validateLocal('SELECT Id FROM Account;').errors.join(' ')).toMatch(/Semicolons/);
  });

  it('rejects unbalanced parentheses and quotes', () => {
    expect(validateLocal('SELECT Id FROM Account WHERE Id IN (SELECT AccountId FROM Contact').valid).toBe(false);
    expect(validateLocal("SELECT Id FROM Account WHERE Name = 'Acme").valid).toBe(false);
  });

  it('ignores parens inside string literals', () => {
    expect(validateLocal("SELECT Id FROM Account WHERE Name = 'Acme (west)'").valid).toBe(true);
  });

  it('warns (not errors) when a SOQL query has no trailing LIMIT', () => {
    const r = validateLocal('SELECT Id FROM Account');
    expect(r.valid).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/LIMIT/);
  });
});

describe('rewriteForValidation', () => {
  it('appends LIMIT 0 to an unbounded query', () => {
    expect(rewriteForValidation('SELECT Id FROM Account')).toBe('SELECT Id FROM Account LIMIT 0');
  });

  it('replaces an existing trailing LIMIT/OFFSET', () => {
    expect(rewriteForValidation('SELECT Id FROM Account LIMIT 50 OFFSET 10')).toBe('SELECT Id FROM Account LIMIT 0');
    expect(rewriteForValidation('SELECT Id FROM Account OFFSET 10')).toBe('SELECT Id FROM Account LIMIT 0');
  });
});

describe('validateQuery', () => {
  it('round-trips through the org with LIMIT 0 and reports org-mode validity', async () => {
    execa.mockResolvedValueOnce(sfJson({ records: [], totalSize: 0, done: true }));
    const r = await validateQuery(CONFIG, 'SELECT Id FROM Account LIMIT 10');
    expect(r).toMatchObject({ valid: true, mode: 'org', kind: 'soql' });
    const [, args] = execa.mock.calls[0];
    expect(args).toContain('SELECT Id FROM Account LIMIT 0');
    expect(args).toContain('--target-org');
  });

  it('reports the org error for a query the org rejects', async () => {
    const err = new Error('Command failed');
    err.stdout = JSON.stringify({ status: 1, message: "No such column 'Foo' on entity 'Account'" });
    execa.mockRejectedValueOnce(err);
    const r = await validateQuery(CONFIG, 'SELECT Foo FROM Account');
    expect(r.valid).toBe(false);
    expect(r.mode).toBe('org');
    expect(r.errors.join(' ')).toMatch(/No such column/);
  });

  it('degrades to local-only (never fabricates a verdict) when the org is unreachable', async () => {
    const err = new Error('Command failed');
    err.stdout = JSON.stringify({ status: 1, message: 'No authorization information found for dev.' });
    execa.mockRejectedValueOnce(err);
    const r = await validateQuery(CONFIG, 'SELECT Id FROM Account LIMIT 1');
    expect(r).toMatchObject({ valid: true, mode: 'local' });
    expect(r.warnings.join(' ')).toMatch(/not reachable/);
  });

  it('skips the org round-trip without a resolvable org', async () => {
    const r = await validateQuery({ defaultOrg: null }, 'SELECT Id FROM Account LIMIT 1');
    expect(r).toMatchObject({ valid: true, mode: 'local' });
    expect(execa).not.toHaveBeenCalled();
  });

  it('fails fast on local errors without touching the org', async () => {
    const r = await validateQuery(CONFIG, 'SELECT * FROM Account');
    expect(r.valid).toBe(false);
    expect(execa).not.toHaveBeenCalled();
  });

  it('honours localOnly', async () => {
    const r = await validateQuery(CONFIG, 'SELECT Id FROM Account LIMIT 1', { localOnly: true });
    expect(r.mode).toBe('local');
    expect(execa).not.toHaveBeenCalled();
  });
});

describe('searchSObjects', () => {
  it('filters the sf sobject list by case-insensitive substring', async () => {
    execa.mockResolvedValueOnce(sfJson(['Account', 'AccountHistory', 'Invoice__c', 'Contact']));
    const r = await searchSObjects(CONFIG, 'account', {});
    expect(execa).toHaveBeenCalledWith('sf', expect.arrayContaining(['sobject', 'list', '--sobject', 'all', '--target-org', 'dev', '--json']));
    expect(r.matches).toEqual(['Account', 'AccountHistory']);
    expect(r).toMatchObject({ totalScanned: 4, totalMatched: 2, truncated: false });
  });

  it('returns everything (bounded) without a term and marks truncation', async () => {
    execa.mockResolvedValueOnce(sfJson(['A', 'B', 'C']));
    const r = await searchSObjects(CONFIG, undefined, { limit: 2 });
    expect(r.matches).toEqual(['A', 'B']);
    expect(r.truncated).toBe(true);
  });

  it('passes the category through and validates it', async () => {
    execa.mockResolvedValueOnce(sfJson([]));
    await searchSObjects(CONFIG, 'x', { category: 'custom' });
    expect(execa.mock.calls[0][1]).toContain('custom');
    await expect(searchSObjects(CONFIG, 'x', { category: 'bogus' })).rejects.toThrow(/--category/);
  });

  it('throws the standard guidance without an org', async () => {
    await expect(searchSObjects({ defaultOrg: null }, 'a', {})).rejects.toThrow(/No org specified/);
  });
});

describe('describeSObject', () => {
  const DESCRIBE = {
    name: 'Account',
    label: 'Account',
    custom: false,
    queryable: true,
    keyPrefix: '001',
    fields: [
      { name: 'Name', label: 'Account Name', type: 'string', length: 255, nillable: false, custom: false },
      {
        name: 'OwnerId', label: 'Owner ID', type: 'reference', nillable: false, custom: false,
        referenceTo: ['User'], relationshipName: 'Owner',
      },
      {
        name: 'Rating', label: 'Account Rating', type: 'picklist', nillable: true, custom: false,
        picklistValues: [{ active: true, value: 'Hot' }, { active: false, value: 'Legacy' }],
      },
    ],
    childRelationships: [
      { childSObject: 'Contact', relationshipName: 'Contacts', field: 'AccountId' },
      { childSObject: 'AccountHistory', relationshipName: null, field: 'AccountId' },
    ],
  };

  it('summarises the describe to the query-authoring slice', async () => {
    execa.mockResolvedValueOnce(sfJson(DESCRIBE));
    const r = await describeSObject(CONFIG, 'Account', {});
    expect(execa).toHaveBeenCalledWith('sf', expect.arrayContaining(['sobject', 'describe', '--sobject', 'Account']));
    expect(r).toMatchObject({ name: 'Account', keyPrefix: '001', fieldCount: 3 });
    expect(r.fields[2].picklistValues).toEqual(['Hot']); // inactive values dropped
    expect(r.fields[1]).toMatchObject({ referenceTo: ['User'], relationshipName: 'Owner' });
    // relationship-less child rows are dropped (not addressable in SOQL)
    expect(r.childRelationships).toEqual([{ childSObject: 'Contact', relationshipName: 'Contacts', field: 'AccountId' }]);
  });

  it('applies the field filter against name and label', async () => {
    execa.mockResolvedValueOnce(sfJson(DESCRIBE));
    const r = await describeSObject(CONFIG, 'Account', { filter: 'rating' });
    expect(r.fields.map((f) => f.name)).toEqual(['Rating']);
    expect(r.fieldCount).toBe(3); // total is unfiltered
  });

  it('adds --use-tooling-api when tooling is set', async () => {
    execa.mockResolvedValueOnce(sfJson({ ...DESCRIBE, name: 'ApexClass' }));
    await describeSObject(CONFIG, 'ApexClass', { tooling: true });
    expect(execa.mock.calls[0][1]).toContain('--use-tooling-api');
  });

  it('surfaces the structured sf error for an unknown sObject', async () => {
    const err = new Error('Command failed');
    err.stdout = JSON.stringify({ status: 1, message: 'The requested resource does not exist' });
    execa.mockRejectedValueOnce(err);
    await expect(describeSObject(CONFIG, 'Nope__c', {})).rejects.toThrow(/does not exist/);
  });
});

describe('discoverRelationships', () => {
  it('derives parents from reference fields and children from the describe', async () => {
    execa.mockResolvedValueOnce(sfJson({
      name: 'Contact', label: 'Contact', fields: [
        { name: 'AccountId', label: 'Account ID', type: 'reference', referenceTo: ['Account'], relationshipName: 'Account', nillable: true },
        { name: 'LastName', label: 'Last Name', type: 'string' },
      ],
      childRelationships: [{ childSObject: 'Case', relationshipName: 'Cases', field: 'ContactId' }],
    }));
    const r = await discoverRelationships(CONFIG, 'Contact', {});
    expect(r.parents).toEqual([{ field: 'AccountId', relationshipName: 'Account', referenceTo: ['Account'], nillable: true }]);
    expect(r.children).toEqual([{ childSObject: 'Case', relationshipName: 'Cases', field: 'ContactId' }]);
  });

  it('restricts by direction and validates it', async () => {
    execa.mockResolvedValueOnce(sfJson({ name: 'Contact', label: 'Contact', fields: [], childRelationships: [] }));
    const r = await discoverRelationships(CONFIG, 'Contact', { direction: 'parent' });
    expect(r.parents).toEqual([]);
    expect(r.children).toBeUndefined();
    await expect(discoverRelationships(CONFIG, 'Contact', { direction: 'sideways' })).rejects.toThrow(/--direction/);
  });
});

describe('explainQuery', () => {
  const PLAN = {
    plans: [{
      leadingOperationType: 'Index', relativeCost: 0.2, cardinality: 10, sobjectCardinality: 5000,
      sobjectType: 'Account', fields: ['Name'], notes: [{ description: 'Not considering filter', fields: ['IsDeleted'], tableEnumOrId: 'Account' }],
    }],
  };

  it('calls the REST explain endpoint with the encoded query', async () => {
    execa.mockResolvedValueOnce({ stdout: JSON.stringify(PLAN) });
    const r = await explainQuery(CONFIG, "SELECT Id FROM Account WHERE Name = 'Acme'", {});
    const [, args, opts] = execa.mock.calls[0];
    expect(args.slice(0, 3)).toEqual(['api', 'request', 'rest']);
    expect(args[3]).toContain(`/query/?explain=${encodeURIComponent("SELECT Id FROM Account WHERE Name = 'Acme'")}`);
    expect(args[3]).toContain(`/v${DEFAULT_PLAN_API_VERSION}/`);
    expect(opts.env.NO_COLOR).toBe('1');
    expect(r.plans[0]).toMatchObject({ leadingOperationType: 'Index', relativeCost: 0.2 });
  });

  it('prefers the project sourceApiVersion and normalises bare majors', async () => {
    execa.mockResolvedValueOnce({ stdout: JSON.stringify(PLAN) });
    await explainQuery({ ...CONFIG, sourceApiVersion: '63' }, 'SELECT Id FROM Account', {});
    expect(execa.mock.calls[0][1][3]).toContain('/v63.0/');
  });

  it('surfaces a REST error body as an error', async () => {
    execa.mockResolvedValueOnce({ stdout: JSON.stringify([{ errorCode: 'MALFORMED_QUERY', message: 'unexpected token' }]) });
    await expect(explainQuery(CONFIG, 'SELEC Id FROM Account', {})).rejects.toThrow(/MALFORMED_QUERY/);
  });
});

describe('runQuery (bounded execution)', () => {
  it('applies the default bound and strips attributes', async () => {
    execa.mockResolvedValueOnce(sfJson({
      records: [{ attributes: { type: 'Account' }, Id: '001', Owner: { attributes: { type: 'User' }, Name: 'Ada' } }],
      totalSize: 1,
      done: true,
    }));
    const r = await runQuery(CONFIG, 'SELECT Id, Owner.Name FROM Account', {});
    const [, args] = execa.mock.calls[0];
    expect(args).toContain('SELECT Id, Owner.Name FROM Account LIMIT 200');
    expect(r.records).toEqual([{ Id: '001', Owner: { Name: 'Ada' } }]);
    expect(r).toMatchObject({ bound: { limit: 200, max: 2000, action: 'appended' }, returned: 1, truncated: false });
  });

  it('clamps --limit to soql.maxLimit and flags truncation', async () => {
    execa.mockResolvedValueOnce(sfJson({ records: [{ Id: '1' }], totalSize: 50, done: true }));
    const r = await runQuery({ ...CONFIG, soql: { defaultLimit: 10, maxLimit: 25 } }, 'SELECT Id FROM Account', { limit: 500 });
    expect(execa.mock.calls[0][1]).toContain('SELECT Id FROM Account LIMIT 25');
    expect(r.truncated).toBe(true);
  });

  it('passes tooling and all-rows through to sf', async () => {
    execa.mockResolvedValueOnce(sfJson({ records: [], totalSize: 0, done: true }));
    await runQuery(CONFIG, 'SELECT Id FROM ApexClass', { tooling: true, allRows: true });
    expect(execa.mock.calls[0][1]).toEqual(expect.arrayContaining(['--use-tooling-api', '--all-rows']));
  });

  it('rejects SOSL and locally-invalid SOQL before touching the org', async () => {
    await expect(runQuery(CONFIG, 'FIND {x} RETURNING Account(Id)', {})).rejects.toThrow(/soql sosl/);
    await expect(runQuery(CONFIG, 'SELECT * FROM Account', {})).rejects.toThrow(/Invalid SOQL/);
    expect(execa).not.toHaveBeenCalled();
  });

  it('exports records to a file when --out is set', async () => {
    execa.mockResolvedValueOnce(sfJson({ records: [{ Id: '1', Name: 'Acme' }], totalSize: 1, done: true }));
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sfdt-soql-'));
    const out = path.join(dir, 'accounts.csv');
    const r = await runQuery(CONFIG, 'SELECT Id, Name FROM Account LIMIT 1', { out });
    expect(r.export).toMatchObject({ format: 'csv', rows: 1 });
    expect(await fs.readFile(out, 'utf-8')).toBe('Id,Name\n1,Acme\n');
    await fs.remove(dir);
  });
});

describe('runSearch (SOSL)', () => {
  it('bounds the search and shells sf data search', async () => {
    execa.mockResolvedValueOnce(sfJson({ searchRecords: [{ attributes: { type: 'Account' }, Id: '001' }] }));
    const r = await runSearch(CONFIG, 'FIND {Acme} IN ALL FIELDS RETURNING Account(Id)', { limit: 10 });
    const [, args] = execa.mock.calls[0];
    expect(args).toEqual(expect.arrayContaining(['data', 'search', '--target-org', 'dev', '--json']));
    expect(args).toContain('FIND {Acme} IN ALL FIELDS RETURNING Account(Id) LIMIT 10');
    expect(r.records).toEqual([{ Id: '001' }]);
    expect(r.bound).toMatchObject({ limit: 10, action: 'appended' });
  });

  it('rejects SOQL input', async () => {
    await expect(runSearch(CONFIG, 'SELECT Id FROM Account', {})).rejects.toThrow(/soql query/);
  });
});

describe('csv/export helpers', () => {
  it('stripAttributes handles nested subquery results', () => {
    const cleaned = stripAttributes({
      attributes: { type: 'Account' },
      Id: '001',
      Contacts: { totalSize: 1, done: true, records: [{ attributes: { type: 'Contact' }, Id: '003' }] },
    });
    expect(cleaned).toEqual({ Id: '001', Contacts: [{ Id: '003' }] });
  });

  it('toCsv flattens parent paths, quotes per RFC 4180, and unions columns', () => {
    const csv = toCsv([
      { Id: '1', Owner: { Name: 'Ada, PhD' } },
      { Id: '2', Note: 'says "hi"' },
    ]);
    expect(csv).toBe('Id,Owner.Name,Note\n1,"Ada, PhD",\n2,,"says ""hi"""\n');
  });

  it('toCsv serialises array values (subqueries) as JSON strings', () => {
    const csv = toCsv([{ Id: '1', Contacts: [{ Id: '003' }] }]);
    expect(csv.split('\n')[1]).toContain('[{""Id"":""003""}]');
  });

  it('writeExport infers format from the extension and rejects unknown formats', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sfdt-soql-'));
    const jsonOut = path.join(dir, 'rows.json');
    const r = await writeExport([{ Id: '1' }], { out: jsonOut });
    expect(r.format).toBe('json');
    // Raw records on disk — never the stdout envelope shape.
    expect(await fs.readJson(jsonOut)).toEqual([{ Id: '1' }]);
    await expect(writeExport([], { out: jsonOut, format: 'xml' })).rejects.toThrow(/--format/);
    await fs.remove(dir);
  });
});
