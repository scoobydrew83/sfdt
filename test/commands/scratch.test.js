import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../../src/lib/config.js', () => ({ loadConfig: vi.fn() }));
vi.mock('../../src/lib/scratch-pool.js', () => ({
  createScratch: vi.fn(),
  deleteScratch: vi.fn(),
  listScratch: vi.fn(),
  ensurePool: vi.fn(),
  readPool: vi.fn(),
}));
vi.mock('../../src/lib/exit-codes.js', () => ({ resolveExitCode: vi.fn(() => 1) }));
vi.mock('ora', () => ({
  default: vi.fn(() => ({ start: vi.fn().mockReturnThis(), succeed: vi.fn().mockReturnThis(), fail: vi.fn().mockReturnThis() })),
}));

import { loadConfig } from '../../src/lib/config.js';
import { createScratch, deleteScratch, listScratch, ensurePool, readPool } from '../../src/lib/scratch-pool.js';
import { registerScratchCommand } from '../../src/commands/scratch.js';

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerScratchCommand(program);
  return program;
}

beforeEach(() => {
  vi.resetAllMocks();
  process.exitCode = undefined;
  loadConfig.mockResolvedValue({ _projectRoot: '/p', scratch: { poolSize: 2 } });
  createScratch.mockResolvedValue({ alias: 'dev', username: 'u@scratch', orgId: '00D' });
  deleteScratch.mockResolvedValue({ deleted: 'dev' });
  listScratch.mockResolvedValue([{ alias: 'a', username: 'u', expirationDate: 'd' }]);
  ensurePool.mockResolvedValue({ created: 1, size: 2, members: [{}, {}] });
  readPool.mockResolvedValue({ size: 2, members: [{}] });
});

describe('scratch command', () => {
  it('creates a scratch org with alias and days', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().parseAsync(['node', 'sfdt', 'scratch', 'create', '--alias', 'dev', '--days', '7', '--json']);
    expect(createScratch).toHaveBeenCalledWith(expect.any(Object), { alias: 'dev', durationDays: 7 });
    writeSpy.mockRestore();
  });

  it('deletes a scratch org', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().parseAsync(['node', 'sfdt', 'scratch', 'delete', 'dev', '--json']);
    expect(deleteScratch).toHaveBeenCalledWith('dev');
    writeSpy.mockRestore();
  });

  it('lists scratch orgs', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().parseAsync(['node', 'sfdt', 'scratch', 'list', '--json']);
    expect(listScratch).toHaveBeenCalled();
    writeSpy.mockRestore();
  });

  it('fills the pool', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().parseAsync(['node', 'sfdt', 'scratch', 'pool', 'fill', '--size', '2', '--json']);
    expect(ensurePool).toHaveBeenCalledWith(expect.any(Object), { desiredSize: 2 });
    writeSpy.mockRestore();
  });

  it('shows pool status', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().parseAsync(['node', 'sfdt', 'scratch', 'pool', 'status', '--json']);
    expect(readPool).toHaveBeenCalled();
    writeSpy.mockRestore();
  });
});
