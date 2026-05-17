import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs-extra', () => ({
  default: {
    pathExists: vi.fn(),
    chmod: vi.fn(),
  },
}));

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

vi.mock('../src/lib/output.js', () => ({
  print: {
    info: vi.fn(),
    step: vi.fn(),
    header: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

import fs from 'fs-extra';
import { runScript } from '../src/lib/script-runner.js';
import { print } from '../src/lib/output.js';
import { execa } from 'execa';

const mockConfig = {
  _projectRoot: '/project',
  _configDir: '/project/.sfdt',
  defaultOrg: 'dev',
  features: {},
};

beforeEach(() => {
  vi.resetAllMocks();
  fs.pathExists.mockResolvedValue(true);
  fs.chmod.mockResolvedValue(undefined);
  execa.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
});

describe('runScript dry-run mode', () => {
  it('does not call execa when dryRun is true', async () => {
    await runScript('core/deployment-assistant.sh', mockConfig, { dryRun: true });
    expect(execa).not.toHaveBeenCalled();
  });

  it('returns exitCode 0 when dryRun is true', async () => {
    const result = await runScript('core/deployment-assistant.sh', mockConfig, { dryRun: true });
    expect(result.exitCode).toBe(0);
  });

  it('prints the script path info when dryRun is true', async () => {
    await runScript('core/deployment-assistant.sh', mockConfig, { dryRun: true });
    expect(print.info).toHaveBeenCalledWith(expect.stringContaining('core/deployment-assistant.sh'));
  });

  it('prints the working directory when dryRun is true', async () => {
    await runScript('core/deployment-assistant.sh', mockConfig, {
      dryRun: true,
      cwd: '/project',
    });
    expect(print.info).toHaveBeenCalledWith(expect.stringContaining('/project'));
  });

  it('prints SFDT_ environment variables when dryRun is true', async () => {
    await runScript('core/deployment-assistant.sh', mockConfig, { dryRun: true });
    expect(print.info).toHaveBeenCalledWith(expect.stringContaining('SFDT_'));
  });

  it('does not check if script file exists when dryRun is true', async () => {
    await runScript('core/non-existent.sh', mockConfig, { dryRun: true });
    // pathExists should not be checked (no throw)
    expect(execa).not.toHaveBeenCalled();
  });

  it('still calls execa when dryRun is false', async () => {
    await runScript('core/deployment-assistant.sh', mockConfig, { dryRun: false });
    expect(execa).toHaveBeenCalled();
  });
});
