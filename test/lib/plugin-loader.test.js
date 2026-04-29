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

vi.mock('fs-extra', () => ({
  default: {
    pathExists: vi.fn(),
    readdir: vi.fn(),
  },
}));

import { loadConfig } from '../../src/lib/config.js';
import { print } from '../../src/lib/output.js';
import fs from 'fs-extra';

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

  // ── autoDiscover: node_modules sfdt-plugin-* ──────────────────────────────

  it('does not scan node_modules when autoDiscover is false (default)', async () => {
    loadConfig.mockResolvedValue({
      _projectRoot: '/project',
      _configDir: '/project/.sfdt',
      plugins: [],
      // pluginOptions.autoDiscover omitted → defaults to undefined / falsy
    });

    const { loadPlugins } = await import('../../src/lib/plugin-loader.js');
    await loadPlugins(program);

    // fs should never be consulted when autoDiscover is off
    expect(fs.pathExists).not.toHaveBeenCalled();
    expect(fs.readdir).not.toHaveBeenCalled();
  });

  it('does not scan node_modules when autoDiscover is false', async () => {
    loadConfig.mockResolvedValue({
      _projectRoot: '/project',
      _configDir: '/project/.sfdt',
      plugins: [],
      pluginOptions: { autoDiscover: false },
    });

    const { loadPlugins } = await import('../../src/lib/plugin-loader.js');
    await loadPlugins(program);

    expect(fs.pathExists).not.toHaveBeenCalled();
  });

  it('skips plugin discovery when node_modules does not exist', async () => {
    loadConfig.mockResolvedValue({
      _projectRoot: '/project',
      _configDir: '/project/.sfdt',
      plugins: [],
      pluginOptions: { autoDiscover: true },
    });

    // node_modules absent, local plugins dir also absent
    fs.pathExists.mockResolvedValue(false);

    const { loadPlugins } = await import('../../src/lib/plugin-loader.js');
    await loadPlugins(program);

    // pathExists checked for node_modules and local plugins dir
    expect(fs.pathExists).toHaveBeenCalledWith('/project/node_modules');
    expect(fs.readdir).not.toHaveBeenCalled();
    expect(print.warning).not.toHaveBeenCalled();
  });

  it('discovers sfdt-plugin-* packages in node_modules and attempts to load them', async () => {
    loadConfig.mockResolvedValue({
      _projectRoot: '/project',
      _configDir: '/project/.sfdt',
      plugins: [],
      pluginOptions: { autoDiscover: true },
    });

    // node_modules exists; local plugins dir does not
    fs.pathExists.mockImplementation((p) => {
      if (p === '/project/node_modules') return Promise.resolve(true);
      return Promise.resolve(false);
    });
    fs.readdir.mockImplementation((p) => {
      if (p === '/project/node_modules') {
        return Promise.resolve(['sfdt-plugin-foo', 'some-other-package']);
      }
      return Promise.resolve([]);
    });

    const { loadPlugins } = await import('../../src/lib/plugin-loader.js');
    await loadPlugins(program);

    // The loader will try to load sfdt-plugin-foo; since it does not resolve,
    // it should emit a warning (not throw).
    expect(print.warning).toHaveBeenCalledWith(
      expect.stringContaining('sfdt-plugin-foo'),
    );
    // non-plugin packages are not touched
    const warningCalls = print.warning.mock.calls.map((c) => c[0]);
    expect(warningCalls.some((m) => m.includes('some-other-package'))).toBe(false);
  });

  it('does not double-load a package that is already in config.plugins', async () => {
    loadConfig.mockResolvedValue({
      _projectRoot: '/project',
      _configDir: '/project/.sfdt',
      plugins: ['sfdt-plugin-foo'],
      pluginOptions: { autoDiscover: true },
    });

    fs.pathExists.mockImplementation((p) => {
      if (p === '/project/node_modules') return Promise.resolve(true);
      return Promise.resolve(false);
    });
    fs.readdir.mockImplementation((p) => {
      if (p === '/project/node_modules') {
        return Promise.resolve(['sfdt-plugin-foo']);
      }
      return Promise.resolve([]);
    });

    const { loadPlugins } = await import('../../src/lib/plugin-loader.js');
    await loadPlugins(program);

    // warning for sfdt-plugin-foo should appear exactly once (from the explicit
    // load attempt), not twice
    const calls = print.warning.mock.calls.filter((c) =>
      c[0].includes('sfdt-plugin-foo'),
    );
    expect(calls.length).toBe(1);
  });

  // ── autoDiscover: scoped packages (@org/sfdt-plugin-*) ───────────────────

  it('discovers scoped sfdt-plugin-* packages inside @org subdirectories', async () => {
    loadConfig.mockResolvedValue({
      _projectRoot: '/project',
      _configDir: '/project/.sfdt',
      plugins: [],
      pluginOptions: { autoDiscover: true },
    });

    fs.pathExists.mockImplementation((p) => {
      if (p === '/project/node_modules') return Promise.resolve(true);
      return Promise.resolve(false);
    });
    fs.readdir.mockImplementation((p) => {
      if (p === '/project/node_modules') {
        return Promise.resolve(['@myorg', 'unrelated-pkg']);
      }
      if (p === '/project/node_modules/@myorg') {
        return Promise.resolve(['sfdt-plugin-bar', 'not-a-plugin']);
      }
      return Promise.resolve([]);
    });

    const { loadPlugins } = await import('../../src/lib/plugin-loader.js');
    await loadPlugins(program);

    // Should attempt (and fail) to load @myorg/sfdt-plugin-bar
    expect(print.warning).toHaveBeenCalledWith(
      expect.stringContaining('@myorg/sfdt-plugin-bar'),
    );
    // Non-plugin scoped package should be ignored
    const warningCalls = print.warning.mock.calls.map((c) => c[0]);
    expect(warningCalls.some((m) => m.includes('not-a-plugin'))).toBe(false);
  });

  it('skips a scoped directory when readdir throws', async () => {
    loadConfig.mockResolvedValue({
      _projectRoot: '/project',
      _configDir: '/project/.sfdt',
      plugins: [],
      pluginOptions: { autoDiscover: true },
    });

    fs.pathExists.mockImplementation((p) => {
      if (p === '/project/node_modules') return Promise.resolve(true);
      return Promise.resolve(false);
    });
    fs.readdir.mockImplementation((p) => {
      if (p === '/project/node_modules') return Promise.resolve(['@badorg']);
      if (p === '/project/node_modules/@badorg') return Promise.reject(new Error('EACCES'));
      return Promise.resolve([]);
    });

    const { loadPlugins } = await import('../../src/lib/plugin-loader.js');
    // Should resolve without throwing
    await expect(loadPlugins(program)).resolves.toBeUndefined();
  });

  // ── autoDiscover: local .sfdt/plugins/*.js files ──────────────────────────

  it('discovers local .js plugin files in configDir/plugins/', async () => {
    loadConfig.mockResolvedValue({
      _projectRoot: '/project',
      _configDir: '/project/.sfdt',
      plugins: [],
      pluginOptions: { autoDiscover: true },
    });

    fs.pathExists.mockImplementation((p) => {
      if (p === '/project/node_modules') return Promise.resolve(true);
      if (p === '/project/.sfdt/plugins') return Promise.resolve(true);
      return Promise.resolve(false);
    });
    fs.readdir.mockImplementation((p) => {
      if (p === '/project/node_modules') return Promise.resolve([]);
      if (p === '/project/.sfdt/plugins') return Promise.resolve(['my-plugin.js', 'README.md']);
      return Promise.resolve([]);
    });

    const { loadPlugins } = await import('../../src/lib/plugin-loader.js');
    await loadPlugins(program);

    // my-plugin.js does not exist on disk, so import will fail → warning
    expect(print.warning).toHaveBeenCalledWith(
      expect.stringContaining('my-plugin.js'),
    );
    // README.md should be filtered out (not .js or .mjs)
    const warningCalls = print.warning.mock.calls.map((c) => c[0]);
    expect(warningCalls.some((m) => m.includes('README.md'))).toBe(false);
  });

  it('discovers local .mjs plugin files in configDir/plugins/', async () => {
    loadConfig.mockResolvedValue({
      _projectRoot: '/project',
      _configDir: '/project/.sfdt',
      plugins: [],
      pluginOptions: { autoDiscover: true },
    });

    fs.pathExists.mockImplementation((p) => {
      if (p === '/project/node_modules') return Promise.resolve(true);
      if (p === '/project/.sfdt/plugins') return Promise.resolve(true);
      return Promise.resolve(false);
    });
    fs.readdir.mockImplementation((p) => {
      if (p === '/project/node_modules') return Promise.resolve([]);
      if (p === '/project/.sfdt/plugins') return Promise.resolve(['my-plugin.mjs']);
      return Promise.resolve([]);
    });

    const { loadPlugins } = await import('../../src/lib/plugin-loader.js');
    await loadPlugins(program);

    expect(print.warning).toHaveBeenCalledWith(
      expect.stringContaining('my-plugin.mjs'),
    );
  });

  it('does not check local plugins dir when autoDiscover is off', async () => {
    loadConfig.mockResolvedValue({
      _projectRoot: '/project',
      _configDir: '/project/.sfdt',
      plugins: [],
      pluginOptions: { autoDiscover: false },
    });

    const { loadPlugins } = await import('../../src/lib/plugin-loader.js');
    await loadPlugins(program);

    expect(fs.pathExists).not.toHaveBeenCalledWith('/project/.sfdt/plugins');
  });

  it('handles node_modules readdir failure gracefully', async () => {
    loadConfig.mockResolvedValue({
      _projectRoot: '/project',
      _configDir: '/project/.sfdt',
      plugins: [],
      pluginOptions: { autoDiscover: true },
    });

    fs.pathExists.mockImplementation((p) => {
      if (p === '/project/node_modules') return Promise.resolve(true);
      return Promise.resolve(false);
    });
    fs.readdir.mockRejectedValue(new Error('EACCES: permission denied'));

    const { loadPlugins } = await import('../../src/lib/plugin-loader.js');
    // readdir failure is swallowed; loader should still resolve cleanly
    await expect(loadPlugins(program)).resolves.toBeUndefined();
  });
});
