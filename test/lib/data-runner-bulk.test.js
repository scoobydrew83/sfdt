// Bulk-load paths that touch the filesystem for real.
//
// writeMappedCsv is streamed and its whole point is not holding the file in
// memory, so mocking fs would test the opposite of the thing that matters.
// These use a real temp dir; only `sf` itself is mocked.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs-extra';

vi.mock('execa', () => ({ execa: vi.fn() }));

import { execa } from 'execa';
import {
  writeMappedCsv,
  readDataSetSpec,
  bulkLoadDataSet,
} from '../../src/lib/data-runner.js';

let root;
let config;

beforeEach(async () => {
  vi.resetAllMocks();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'sfdt-bulk-'));
  config = { _projectRoot: root, data: { dir: '.sfdt/data' } };
});

afterEach(async () => {
  await fs.remove(root);
});

async function makeSet(name, files) {
  const dir = path.join(root, '.sfdt/data', name);
  await fs.ensureDir(dir);
  for (const [file, content] of Object.entries(files)) {
    await fs.outputFile(path.join(dir, file), content);
  }
  return dir;
}

const okJson = (processed = 3, failed = 0) => ({
  stdout: JSON.stringify({ status: 0, result: { jobId: '750x', numberRecordsProcessed: processed, numberRecordsFailed: failed } }),
});

describe('writeMappedCsv', () => {
  it('rewrites only the header and leaves every data row byte-identical', async () => {
    const src = path.join(root, 'in.csv');
    const dest = path.join(root, 'out.csv');
    await fs.outputFile(src, 'Company Name,email\nAcme, Inc,a@b.c\n"Quoted,Row",d@e.f\n');

    const header = await writeMappedCsv(src, dest, { 'Company Name': 'Name', email: 'Email' });

    expect(header.line).toBe('Name,Email');
    expect(await fs.readFile(dest, 'utf8')).toBe('Name,Email\nAcme, Inc,a@b.c\n"Quoted,Row",d@e.f\n');
  });

  it('preserves CRLF line endings', async () => {
    const src = path.join(root, 'in.csv');
    const dest = path.join(root, 'out.csv');
    await fs.outputFile(src, 'a,b\r\n1,2\r\n');
    await writeMappedCsv(src, dest, { a: 'Name' });
    expect(await fs.readFile(dest, 'utf8')).toBe('Name,b\r\n1,2\r\n');
  });

  it('handles a header-only CSV with no trailing newline', async () => {
    const src = path.join(root, 'in.csv');
    const dest = path.join(root, 'out.csv');
    await fs.outputFile(src, 'a,b');
    const header = await writeMappedCsv(src, dest, { a: 'Name' });
    expect(header.line).toBe('Name,b');
    expect(await fs.readFile(dest, 'utf8')).toBe('Name,b');
  });

  it('survives a file larger than one stream chunk', async () => {
    const src = path.join(root, 'big.csv');
    const dest = path.join(root, 'big-out.csv');
    const rows = Array.from({ length: 20_000 }, (_, i) => `row${i},${i}`).join('\n');
    await fs.outputFile(src, `a,b\n${rows}\n`);

    await writeMappedCsv(src, dest, { a: 'Name' });

    const out = await fs.readFile(dest, 'utf8');
    expect(out.startsWith('Name,b\n')).toBe(true);
    expect(out.endsWith('row19999,19999\n')).toBe(true);
    expect(out.split('\n')).toHaveLength(20_002); // header + rows + trailing ''
  });

  it('rejects a file with no header row in the first megabyte', async () => {
    const src = path.join(root, 'nolines.csv');
    const dest = path.join(root, 'nolines-out.csv');
    await fs.outputFile(src, 'x'.repeat(1_100_000));
    await expect(writeMappedCsv(src, dest, { a: 'b' })).rejects.toThrow(/no header row found/);
  });
});

describe('readDataSetSpec', () => {
  it('reads a bulk set and resolves its operations', async () => {
    await makeSet('seed', {
      'bulk.json': JSON.stringify({ operations: [{ sobject: 'Account', file: 'a.csv' }] }),
      'a.csv': 'Name\nAcme\n',
    });
    const spec = await readDataSetSpec(config, 'seed');
    expect(spec.kind).toBe('bulk');
    expect(spec.operations[0].sobject).toBe('Account');
  });

  it('reads a tree set', async () => {
    await makeSet('tree', { 'queries.json': JSON.stringify({ queries: ['SELECT Id FROM Account'] }) });
    expect((await readDataSetSpec(config, 'tree')).kind).toBe('tree');
  });

  it('refuses a set carrying both spec files rather than picking one', async () => {
    await makeSet('both', {
      'bulk.json': JSON.stringify({ operations: [{ sobject: 'Account', file: 'a.csv' }] }),
      'queries.json': JSON.stringify({ queries: ['SELECT Id FROM Account'] }),
    });
    await expect(readDataSetSpec(config, 'both')).rejects.toThrow(/both bulk.json and queries.json/);
  });

  it('names both candidate paths when the set does not exist', async () => {
    await expect(readDataSetSpec(config, 'ghost')).rejects.toThrow(/queries\.json.*bulk\.json/s);
  });

  it('reports invalid JSON as invalid JSON, not as a missing set', async () => {
    await makeSet('bad', { 'bulk.json': '{ not json' });
    await expect(readDataSetSpec(config, 'bad')).rejects.toThrow(/is not valid JSON/);
  });
});

describe('bulkLoadDataSet', () => {
  it('runs operations in declaration order and reports per-operation results', async () => {
    await makeSet('seed', {
      'bulk.json': JSON.stringify({
        operations: [
          { sobject: 'Account', file: 'a.csv' },
          { sobject: 'Contact', file: 'c.csv', operation: 'upsert', externalId: 'Ext__c' },
        ],
      }),
      'a.csv': 'Name\nAcme\n',
      'c.csv': 'Ext__c\n1\n',
    });
    execa.mockResolvedValue(okJson());

    const result = await bulkLoadDataSet(config, 'seed', 'dev');

    expect(result.operations.map((o) => o.sobject)).toEqual(['Account', 'Contact']);
    expect(result.operations.every((o) => o.status === 'ok')).toBe(true);
    expect(execa.mock.calls[0][1]).toContain('import');
    expect(execa.mock.calls[1][1]).toContain('upsert');
    expect(execa.mock.calls[1][1]).toEqual(expect.arrayContaining(['--external-id', 'Ext__c']));
  });

  it('treats rejected records as an error even though sf exits 0', async () => {
    await makeSet('seed', {
      'bulk.json': JSON.stringify({ operations: [{ sobject: 'Account', file: 'a.csv' }] }),
      'a.csv': 'Name\nAcme\n',
    });
    execa.mockResolvedValue(okJson(10, 4));

    const result = await bulkLoadDataSet(config, 'seed', 'dev');

    expect(result.operations[0].status).toBe('error');
    expect(result.operations[0].failed).toBe(4);
    expect(result.operations[0].error).toMatch(/4 record\(s\) rejected/);
  });

  it('records a failing operation and still runs the next one', async () => {
    await makeSet('seed', {
      'bulk.json': JSON.stringify({
        operations: [{ sobject: 'Account', file: 'a.csv' }, { sobject: 'Contact', file: 'c.csv' }],
      }),
      'a.csv': 'Name\nAcme\n',
      'c.csv': 'LastName\nX\n',
    });
    execa
      .mockRejectedValueOnce({ stdout: JSON.stringify({ message: 'INVALID_FIELD: no such column' }) })
      .mockResolvedValueOnce(okJson());

    const result = await bulkLoadDataSet(config, 'seed', 'dev');

    expect(result.operations[0].status).toBe('error');
    expect(result.operations[0].error).toBe('INVALID_FIELD: no such column');
    expect(result.operations[1].status).toBe('ok');
  });

  it('maps the CSV header and loads the mapped copy, not the original', async () => {
    const dir = await makeSet('seed', {
      'bulk.json': JSON.stringify({
        operations: [{ sobject: 'Account', file: 'a.csv', fieldMap: { 'Company Name': 'Name' } }],
      }),
      'a.csv': 'Company Name\nAcme\n',
    });
    execa.mockResolvedValue(okJson());

    const result = await bulkLoadDataSet(config, 'seed', 'dev');

    const mapped = path.join(dir, '.mapped', 'a.csv');
    expect(result.operations[0].mappedFile).toBe(mapped);
    expect(result.operations[0].renamedColumns).toBe(1);
    expect(await fs.readFile(mapped, 'utf8')).toBe('Name\nAcme\n');
    expect(execa.mock.calls[0][1]).toEqual(expect.arrayContaining(['--file', mapped]));
  });

  it('surfaces fieldMap keys that matched no column', async () => {
    await makeSet('seed', {
      'bulk.json': JSON.stringify({
        operations: [{ sobject: 'Account', file: 'a.csv', fieldMap: { Nmae: 'Name' } }],
      }),
      'a.csv': 'Name\nAcme\n',
    });
    execa.mockResolvedValue(okJson());

    const result = await bulkLoadDataSet(config, 'seed', 'dev');
    expect(result.operations[0].unmatchedFieldMapKeys).toEqual(['Nmae']);
  });

  it('reports a missing CSV as an error without invoking sf', async () => {
    await makeSet('seed', {
      'bulk.json': JSON.stringify({ operations: [{ sobject: 'Account', file: 'missing.csv' }] }),
    });

    const result = await bulkLoadDataSet(config, 'seed', 'dev');

    expect(result.operations[0].status).toBe('error');
    expect(result.operations[0].error).toMatch(/CSV not found/);
    expect(execa).not.toHaveBeenCalled();
  });

  it('sends a tree data set to the tree verb instead of loading it', async () => {
    await makeSet('tree', { 'queries.json': JSON.stringify({ queries: ['SELECT Id FROM Account'] }) });
    await expect(bulkLoadDataSet(config, 'tree', 'dev')).rejects.toThrow(/sfdt data import tree/);
  });

  it('prefers an explicit wait over the configured one', async () => {
    await makeSet('seed', {
      'bulk.json': JSON.stringify({ operations: [{ sobject: 'Account', file: 'a.csv' }] }),
      'a.csv': 'Name\nAcme\n',
    });
    execa.mockResolvedValue(okJson());
    const configured = { ...config, data: { ...config.data, bulk: { waitMinutes: 30 } } };

    await bulkLoadDataSet(configured, 'seed', 'dev', { waitMinutes: 2 });
    expect(execa.mock.calls[0][1]).toEqual(expect.arrayContaining(['--wait', '2']));

    execa.mockClear();
    await bulkLoadDataSet(configured, 'seed', 'dev');
    expect(execa.mock.calls[0][1]).toEqual(expect.arrayContaining(['--wait', '30']));
  });
});
