import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('execa', () => ({ execa: vi.fn() }));

import { execa } from 'execa';
import { query, rawQuery, count } from '../../src/lib/org-query.js';

beforeEach(() => vi.resetAllMocks());

describe('org-query query()', () => {
  it('returns the records array from sf data query --json', async () => {
    execa.mockResolvedValueOnce({
      stdout: JSON.stringify({ result: { records: [{ Id: '1' }, { Id: '2' }] } }),
    });
    const records = await query('dev', 'SELECT Id FROM Account');
    expect(records).toEqual([{ Id: '1' }, { Id: '2' }]);
  });

  it('passes the SOQL and org alias to sf', async () => {
    execa.mockResolvedValueOnce({ stdout: JSON.stringify({ result: { records: [] } }) });
    await query('staging', 'SELECT Id FROM User');
    const [, args] = execa.mock.calls[0];
    expect(args).toEqual(
      expect.arrayContaining(['data', 'query', '--query', 'SELECT Id FROM User', '--target-org', 'staging', '--json']),
    );
    expect(args).not.toContain('--use-tooling-api');
  });

  it('adds --use-tooling-api when tooling option is set', async () => {
    execa.mockResolvedValueOnce({ stdout: JSON.stringify({ result: { records: [] } }) });
    await query('dev', 'SELECT Id FROM ApexClass', { tooling: true });
    expect(execa.mock.calls[0][1]).toContain('--use-tooling-api');
  });

  it('adds --all-rows when all option is set', async () => {
    execa.mockResolvedValueOnce({ stdout: JSON.stringify({ result: { records: [] } }) });
    await query('dev', 'SELECT Id FROM Account', { all: true });
    expect(execa.mock.calls[0][1]).toContain('--all-rows');
  });

  it('throws a friendly error when no org alias is given', async () => {
    await expect(query('', 'SELECT Id FROM Account')).rejects.toThrow(/No org specified/);
    expect(execa).not.toHaveBeenCalled();
  });

  it('returns [] when the response has no records key', async () => {
    execa.mockResolvedValueOnce({ stdout: JSON.stringify({ result: {} }) });
    expect(await query('dev', 'SELECT Id FROM Account')).toEqual([]);
  });

  it('surfaces the structured sf error message on failure', async () => {
    const err = new Error('Command failed');
    err.stdout = JSON.stringify({ status: 1, message: 'No such column Foo on Account' });
    err.stderr = '';
    execa.mockRejectedValueOnce(err);
    await expect(query('dev', 'SELECT Foo FROM Account')).rejects.toThrow(/No such column Foo/);
  });
});

describe('org-query rawQuery()', () => {
  it('returns records, totalSize, and done', async () => {
    execa.mockResolvedValueOnce({
      stdout: JSON.stringify({ result: { records: [{ Id: '1' }], totalSize: 1, done: true } }),
    });
    const res = await rawQuery('dev', 'SELECT Id FROM Account');
    expect(res).toEqual({ records: [{ Id: '1' }], totalSize: 1, done: true });
  });
});

describe('org-query count()', () => {
  it('returns totalSize for a regular query', async () => {
    execa.mockResolvedValueOnce({
      stdout: JSON.stringify({ result: { records: [{ Id: '1' }, { Id: '2' }, { Id: '3' }], totalSize: 3 } }),
    });
    expect(await count('dev', 'SELECT Id FROM Account')).toBe(3);
  });

  it('returns totalSize for an aggregate COUNT() query (empty records)', async () => {
    // `SELECT COUNT() FROM …` returns totalSize with NO records — counting
    // records.length would wrongly yield 0.
    execa.mockResolvedValueOnce({
      stdout: JSON.stringify({ result: { records: [], totalSize: 42 } }),
    });
    expect(await count('dev', 'SELECT COUNT() FROM Account')).toBe(42);
  });
});
