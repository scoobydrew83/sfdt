import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../../src/lib/config.js', () => ({
  loadConfig: vi.fn(),
}));

vi.mock('../../src/lib/gui-server.js', () => ({
  startGuiServer: vi.fn(),
}));

vi.mock('../../src/lib/output.js', () => ({
  print: {
    header: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    step: vi.fn(),
  },
}));

import { loadConfig } from '../../src/lib/config.js';
import { startGuiServer } from '../../src/lib/gui-server.js';
import { print } from '../../src/lib/output.js';
import { registerUiCommand } from '../../src/commands/ui.js';

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerUiCommand(program);
  return program;
}

const mockServer = {
  close: vi.fn((cb) => cb && cb()),
};

beforeEach(() => {
  vi.resetAllMocks();
  process.exitCode = undefined;

  loadConfig.mockResolvedValue({
    _projectRoot: '/project',
    defaultOrg: 'dev',
    features: {},
  });

  startGuiServer.mockResolvedValue(mockServer);
});

describe('ui command', () => {
  it('starts the GUI server on the default port', async () => {
    await createProgram().parseAsync(['node', 'sfdt', 'ui', '--no-open']);

    expect(startGuiServer).toHaveBeenCalledWith(
      7654,
      expect.any(Object),
      expect.any(String),
    );
    expect(print.success).toHaveBeenCalledWith(expect.stringContaining('localhost:7654'));
  });

  it('starts the GUI server on a custom port with --port', async () => {
    await createProgram().parseAsync(['node', 'sfdt', 'ui', '--port', '9000', '--no-open']);

    expect(startGuiServer).toHaveBeenCalledWith(9000, expect.any(Object), expect.any(String));
    expect(print.success).toHaveBeenCalledWith(expect.stringContaining('localhost:9000'));
  });

  it('falls back gracefully when config cannot be loaded', async () => {
    loadConfig.mockRejectedValue(new Error('No project found'));

    await createProgram().parseAsync(['node', 'sfdt', 'ui', '--no-open']);

    // Should still start the server with a minimal config
    expect(startGuiServer).toHaveBeenCalledWith(
      7654,
      expect.objectContaining({ _projectRoot: expect.any(String) }),
      expect.any(String),
    );
  });

  it('sets exitCode 1 when port is already in use', async () => {
    const addrInUse = new Error('address in use');
    addrInUse.code = 'EADDRINUSE';
    startGuiServer.mockRejectedValue(addrInUse);

    await createProgram().parseAsync(['node', 'sfdt', 'ui', '--no-open']);

    expect(print.error).toHaveBeenCalledWith(expect.stringContaining('already in use'));
    expect(process.exitCode).toBe(1);
  });

  it('sets exitCode 1 when server fails to start for other reasons', async () => {
    startGuiServer.mockRejectedValue(new Error('EACCES'));

    await createProgram().parseAsync(['node', 'sfdt', 'ui', '--no-open']);

    expect(print.error).toHaveBeenCalledWith(expect.stringContaining('Failed to start server'));
    expect(process.exitCode).toBe(1);
  });
});
