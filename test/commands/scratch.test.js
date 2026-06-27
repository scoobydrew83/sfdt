import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
vi.mock('inquirer', () => ({ default: { prompt: vi.fn() } }));
vi.mock('ora', () => ({
  default: vi.fn(() => ({ start: vi.fn().mockReturnThis(), succeed: vi.fn().mockReturnThis(), fail: vi.fn().mockReturnThis() })),
}));

import inquirer from 'inquirer';
import { loadConfig } from '../../src/lib/config.js';
import { createScratch, deleteScratch, listScratch, ensurePool, readPool } from '../../src/lib/scratch-pool.js';
import { registerScratchCommand } from '../../src/commands/scratch.js';

// Some tests toggle process.stdin.isTTY; always restore it (vitest's thread
// pool shares process globals across files).
const ORIGINAL_IS_TTY = process.stdin.isTTY;
afterEach(() => {
  process.stdin.isTTY = ORIGINAL_IS_TTY;
});

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

  it('deletes a scratch org with --yes (no prompt)', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().parseAsync(['node', 'sfdt', 'scratch', 'delete', 'dev', '--yes', '--json']);
    expect(deleteScratch).toHaveBeenCalledWith('dev');
    expect(inquirer.prompt).not.toHaveBeenCalled();
    writeSpy.mockRestore();
  });

  it('refuses to delete non-interactively without --yes', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().parseAsync(['node', 'sfdt', 'scratch', 'delete', 'dev', '--json']);
    expect(deleteScratch).not.toHaveBeenCalled();
    const out = writeSpy.mock.calls.map((c) => c[0]).join('');
    expect(JSON.parse(out)).toMatchObject({ status: 1, message: expect.stringMatching(/--yes/) });
    writeSpy.mockRestore();
  });

  it('deletes after an interactive confirmation', async () => {
    process.stdin.isTTY = true;
    inquirer.prompt.mockResolvedValue({ confirmed: true });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'scratch', 'delete', 'dev']);
    expect(deleteScratch).toHaveBeenCalledWith('dev');
    logSpy.mockRestore();
  });

  it('aborts when the interactive confirmation is declined', async () => {
    process.stdin.isTTY = true;
    inquirer.prompt.mockResolvedValue({ confirmed: false });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'scratch', 'delete', 'dev']);
    expect(deleteScratch).not.toHaveBeenCalled();
    logSpy.mockRestore();
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
