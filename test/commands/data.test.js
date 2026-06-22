import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../../src/lib/config.js', () => ({ loadConfig: vi.fn() }));
vi.mock('../../src/lib/data-runner.js', () => ({
  exportDataSet: vi.fn(),
  importDataSet: vi.fn(),
  deleteDataSet: vi.fn(),
  listDataSets: vi.fn(),
}));
vi.mock('../../src/lib/exit-codes.js', () => ({ resolveExitCode: vi.fn(() => 1) }));
vi.mock('ora', () => ({
  default: vi.fn(() => ({ start: vi.fn().mockReturnThis(), succeed: vi.fn().mockReturnThis(), fail: vi.fn().mockReturnThis() })),
}));

import { loadConfig } from '../../src/lib/config.js';
import { exportDataSet, importDataSet, listDataSets } from '../../src/lib/data-runner.js';
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
