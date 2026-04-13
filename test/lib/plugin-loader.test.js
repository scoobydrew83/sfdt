import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../../src/lib/config.js', () => ({
  loadConfig: vi.fn(),
}));

vi.mock('../../src/lib/output.js', () => ({
  print: {
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

import { loadConfig } from '../../src/lib/config.js';
import { print } from '../../src/lib/output.js';

// We test the plugin-loader behaviour through its public API.
// Actual dynamic imports of external packages are integration-level,
// so we keep the unit tests focused on the discovery and error-handling logic.

describe('loadPlugins', () => {
  let program;

  beforeEach(() => {
    vi.resetAllMocks();
    program = new Command();
  });

  it('returns early without error when not in an sfdt project', async () => {
    loadConfig.mockRejectedValue(new Error('not in a project'));

    const { loadPlugins } = await import('../../src/lib/plugin-loader.js');
    await expect(loadPlugins(program)).resolves.toBeUndefined();
  });

  it('does not register commands when config.plugins is empty', async () => {
    loadConfig.mockResolvedValue({
      _projectRoot: '/project',
      _configDir: '/project/.sfdt',
      plugins: [],
    });

    const { loadPlugins } = await import('../../src/lib/plugin-loader.js');
    const before = program.commands.length;
    await loadPlugins(program);

    expect(program.commands.length).toBe(before);
    expect(print.warning).not.toHaveBeenCalled();
  });

  it('warns instead of throwing when a listed plugin cannot be loaded', async () => {
    loadConfig.mockResolvedValue({
      _projectRoot: '/project',
      _configDir: '/project/.sfdt',
      plugins: ['sfdt-plugin-does-not-exist'],
    });

    const { loadPlugins } = await import('../../src/lib/plugin-loader.js');
    await expect(loadPlugins(program)).resolves.toBeUndefined();
    expect(print.warning).toHaveBeenCalledWith(
      expect.stringContaining('sfdt-plugin-does-not-exist'),
    );
  });
});
