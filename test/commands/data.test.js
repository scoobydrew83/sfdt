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
  listDataSets: vi.fn(),
  readQueries: vi.fn(),
  extractSObject: vi.fn(),
}));
vi.mock('../../src/lib/exit-codes.js', () => ({ resolveExitCode: vi.fn(() => 1) }));
vi.mock('inquirer', () => ({ default: { prompt: vi.fn() } }));
vi.mock('ora', () => ({
  default: vi.fn(() => ({ start: vi.fn().mockReturnThis(), succeed: vi.fn().mockReturnThis(), fail: vi.fn().mockReturnThis(), warn: vi.fn().mockReturnThis() })),
}));

import inquirer from 'inquirer';
import { loadConfig } from '../../src/lib/config.js';
import { exportDataSet, importDataSet, deleteDataSet, listDataSets, readQueries, extractSObject } from '../../src/lib/data-runner.js';
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
    expect(exportDataSet).toHaveBeenCalledWith(expect.any(Object), 'qa', 'dev');
    writeSpy.mockRestore();
  });

  it('imports a data set with an --org override', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().parseAsync(['node', 'sfdt', 'data', 'import', 'qa', '--org', 'staging', '--json']);
    expect(importDataSet).toHaveBeenCalledWith(expect.any(Object), 'qa', 'staging');
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
