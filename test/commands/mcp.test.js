import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

const startMock = vi.fn();
vi.mock('../../src/lib/mcp-server.js', () => ({
  SfdtMcpServer: vi.fn(function () {
    this.start = startMock;
  }),
}));
vi.mock('../../src/lib/mcp-parking.js', () => ({ cleanupParkedResults: vi.fn() }));
vi.mock('../../src/lib/config.js', () => ({ loadConfig: vi.fn() }));
vi.mock('../../src/lib/output.js', () => ({
  print: { success: vi.fn(), error: vi.fn() },
}));

import { SfdtMcpServer } from '../../src/lib/mcp-server.js';
import { cleanupParkedResults } from '../../src/lib/mcp-parking.js';
import { loadConfig } from '../../src/lib/config.js';
import { print } from '../../src/lib/output.js';
import { registerMcpCommand } from '../../src/commands/mcp.js';

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerMcpCommand(program);
  return program;
}

beforeEach(() => {
  vi.resetAllMocks();
  process.exitCode = undefined;
  startMock.mockResolvedValue(undefined);
  loadConfig.mockResolvedValue({ _projectRoot: '/p' });
  cleanupParkedResults.mockResolvedValue(3);
});

describe('mcp command', () => {
  it('start instantiates the server and calls start()', async () => {
    await createProgram().parseAsync(['node', 'sfdt', 'mcp', 'start']);
    expect(SfdtMcpServer).toHaveBeenCalledTimes(1);
    expect(startMock).toHaveBeenCalledTimes(1);
  });

  it('cleanup purges expired parked results and reports the count', async () => {
    await createProgram().parseAsync(['node', 'sfdt', 'mcp', 'cleanup']);
    expect(cleanupParkedResults).toHaveBeenCalledWith({ _projectRoot: '/p' });
    expect(print.success).toHaveBeenCalledWith(expect.stringContaining('3'));
    expect(process.exitCode).toBeUndefined();
  });

  it('cleanup reports an error and sets exit code 1 on failure', async () => {
    cleanupParkedResults.mockRejectedValue(new Error('disk gone'));
    await createProgram().parseAsync(['node', 'sfdt', 'mcp', 'cleanup']);
    expect(print.error).toHaveBeenCalledWith(expect.stringContaining('disk gone'));
    expect(process.exitCode).toBe(1);
  });
});
