import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../../src/lib/config.js', () => ({ loadConfig: vi.fn() }));
vi.mock('../../src/lib/soql-runner.js', () => ({
  searchSObjects: vi.fn(),
  describeSObject: vi.fn(),
  discoverRelationships: vi.fn(),
  validateQuery: vi.fn(),
  explainQuery: vi.fn(),
  runQuery: vi.fn(),
  runSearch: vi.fn(),
}));

import { loadConfig } from '../../src/lib/config.js';
import {
  searchSObjects,
  describeSObject,
  discoverRelationships,
  validateQuery,
  explainQuery,
  runQuery,
  runSearch,
} from '../../src/lib/soql-runner.js';
import { registerSoqlCommand } from '../../src/commands/soql.js';

const CONFIG = { defaultOrg: 'dev', soql: { defaultLimit: 200, maxLimit: 2000 } };

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerSoqlCommand(program);
  return program;
}

function captureStdout() {
  return vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
}

beforeEach(() => {
  vi.resetAllMocks();
  loadConfig.mockResolvedValue(CONFIG);
});
afterEach(() => {
  process.exitCode = undefined;
});

describe('soql command registration', () => {
  it('registers every subcommand of the family', () => {
    const soql = createProgram().commands.find((c) => c.name() === 'soql');
    expect(soql.commands.map((c) => c.name()).sort()).toEqual(
      ['describe', 'plan', 'query', 'relationships', 'search', 'sosl', 'validate'].sort(),
    );
  });

  it('every subcommand supports --json', () => {
    const soql = createProgram().commands.find((c) => c.name() === 'soql');
    for (const sub of soql.commands) {
      expect(
        sub.options.some((o) => o.long === '--json'),
        `${sub.name()} must support --json`,
      ).toBe(true);
    }
  });
});

describe('soql subcommand delegation', () => {
  it('search delegates with term/category/limit and emits the envelope', async () => {
    const result = { org: 'dev', matches: ['Account'], totalScanned: 1, totalMatched: 1, truncated: false, category: 'custom', term: 'acc' };
    searchSObjects.mockResolvedValue(result);
    const out = captureStdout();

    await createProgram().parseAsync(['node', 'sfdt', 'soql', 'search', 'acc', '--category', 'custom', '--limit', '5', '--json']);

    expect(searchSObjects).toHaveBeenCalledWith(CONFIG, 'acc', expect.objectContaining({ category: 'custom', limit: '5' }));
    const envelope = JSON.parse(out.mock.calls.map((c) => c[0]).join(''));
    expect(envelope).toMatchObject({ status: 0, result, warnings: [] });
    out.mockRestore();
  });

  it('describe delegates the sObject name and flags', async () => {
    describeSObject.mockResolvedValue({ name: 'Account', label: 'Account', fields: [], childRelationships: [], fieldCount: 0 });
    const out = captureStdout();
    await createProgram().parseAsync(['node', 'sfdt', 'soql', 'describe', 'Account', '--filter', 'phone', '--tooling', '--json']);
    expect(describeSObject).toHaveBeenCalledWith(CONFIG, 'Account', expect.objectContaining({ filter: 'phone', tooling: true }));
    out.mockRestore();
  });

  it('relationships delegates with the direction', async () => {
    discoverRelationships.mockResolvedValue({ sobject: 'Contact', direction: 'parent', parents: [] });
    const out = captureStdout();
    await createProgram().parseAsync(['node', 'sfdt', 'soql', 'relationships', 'Contact', '--direction', 'parent', '--json']);
    expect(discoverRelationships).toHaveBeenCalledWith(CONFIG, 'Contact', expect.objectContaining({ direction: 'parent' }));
    out.mockRestore();
  });

  it('validate exits 0 for a valid query and 1 for an invalid one (envelope still emitted)', async () => {
    validateQuery.mockResolvedValue({ query: 'q', valid: true, mode: 'org', kind: 'soql', errors: [], warnings: [] });
    let out = captureStdout();
    await createProgram().parseAsync(['node', 'sfdt', 'soql', 'validate', 'SELECT Id FROM Account', '--json']);
    expect(process.exitCode).toBeUndefined();
    out.mockRestore();

    validateQuery.mockResolvedValue({ query: 'q', valid: false, mode: 'org', kind: 'soql', errors: ['bad'], warnings: [] });
    out = captureStdout();
    await createProgram().parseAsync(['node', 'sfdt', 'soql', 'validate', 'SELECT Nope FROM Account', '--json']);
    expect(process.exitCode).toBe(1);
    const envelope = JSON.parse(out.mock.calls.map((c) => c[0]).join(''));
    expect(envelope.result.valid).toBe(false);
    out.mockRestore();
  });

  it('validate passes org/tooling/local-only through', async () => {
    validateQuery.mockResolvedValue({ valid: true, errors: [], warnings: [], kind: 'soql', mode: 'local' });
    const out = captureStdout();
    await createProgram().parseAsync(['node', 'sfdt', 'soql', 'validate', 'SELECT Id FROM Account', '--org', 'uat', '--tooling', '--local-only', '--json']);
    expect(validateQuery).toHaveBeenCalledWith(CONFIG, 'SELECT Id FROM Account', { org: 'uat', tooling: true, localOnly: true });
    out.mockRestore();
  });

  it('plan delegates with org and api-version', async () => {
    explainQuery.mockResolvedValue({ org: 'dev', apiVersion: '64.0', query: 'q', plans: [] });
    const out = captureStdout();
    await createProgram().parseAsync(['node', 'sfdt', 'soql', 'plan', 'SELECT Id FROM Account', '--api-version', '63.0', '--json']);
    expect(explainQuery).toHaveBeenCalledWith(CONFIG, 'SELECT Id FROM Account', { org: undefined, apiVersion: '63.0' });
    out.mockRestore();
  });

  it('query delegates the bound-execution options', async () => {
    runQuery.mockResolvedValue({ org: 'dev', records: [], returned: 0, totalSize: 0, truncated: false, bound: { limit: 10, max: 2000, action: 'appended' } });
    const out = captureStdout();
    await createProgram().parseAsync([
      'node', 'sfdt', 'soql', 'query', 'SELECT Id FROM Account',
      '--limit', '10', '--tooling', '--all-rows', '--out', 'rows.csv', '--format', 'csv', '--json',
    ]);
    expect(runQuery).toHaveBeenCalledWith(CONFIG, 'SELECT Id FROM Account', {
      org: undefined, tooling: true, allRows: true, limit: '10', out: 'rows.csv', format: 'csv',
    });
    out.mockRestore();
  });

  it('sosl delegates to runSearch', async () => {
    runSearch.mockResolvedValue({ org: 'dev', records: [], returned: 0, bound: { limit: 10, max: 2000, action: 'appended' } });
    const out = captureStdout();
    await createProgram().parseAsync(['node', 'sfdt', 'soql', 'sosl', 'FIND {Acme} RETURNING Account(Id)', '--limit', '10', '--json']);
    expect(runSearch).toHaveBeenCalledWith(CONFIG, 'FIND {Acme} RETURNING Account(Id)', {
      org: undefined, limit: '10', out: undefined, format: undefined,
    });
    out.mockRestore();
  });

  it('emits the error envelope and exit code on runner failure in --json mode', async () => {
    runQuery.mockRejectedValue(new Error('No org specified — pass --org'));
    const out = captureStdout();
    await createProgram().parseAsync(['node', 'sfdt', 'soql', 'query', 'SELECT Id FROM Account', '--json']);
    const envelope = JSON.parse(out.mock.calls.map((c) => c[0]).join(''));
    expect(envelope).toMatchObject({ name: 'Error', message: expect.stringContaining('No org specified') });
    expect(envelope.status).toBeGreaterThan(0);
    expect(process.exitCode).toBe(envelope.exitCode);
    out.mockRestore();
  });

  it('prints a red error and sets the exit code in human mode', async () => {
    describeSObject.mockRejectedValue(new Error('boom'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'soql', 'describe', 'Account']);
    expect(errSpy.mock.calls.join('\n')).toContain('boom');
    expect(process.exitCode).toBeGreaterThan(0);
    errSpy.mockRestore();
  });
});
