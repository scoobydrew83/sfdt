import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('execa', () => ({ execa: vi.fn() }));
vi.mock('glob', () => ({ glob: vi.fn() }));
vi.mock('fs-extra', () => ({ default: { readJson: vi.fn(), ensureDir: vi.fn() } }));

import { execa } from 'execa';
import { glob } from 'glob';
import fs from 'fs-extra';
import path from 'path';
import {
  extractSObject,
  parseCsvHeader,
  formatCsvHeader,
  mapCsvHeader,
  resolveBulkOperation,
  buildImportBulkArgs,
  buildUpsertBulkArgs,
  summariseBulkResult,
  buildExportArgs,
  dataSetDir,
  readQueries,
  exportDataSet,
  importDataSet,
  deleteDataSet,
  listDataSets,
  resolvePlanFile,
} from '../../src/lib/data-runner.js';

const config = { _projectRoot: '/project', data: { dir: '.sfdt/data' } };

beforeEach(() => vi.resetAllMocks());

describe('extractSObject', () => {
  it('pulls the sObject from a FROM clause', () => {
    expect(extractSObject('SELECT Id, Name FROM Account WHERE x = 1')).toBe('Account');
    expect(extractSObject('select Id from Custom__c')).toBe('Custom__c');
  });
  it('returns null when there is no FROM', () => {
    expect(extractSObject('not soql')).toBeNull();
  });
});

describe('buildExportArgs', () => {
  it('adds a --query for each query and the plan/output flags', () => {
    const args = buildExportArgs(['SELECT Id FROM A', 'SELECT Id FROM B'], 'dev', '/out');
    expect(args).toEqual(expect.arrayContaining(['data', 'export', 'tree', '--target-org', 'dev', '--output-dir', '/out', '--plan', '--json']));
    expect(args.filter((a) => a === '--query')).toHaveLength(2);
  });
});

describe('dataSetDir', () => {
  it('resolves under the project root', () => {
    expect(dataSetDir(config, 'qa')).toBe('/project/.sfdt/data/qa');
  });
});

describe('readQueries', () => {
  it('reads a queries array', async () => {
    fs.readJson.mockResolvedValueOnce({ queries: ['SELECT Id FROM Account'] });
    expect(await readQueries(config, 'qa')).toEqual(['SELECT Id FROM Account']);
  });
  it('accepts a bare array', async () => {
    fs.readJson.mockResolvedValueOnce(['SELECT Id FROM Account']);
    expect(await readQueries(config, 'qa')).toHaveLength(1);
  });
  it('throws a friendly error when the set is missing', async () => {
    fs.readJson.mockRejectedValueOnce(new Error('ENOENT'));
    await expect(readQueries(config, 'nope')).rejects.toThrow(/not found/);
  });
  it('throws when there are no queries', async () => {
    fs.readJson.mockResolvedValueOnce({ queries: [] });
    await expect(readQueries(config, 'qa')).rejects.toThrow(/no queries/);
  });
});

describe('resolvePlanFile', () => {
  it('returns the first plan file', async () => {
    glob.mockResolvedValueOnce(['/out/Account-plan.json']);
    expect(await resolvePlanFile('/out')).toBe('/out/Account-plan.json');
  });
  it('returns null when no plan exists', async () => {
    glob.mockResolvedValueOnce([]);
    expect(await resolvePlanFile('/out')).toBeNull();
  });
});

describe('exportDataSet', () => {
  it('runs export tree and resolves the plan file', async () => {
    fs.readJson.mockResolvedValueOnce({ queries: ['SELECT Id FROM Account'] });
    fs.ensureDir.mockResolvedValueOnce(undefined);
    execa.mockResolvedValueOnce({ stdout: JSON.stringify({ result: [{ id: '1' }] }) });
    glob.mockResolvedValueOnce(['/project/.sfdt/data/qa/data/Account-plan.json']);
    const res = await exportDataSet(config, 'qa', 'dev');
    expect(res.set).toBe('qa');
    expect(res.planFile).toMatch(/Account-plan\.json$/);
    expect(execa).toHaveBeenCalledWith('sf', expect.arrayContaining(['data', 'export', 'tree']));
  });
  it('surfaces sf\'s structured error message on failure', async () => {
    fs.readJson.mockResolvedValueOnce({ queries: ['SELECT Id FROM Account'] });
    fs.ensureDir.mockResolvedValueOnce(undefined);
    const err = new Error('Command failed with exit code 1: sf data export tree');
    err.stdout = JSON.stringify({ status: 1, message: 'No authorization information found for dev.' });
    execa.mockRejectedValueOnce(err);
    await expect(exportDataSet(config, 'qa', 'dev')).rejects.toThrow(/No authorization information found for dev\./);
  });
});

describe('importDataSet', () => {
  it('imports using the resolved plan file', async () => {
    glob.mockResolvedValueOnce(['/project/.sfdt/data/qa/data/Account-plan.json']);
    execa.mockResolvedValueOnce({ stdout: JSON.stringify({ result: [{ id: '1' }, { id: '2' }] }) });
    const res = await importDataSet(config, 'qa', 'dev');
    expect(res.imported).toBe(2);
    expect(execa).toHaveBeenCalledWith('sf', expect.arrayContaining(['data', 'import', 'tree', '--plan', expect.stringContaining('Account-plan.json')]));
  });
  it('throws when no plan file exists', async () => {
    glob.mockResolvedValueOnce([]);
    await expect(importDataSet(config, 'qa', 'dev')).rejects.toThrow(/export qa/);
  });
});

describe('deleteDataSet', () => {
  it('bulk deletes one sObject per distinct query target', async () => {
    fs.readJson.mockResolvedValueOnce({ queries: ['SELECT Id FROM Account', 'SELECT Id FROM Contact'] });
    execa.mockResolvedValue({ stdout: '{}' });
    const res = await deleteDataSet(config, 'qa', 'dev');
    expect(res.sobjects.map((s) => s.sobject)).toEqual(['Account', 'Contact']);
    expect(res.sobjects.every((s) => s.status === 'ok')).toBe(true);
  });
  it('captures per-sobject errors', async () => {
    fs.readJson.mockResolvedValueOnce({ queries: ['SELECT Id FROM Account'] });
    execa.mockRejectedValueOnce(new Error('bulk failed'));
    const res = await deleteDataSet(config, 'qa', 'dev');
    expect(res.sobjects[0]).toMatchObject({ sobject: 'Account', status: 'error' });
  });
  it('prefers sf\'s structured error message over the opaque execa message', async () => {
    fs.readJson.mockResolvedValueOnce({ queries: ['SELECT Id FROM Account'] });
    const err = new Error('Command failed with exit code 1: sf data delete bulk');
    err.stdout = JSON.stringify({ status: 1, message: 'No authorization information found for dev.' });
    execa.mockRejectedValueOnce(err);
    const res = await deleteDataSet(config, 'qa', 'dev');
    expect(res.sobjects[0].error).toMatch(/No authorization information found for dev\./);
    expect(res.sobjects[0].error).not.toMatch(/Command failed with exit code/);
  });
  it('runs every query, including multiple for the same sObject', async () => {
    fs.readJson.mockResolvedValueOnce({
      queries: ["SELECT Id FROM Account WHERE Region='US'", "SELECT Id FROM Account WHERE Region='EU'"],
    });
    execa.mockResolvedValue({ stdout: '{}' });
    const res = await deleteDataSet(config, 'qa', 'dev');
    // Both Account filters must run — deduping by sObject would drop the second.
    expect(execa).toHaveBeenCalledTimes(2);
    expect(res.sobjects).toHaveLength(2);
  });
  it('records unparseable queries as skipped instead of silently dropping them', async () => {
    fs.readJson.mockResolvedValueOnce({ queries: ['SELECT Id FROM Account', 'not soql'] });
    execa.mockResolvedValue({ stdout: '{}' });
    const res = await deleteDataSet(config, 'qa', 'dev');
    // Only the parseable query runs a delete…
    expect(execa).toHaveBeenCalledTimes(1);
    // …but the skipped one is still surfaced in the results.
    expect(res.sobjects).toHaveLength(2);
    expect(res.sobjects[0]).toMatchObject({ sobject: 'Account', status: 'ok' });
    expect(res.sobjects[1]).toMatchObject({ sobject: null, status: 'skipped' });
  });
});

describe('listDataSets', () => {
  it('lists set directories containing queries.json', async () => {
    glob.mockResolvedValueOnce(['qa/queries.json', 'demo/queries.json']);
    expect(await listDataSets(config)).toEqual(['demo', 'qa']);
  });
});

// ---------------------------------------------------------------------------
// Bulk API v2 loading
// ---------------------------------------------------------------------------

describe('parseCsvHeader', () => {
  it('splits a plain header and trims whitespace', () => {
    expect(parseCsvHeader('Name,Email, Phone ')).toEqual(['Name', 'Email', 'Phone']);
  });

  it('honours quoted columns containing commas', () => {
    expect(parseCsvHeader('"Last, First",Email')).toEqual(['Last, First', 'Email']);
  });

  it('unescapes doubled quotes inside a quoted column', () => {
    expect(parseCsvHeader('"He said ""hi""",Email')).toEqual(['He said "hi"', 'Email']);
  });

  it('keeps empty trailing columns rather than dropping them', () => {
    expect(parseCsvHeader('Name,,Email,')).toEqual(['Name', '', 'Email', '']);
  });
});

describe('formatCsvHeader', () => {
  it('leaves simple names unquoted', () => {
    expect(formatCsvHeader(['Name', 'Email'])).toBe('Name,Email');
  });

  it('quotes and escapes only where required', () => {
    expect(formatCsvHeader(['Last, First', 'He said "hi"', 'Plain'])).toBe('"Last, First","He said ""hi""",Plain');
  });
});

describe('mapCsvHeader', () => {
  it('renames mapped columns and passes unmapped ones through', () => {
    const r = mapCsvHeader('Company Name,email,Notes', { 'Company Name': 'Name', email: 'Email' });
    expect(r.line).toBe('Name,Email,Notes');
    expect(r.renamed).toBe(2);
    expect(r.unmatched).toEqual([]);
  });

  it('reports fieldMap keys that matched no column — a silent no-op otherwise', () => {
    const r = mapCsvHeader('Name,Email', { Nmae: 'Name', Phone: 'Phone' });
    expect(r.line).toBe('Name,Email');
    expect(r.renamed).toBe(0);
    expect(r.unmatched).toEqual(['Nmae', 'Phone']);
  });

  it('re-quotes a mapped name that needs it', () => {
    const r = mapCsvHeader('a', { a: 'Weird,Name' });
    expect(r.line).toBe('"Weird,Name"');
  });

  it('is a no-op with no field map', () => {
    expect(mapCsvHeader('Name,Email').line).toBe('Name,Email');
  });
});

describe('resolveBulkOperation', () => {
  const setDir = '/project/.sfdt/data/seed';

  it('resolves a valid insert', () => {
    const op = resolveBulkOperation({ sobject: 'Account', file: 'a.csv' }, setDir, 'seed', 0);
    expect(op.operation).toBe('insert');
    expect(op.filePath).toBe(path.join(setDir, 'a.csv'));
  });

  it('defaults operation to insert but keeps an explicit upsert', () => {
    const op = resolveBulkOperation(
      { sobject: 'Contact', file: 'c.csv', operation: 'upsert', externalId: 'Ext__c' }, setDir, 'seed', 0);
    expect(op.operation).toBe('upsert');
    expect(op.externalId).toBe('Ext__c');
  });

  it('rejects an upsert with no externalId', () => {
    expect(() => resolveBulkOperation(
      { sobject: 'Contact', file: 'c.csv', operation: 'upsert' }, setDir, 'seed', 0))
      .toThrow(/needs "externalId"/);
  });

  it('rejects an unsupported operation and points delete at its own verb', () => {
    expect(() => resolveBulkOperation(
      { sobject: 'Account', file: 'a.csv', operation: 'delete' }, setDir, 'seed', 0))
      .toThrow(/sfdt data delete/);
  });

  it('rejects a file path that escapes the data set directory', () => {
    expect(() => resolveBulkOperation(
      { sobject: 'Account', file: '../../../etc/passwd' }, setDir, 'seed', 0))
      .toThrow(/must stay inside the data set directory/);
  });

  it('rejects an sobject that is not an API name', () => {
    expect(() => resolveBulkOperation(
      { sobject: 'Account; DROP', file: 'a.csv' }, setDir, 'seed', 0))
      .toThrow(/must be an object API name/);
  });

  it('rejects a fieldMap that is not an object', () => {
    expect(() => resolveBulkOperation(
      { sobject: 'Account', file: 'a.csv', fieldMap: ['Name'] }, setDir, 'seed', 0))
      .toThrow(/must be an object of/);
  });
});

describe('buildImportBulkArgs / buildUpsertBulkArgs', () => {
  const insert = { sobject: 'Account', operation: 'insert' };
  const upsert = { sobject: 'Contact', operation: 'upsert', externalId: 'Ext__c' };

  it('builds an insert with the default wait', () => {
    expect(buildImportBulkArgs(insert, 'dev', '/tmp/a.csv')).toEqual([
      'data', 'import', 'bulk', '--file', '/tmp/a.csv', '--sobject', 'Account',
      '--target-org', 'dev', '--json', '--wait', '10',
    ]);
  });

  it('builds an upsert carrying the external id', () => {
    expect(buildUpsertBulkArgs(upsert, 'dev', '/tmp/c.csv', { waitMinutes: 3 })).toEqual([
      'data', 'upsert', 'bulk', '--file', '/tmp/c.csv', '--sobject', 'Contact',
      '--external-id', 'Ext__c', '--target-org', 'dev', '--json', '--wait', '3',
    ]);
  });

  it('swaps --wait for --async when asked, never both', () => {
    const args = buildImportBulkArgs(insert, 'dev', '/tmp/a.csv', { async: true, waitMinutes: 9 });
    expect(args).toContain('--async');
    expect(args).not.toContain('--wait');
  });

  it('passes the line ending through only when set', () => {
    expect(buildImportBulkArgs(insert, 'dev', '/tmp/a.csv', { lineEnding: 'CRLF' }))
      .toEqual(expect.arrayContaining(['--line-ending', 'CRLF']));
    expect(buildImportBulkArgs(insert, 'dev', '/tmp/a.csv')).not.toContain('--line-ending');
  });
});

describe('summariseBulkResult', () => {
  it('reads the sf envelope counts', () => {
    expect(summariseBulkResult({ result: { jobId: '750xx', numberRecordsProcessed: 100, numberRecordsFailed: 2 } }))
      .toEqual({ jobId: '750xx', processed: 100, failed: 2 });
  });

  it('coerces string counts and tolerates a missing result', () => {
    expect(summariseBulkResult({ result: { id: 'j1', recordsProcessed: '5', recordsFailed: '0' } }))
      .toEqual({ jobId: 'j1', processed: 5, failed: 0 });
    expect(summariseBulkResult(null)).toEqual({ jobId: null, processed: null, failed: null });
  });
});
