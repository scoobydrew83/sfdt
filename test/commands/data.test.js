import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

// Some tests toggle process.stdin.isTTY to exercise interactive paths; always
// restore it so the mutation can't leak into other test files sharing the
// worker (vitest's thread pool shares process globals).
const ORIGINAL_IS_TTY = process.stdin.isTTY;
afterEach(() => {
  process.stdin.isTTY = ORIGINAL_IS_TTY;
});

vi.mock('../../src/lib/config.js', () => ({ loadConfig: vi.fn() }));
vi.mock('../../src/lib/data-runner.js', () => ({
  exportDataSet: vi.fn(),
  importDataSet: vi.fn(),
  deleteDataSet: vi.fn(),
  bulkLoadDataSet: vi.fn(),
  listDataSets: vi.fn(),
  readQueries: vi.fn(),
  extractSObject: vi.fn(),
}));
vi.mock('../../src/lib/exit-codes.js', () => ({ resolveExitCode: vi.fn(() => 1) }));
// The guard itself is covered in org-facts/automation tests; here we assert the
// WIRING — that `data load` calls it, and with the right subject.
vi.mock('../../src/lib/org-facts.js', () => ({
  guardProduction: vi.fn().mockResolvedValue({ isProduction: false, acknowledged: false }),
  isProductionOrg: vi.fn().mockResolvedValue(false),
}));
vi.mock('inquirer', () => ({ default: { prompt: vi.fn() } }));
vi.mock('ora', () => ({
  default: vi.fn(() => ({ start: vi.fn().mockReturnThis(), succeed: vi.fn().mockReturnThis(), fail: vi.fn().mockReturnThis(), warn: vi.fn().mockReturnThis() })),
}));

import inquirer from 'inquirer';
import { guardProduction } from '../../src/lib/org-facts.js';
import { loadConfig } from '../../src/lib/config.js';
import { exportDataSet, importDataSet, deleteDataSet, bulkLoadDataSet, listDataSets, readQueries, extractSObject } from '../../src/lib/data-runner.js';
import { registerDataCommand } from '../../src/commands/data.js';

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerDataCommand(program);
  return program;
}

beforeEach(() => {
  vi.resetAllMocks();
  process.exitCode = undefined;
  loadConfig.mockResolvedValue({ _projectRoot: '/p', defaultOrg: 'dev' });
  exportDataSet.mockResolvedValue({ set: 'qa', org: 'dev', planFile: '/p/.sfdt/data/qa/data/A-plan.json' });
  importDataSet.mockResolvedValue({ set: 'qa', org: 'dev', imported: 3 });
  listDataSets.mockResolvedValue(['qa', 'demo']);
  deleteDataSet.mockResolvedValue({ set: 'qa', org: 'dev', sobjects: [{ sobject: 'Account', status: 'ok' }] });
  readQueries.mockResolvedValue(['SELECT Id FROM Account']);
  extractSObject.mockReturnValue('Account');
});

describe('data command', () => {
  it('exports a data set using the default org', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().parseAsync(['node', 'sfdt', 'data', 'export', 'qa', '--json']);
    // makeAction threads the parsed options through to every runner so the bulk
    // verbs can read --wait/--async; the tree verbs simply ignore it.
    expect(exportDataSet).toHaveBeenCalledWith(expect.any(Object), 'qa', 'dev', expect.any(Object));
    writeSpy.mockRestore();
  });

  it('imports a data set with an --org override', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().parseAsync(['node', 'sfdt', 'data', 'import', 'qa', '--org', 'staging', '--json']);
    expect(importDataSet).toHaveBeenCalledWith(expect.any(Object), 'qa', 'staging', expect.any(Object));
    writeSpy.mockRestore();
  });

  it('lists data sets as JSON', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().parseAsync(['node', 'sfdt', 'data', 'list', '--json']);
    const out = writeSpy.mock.calls.map((c) => c[0]).join('');
    expect(JSON.parse(out)).toMatchObject({ status: 0, result: { sets: ['qa', 'demo'] } });
    writeSpy.mockRestore();
  });

  it('errors as JSON when no org is configured', async () => {
    loadConfig.mockResolvedValue({ _projectRoot: '/p' });
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().parseAsync(['node', 'sfdt', 'data', 'export', 'qa', '--json']);
    const out = writeSpy.mock.calls.map((c) => c[0]).join('');
    expect(JSON.parse(out)).toMatchObject({ status: 1 });
    writeSpy.mockRestore();
  });

  it('prints the export result in pretty mode', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'data', 'export', 'qa']);
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('A-plan.json');
    logSpy.mockRestore();
  });

  it('reports an export failure on stderr in pretty mode', async () => {
    exportDataSet.mockRejectedValue(new Error('no such set'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'data', 'export', 'qa']);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('no such set'));
    expect(process.exitCode).toBe(1);
    errSpy.mockRestore();
  });

  it('lists data sets in pretty mode', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'data', 'list']);
    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('qa');
    expect(out).toContain('demo');
    logSpy.mockRestore();
  });

  it('prints a hint when no data sets exist (pretty mode)', async () => {
    listDataSets.mockResolvedValue([]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'data', 'list']);
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('No data sets found');
    logSpy.mockRestore();
  });

  it('reports a list failure as JSON', async () => {
    listDataSets.mockRejectedValue(new Error('fs error'));
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().parseAsync(['node', 'sfdt', 'data', 'list', '--json']);
    const out = writeSpy.mock.calls.map((c) => c[0]).join('');
    expect(JSON.parse(out)).toMatchObject({ status: 1, message: 'fs error' });
    writeSpy.mockRestore();
  });

  it('reports a list failure on stderr in pretty mode', async () => {
    listDataSets.mockRejectedValue(new Error('fs error'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'data', 'list']);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('fs error'));
    expect(process.exitCode).toBe(1);
    errSpy.mockRestore();
  });
});

describe('data delete is guarded against production', () => {
  // Bulk delete removes every record the set's queries match — the most
  // destructive operation in this CLI. Before this it was the one write that
  // was EASIER to run against production than a permission grant: it had a
  // confirmation but no production guard.
  beforeEach(() => {
    readQueries.mockResolvedValue(['SELECT Id FROM Account']);
    extractSObject.mockReturnValue('Account');
    deleteDataSet.mockResolvedValue({ set: 'seed', org: 'dev', sobjects: [] });
  });

  it('asks the production guard, naming what is about to happen', async () => {
    await createProgram().parseAsync(['node', 'sfdt', 'data', 'delete', 'seed', '--yes']);

    expect(guardProduction).toHaveBeenCalledWith(
      'dev',
      expect.anything(),
      expect.stringMatching(/bulk-delete records/),
    );
  });

  it('refuses BEFORE prompting, so a refused org is never asked about', async () => {
    // Order matters: a guard that ran after the prompt would make the operator
    // confirm a deletion the CLI was always going to refuse.
    process.stdin.isTTY = true;
    const refusal = new Error('"prod" looks like a production org — re-run with --production');
    guardProduction.mockRejectedValueOnce(refusal);

    await createProgram().parseAsync(['node', 'sfdt', 'data', 'delete', 'seed']);

    expect(inquirer.prompt, 'the operator must not be prompted for a refused org').not.toHaveBeenCalled();
    expect(deleteDataSet).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('still deletes on a sandbox without --production', async () => {
    await createProgram().parseAsync(['node', 'sfdt', 'data', 'delete', 'seed', '--yes']);
    expect(deleteDataSet).toHaveBeenCalled();
  });
});

describe('data delete confirmation', () => {
  it('deletes without prompting when --yes is passed', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().parseAsync(['node', 'sfdt', 'data', 'delete', 'qa', '--yes', '--json']);
    expect(deleteDataSet).toHaveBeenCalledWith(expect.any(Object), 'qa', 'dev');
    expect(inquirer.prompt).not.toHaveBeenCalled();
    writeSpy.mockRestore();
  });

  it('reports skippedCount in --json when a query was skipped', async () => {
    deleteDataSet.mockResolvedValueOnce({
      set: 'qa',
      org: 'dev',
      sobjects: [
        { sobject: 'Account', status: 'ok' },
        { sobject: null, status: 'skipped', query: 'not soql' },
      ],
    });
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().parseAsync(['node', 'sfdt', 'data', 'delete', 'qa', '--yes', '--json']);
    const out = writeSpy.mock.calls.map((c) => c[0]).join('');
    expect(JSON.parse(out)).toMatchObject({ status: 0, result: { skippedCount: 1 } });
    writeSpy.mockRestore();
  });

  it('reports errorCount in --json when a sobject delete failed', async () => {
    deleteDataSet.mockResolvedValueOnce({
      set: 'qa',
      org: 'dev',
      sobjects: [
        { sobject: 'Account', status: 'ok' },
        { sobject: 'Contact', status: 'error', error: 'No authorization information found for dev.' },
      ],
    });
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().parseAsync(['node', 'sfdt', 'data', 'delete', 'qa', '--yes', '--json']);
    const out = writeSpy.mock.calls.map((c) => c[0]).join('');
    expect(JSON.parse(out)).toMatchObject({ status: 0, result: { errorCount: 1, skippedCount: 0 } });
    writeSpy.mockRestore();
  });

  it('refuses to delete non-interactively without --yes', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    // --json forces non-interactive; without --yes the delete must be refused.
    await createProgram().parseAsync(['node', 'sfdt', 'data', 'delete', 'qa', '--json']);
    expect(deleteDataSet).not.toHaveBeenCalled();
    const out = writeSpy.mock.calls.map((c) => c[0]).join('');
    expect(JSON.parse(out)).toMatchObject({ status: 1, message: expect.stringMatching(/--yes/) });
    writeSpy.mockRestore();
  });

  it('deletes after an interactive confirmation', async () => {
    process.stdin.isTTY = true;
    inquirer.prompt.mockResolvedValue({ confirmed: true });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'data', 'delete', 'qa']);
    expect(inquirer.prompt).toHaveBeenCalled();
    expect(deleteDataSet).toHaveBeenCalledWith(expect.any(Object), 'qa', 'dev');
    logSpy.mockRestore();
  });

  it('aborts when the interactive confirmation is declined', async () => {
    process.stdin.isTTY = true;
    inquirer.prompt.mockResolvedValue({ confirmed: false });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'data', 'delete', 'qa']);
    expect(inquirer.prompt).toHaveBeenCalled();
    expect(deleteDataSet).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('warns on stderr about failed/skipped sobjects in pretty mode', async () => {
    deleteDataSet.mockResolvedValueOnce({
      set: 'qa',
      org: 'dev',
      sobjects: [
        { sobject: 'Account', status: 'error', error: 'boom' },
        { sobject: null, status: 'skipped', query: 'bad' },
      ],
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'data', 'delete', 'qa', '--yes']);
    const warns = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warns).toContain('FAILED');
    expect(warns).toContain('skipped');
    warnSpy.mockRestore();
  });

  it('reports a thrown delete failure on stderr in pretty mode', async () => {
    deleteDataSet.mockRejectedValueOnce(new Error('bulk api down'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'data', 'delete', 'qa', '--yes']);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('bulk api down'));
    expect(process.exitCode).toBe(1);
    errSpy.mockRestore();
  });
});

describe('data load is braked like the writes beside it', () => {
  // `load` inserts or UPSERTS — an upsert overwrites existing records, which is
  // not obviously safer than the operations that were already gated. `delete`
  // has demanded a confirmation since it shipped; `load` shipped with neither a
  // guard nor a confirmation. These assert the rule is now uniform.
  beforeEach(() => {
    bulkLoadDataSet.mockResolvedValue({
      set: 'seed', org: 'dev', kind: 'bulk',
      operations: [{ sobject: 'Account', operation: 'upsert', status: 'ok', processed: 1, failed: 0 }],
    });
  });

  it('asks the production guard before writing anything', async () => {
    await createProgram().parseAsync(['node', 'sfdt', 'data', 'load', 'seed', '--yes']);

    expect(guardProduction).toHaveBeenCalledWith(
      'dev',
      expect.anything(),
      expect.stringMatching(/insert or overwrite records/),
    );
  });

  it('REFUSES when non-interactive without --yes, and loads nothing', async () => {
    // A prompt in CI is either a hang or a silent yes. Refusing is the only
    // honest third option — the same rule `data delete` already follows.
    process.stdin.isTTY = false;

    await createProgram().parseAsync(['node', 'sfdt', 'data', 'load', 'seed']);

    expect(bulkLoadDataSet, 'the load must not run without confirmation').not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('aborts without loading when the operator declines the prompt', async () => {
    process.stdin.isTTY = true;
    inquirer.prompt.mockResolvedValue({ confirmed: false });

    await createProgram().parseAsync(['node', 'sfdt', 'data', 'load', 'seed']);

    expect(bulkLoadDataSet).not.toHaveBeenCalled();
  });

  it('proceeds when the operator confirms at the prompt', async () => {
    process.stdin.isTTY = true;
    inquirer.prompt.mockResolvedValue({ confirmed: true });

    await createProgram().parseAsync(['node', 'sfdt', 'data', 'load', 'seed']);

    expect(bulkLoadDataSet).toHaveBeenCalled();
  });
});

describe('data load', () => {
  beforeEach(() => {
    bulkLoadDataSet.mockResolvedValue({
      set: 'seed', org: 'dev', kind: 'bulk', waitMinutes: 10,
      operations: [{ sobject: 'Account', operation: 'insert', file: 'a.csv', status: 'ok', processed: 3, failed: 0 }],
    });
  });

  it('loads a bulk data set and leaves the exit code clean', async () => {
    await createProgram().parseAsync(['node', 'sfdt', 'data', 'load', 'seed', '--yes', '--yes']);
    expect(bulkLoadDataSet).toHaveBeenCalledWith(
      expect.anything(), 'seed', 'dev', expect.objectContaining({ async: false }));
    expect(process.exitCode).toBeUndefined();
  });

  it('exits non-zero when any operation failed, so CI can branch on it', async () => {
    bulkLoadDataSet.mockResolvedValue({
      set: 'seed', org: 'dev', kind: 'bulk', waitMinutes: 10,
      operations: [
        { sobject: 'Account', status: 'ok' },
        { sobject: 'Contact', status: 'error', error: 'INVALID_FIELD' },
      ],
    });
    await createProgram().parseAsync(['node', 'sfdt', 'data', 'load', 'seed', '--yes', '--yes']);
    expect(process.exitCode).toBe(1);
  });

  it('emits errorCount in the JSON envelope alongside the raw result', async () => {
    bulkLoadDataSet.mockResolvedValue({
      set: 'seed', org: 'dev', kind: 'bulk', waitMinutes: 10,
      operations: [{ sobject: 'Contact', status: 'error', error: 'boom' }],
    });
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().parseAsync(['node', 'sfdt', 'data', 'load', 'seed', '--yes', '--json']);
    const payload = JSON.parse(spy.mock.calls.at(-1)[0]);
    spy.mockRestore();
    expect(payload.result.errorCount).toBe(1);
    expect(payload.result.operations[0].error).toBe('boom');
  });

  it('passes --wait through as a number of minutes', async () => {
    await createProgram().parseAsync(['node', 'sfdt', 'data', 'load', 'seed', '--yes', '--wait', '25']);
    expect(bulkLoadDataSet).toHaveBeenCalledWith(
      expect.anything(), 'seed', 'dev', expect.objectContaining({ waitMinutes: 25 }));
  });

  it('rejects a non-numeric --wait before it reaches sf', async () => {
    await createProgram().parseAsync(['node', 'sfdt', 'data', 'load', 'seed', '--yes', '--wait', 'soon']);
    expect(bulkLoadDataSet).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('warns about fieldMap keys that matched no CSV column', async () => {
    bulkLoadDataSet.mockResolvedValue({
      set: 'seed', org: 'dev', kind: 'bulk', waitMinutes: 10,
      operations: [{ sobject: 'Account', status: 'ok', unmatchedFieldMapKeys: ['Nmae'] }],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'data', 'load', 'seed', '--yes', '--yes']);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/Nmae/);
    warn.mockRestore();
  });
});

describe('data load --line-ending', () => {
  beforeEach(() => {
    bulkLoadDataSet.mockResolvedValue({ set: 'seed', org: 'dev', kind: 'bulk', operations: [] });
  });

  it('normalises case and passes it through', async () => {
    await createProgram().parseAsync(['node', 'sfdt', 'data', 'load', 'seed', '--yes', '--line-ending', 'crlf']);
    expect(bulkLoadDataSet).toHaveBeenCalledWith(
      expect.anything(), 'seed', 'dev', expect.objectContaining({ lineEnding: 'CRLF' }));
  });

  it('rejects an unknown value before it reaches sf', async () => {
    await createProgram().parseAsync(['node', 'sfdt', 'data', 'load', 'seed', '--yes', '--line-ending', 'CR']);
    expect(bulkLoadDataSet).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
