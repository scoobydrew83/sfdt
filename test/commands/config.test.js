import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

vi.mock('fs-extra', () => ({
  default: {
    readJson: vi.fn(),
    writeJson: vi.fn(),
  },
}));

vi.mock('../../src/lib/config.js', () => ({
  getConfigDir: vi.fn(),
  loadConfig: vi.fn(),
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

import fs from 'fs-extra';
import { getConfigDir, loadConfig } from '../../src/lib/config.js';
import { print } from '../../src/lib/output.js';
import { registerConfigCommand } from '../../src/commands/config.js';

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerConfigCommand(program);
  return program;
}

beforeEach(() => {
  vi.resetAllMocks();
  process.exitCode = undefined;
  getConfigDir.mockReturnValue('/project/.sfdt');
  fs.readJson.mockResolvedValue({
    projectName: 'My Org',
    defaultOrg: 'dev-sandbox',
    deployment: { coverageThreshold: 75, preflight: { enforceTests: false } },
    features: { ai: true },
  });
  fs.writeJson.mockResolvedValue(undefined);
  loadConfig.mockResolvedValue({
    projectName: 'My Org',
    defaultOrg: 'dev-sandbox',
    deployment: { coverageThreshold: 75, preflight: { enforceTests: false } },
    features: { ai: true },
    _projectRoot: '/project',
    _configDir: '/project/.sfdt',
  });
});

describe('config set', () => {
  it('writes a string value at a top-level key', async () => {
    await createProgram().parseAsync(['node', 'sfdt', 'config', 'set', 'defaultOrg', 'prod']);

    expect(fs.writeJson).toHaveBeenCalledWith(
      '/project/.sfdt/config.json',
      expect.objectContaining({ defaultOrg: 'prod' }),
      { spaces: 2 },
    );
    expect(print.success).toHaveBeenCalledWith('Set defaultOrg = prod');
  });

  it('coerces a numeric string to a number', async () => {
    await createProgram().parseAsync(['node', 'sfdt', 'config', 'set', 'deployment.coverageThreshold', '80']);

    const written = fs.writeJson.mock.calls[0][1];
    expect(written.deployment.coverageThreshold).toBe(80);
    expect(typeof written.deployment.coverageThreshold).toBe('number');
  });

  it('coerces "true" to boolean true', async () => {
    await createProgram().parseAsync(['node', 'sfdt', 'config', 'set', 'deployment.preflight.enforceTests', 'true']);

    const written = fs.writeJson.mock.calls[0][1];
    expect(written.deployment.preflight.enforceTests).toBe(true);
  });

  it('coerces "false" to boolean false', async () => {
    await createProgram().parseAsync(['node', 'sfdt', 'config', 'set', 'features.ai', 'false']);

    const written = fs.writeJson.mock.calls[0][1];
    expect(written.features.ai).toBe(false);
  });

  it('creates intermediate objects for new nested keys', async () => {
    fs.readJson.mockResolvedValue({ projectName: 'My Org', features: {} });

    await createProgram().parseAsync(['node', 'sfdt', 'config', 'set', 'newSection.newKey', '42']);

    const written = fs.writeJson.mock.calls[0][1];
    expect(written.newSection.newKey).toBe(42);
  });

  it('sets exitCode and prints error when getConfigDir throws', async () => {
    getConfigDir.mockImplementation(() => { throw new Error('no .sfdt found'); });

    await createProgram().parseAsync(['node', 'sfdt', 'config', 'set', 'defaultOrg', 'x']);

    expect(print.error).toHaveBeenCalledWith(expect.stringContaining('no .sfdt found'));
    expect(process.exitCode).toBeDefined();
  });
});

describe('config get', () => {
  it('prints a top-level value', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await createProgram().parseAsync(['node', 'sfdt', 'config', 'get', 'defaultOrg']);

    expect(spy).toHaveBeenCalledWith('dev-sandbox');
    spy.mockRestore();
  });

  it('prints a nested value', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await createProgram().parseAsync(['node', 'sfdt', 'config', 'get', 'deployment.coverageThreshold']);

    expect(spy).toHaveBeenCalledWith(75);
    spy.mockRestore();
  });

  it('sets exitCode 1 and prints error for missing key', async () => {
    await createProgram().parseAsync(['node', 'sfdt', 'config', 'get', 'nonexistent.key']);

    expect(print.error).toHaveBeenCalledWith(expect.stringContaining('nonexistent.key'));
    expect(process.exitCode).toBe(1);
  });

  it('sets exitCode and prints error when loadConfig throws', async () => {
    loadConfig.mockRejectedValue(new Error('run sfdt init first'));

    await createProgram().parseAsync(['node', 'sfdt', 'config', 'get', 'defaultOrg']);

    expect(print.error).toHaveBeenCalledWith(expect.stringContaining('run sfdt init first'));
    expect(process.exitCode).toBeDefined();
  });
});
