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
  default: vi.fn(() => ({ start: vi.fn().mockReturnThis(), succeed: vi.fn().mockReturnThis(), fail: vi.fn().mockReturnThis() })),
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
    expect(JSON.parse(out)).toMatchObject({ sets: ['qa', 'demo'] });
    writeSpy.mockRestore();
  });

  it('errors as JSON when no org is configured', async () => {
    loadConfig.mockResolvedValue({ _projectRoot: '/p' });
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().parseAsync(['node', 'sfdt', 'data', 'export', 'qa', '--json']);
    const out = writeSpy.mock.calls.map((c) => c[0]).join('');
    expect(JSON.parse(out)).toMatchObject({ status: 'error' });
    writeSpy.mockRestore();
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

  it('refuses to delete non-interactively without --yes', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    // --json forces non-interactive; without --yes the delete must be refused.
    await createProgram().parseAsync(['node', 'sfdt', 'data', 'delete', 'qa', '--json']);
    expect(deleteDataSet).not.toHaveBeenCalled();
    const out = writeSpy.mock.calls.map((c) => c[0]).join('');
    expect(JSON.parse(out)).toMatchObject({ status: 'error', message: expect.stringMatching(/--yes/) });
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
});
