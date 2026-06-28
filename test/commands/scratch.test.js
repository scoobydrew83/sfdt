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

  it('prints the pool status summary in pretty mode', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'scratch', 'pool', 'status']);
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('Pool: 1/2');
    logSpy.mockRestore();
  });

  it('prints created-org output in pretty mode after a pool fill', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'scratch', 'pool', 'fill']);
    expect(ensurePool).toHaveBeenCalledWith(expect.any(Object), { desiredSize: undefined });
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('Created 1 org');
    logSpy.mockRestore();
  });

  it('reports a pool fill failure as JSON and sets the exit code', async () => {
    ensurePool.mockRejectedValue(new Error('quota exhausted'));
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().parseAsync(['node', 'sfdt', 'scratch', 'pool', 'fill', '--json']);
    const out = writeSpy.mock.calls.map((c) => c[0]).join('');
    expect(JSON.parse(out)).toMatchObject({ status: 1, message: 'quota exhausted' });
    writeSpy.mockRestore();
  });

  it('reports a pool fill failure on stderr in pretty mode', async () => {
    ensurePool.mockRejectedValue(new Error('quota exhausted'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'scratch', 'pool', 'fill']);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('quota exhausted'));
    expect(process.exitCode).toBe(1);
    errSpy.mockRestore();
  });

  it('reports a pool status failure on stderr in pretty mode', async () => {
    readPool.mockRejectedValue(new Error('no pool file'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'scratch', 'pool', 'status']);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('no pool file'));
    expect(process.exitCode).toBe(1);
    errSpy.mockRestore();
  });

  it('prints the created org JSON in pretty mode for create', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'scratch', 'create']);
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('u@scratch');
    logSpy.mockRestore();
  });

  it('reports a create failure on stderr and sets the exit code', async () => {
    createScratch.mockRejectedValue(new Error('def file missing'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'scratch', 'create']);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('def file missing'));
    expect(process.exitCode).toBe(1);
    errSpy.mockRestore();
  });

  it('reports a list failure as JSON', async () => {
    listScratch.mockRejectedValue(new Error('cli not found'));
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().parseAsync(['node', 'sfdt', 'scratch', 'list', '--json']);
    const out = writeSpy.mock.calls.map((c) => c[0]).join('');
    expect(JSON.parse(out)).toMatchObject({ status: 1, message: 'cli not found' });
    writeSpy.mockRestore();
  });

  it('prints "No scratch orgs." when the list is empty in pretty mode', async () => {
    listScratch.mockResolvedValue([]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'scratch', 'list']);
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('No scratch orgs');
    logSpy.mockRestore();
  });

  it('prints org rows when listing in pretty mode', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'scratch', 'list']);
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('exp:d');
    logSpy.mockRestore();
  });

  it('reports a delete failure on stderr in pretty mode', async () => {
    deleteScratch.mockRejectedValue(new Error('org locked'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'scratch', 'delete', 'dev', '--yes']);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('org locked'));
    expect(process.exitCode).toBe(1);
    errSpy.mockRestore();
  });
});
