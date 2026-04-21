import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../../src/lib/output.js', () => ({
  print: {
    header: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    step: vi.fn(),
  },
  createSpinner: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
  })),
}));

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

vi.mock('inquirer', () => ({
  default: { prompt: vi.fn() },
}));

vi.mock('../../src/lib/update-checker.js', () => ({
  fetchLatestVersion: vi.fn(),
}));

import { print } from '../../src/lib/output.js';
import { execa } from 'execa';
import inquirer from 'inquirer';
import { fetchLatestVersion } from '../../src/lib/update-checker.js';
import { registerUpdateCommand } from '../../src/commands/update.js';

const CURRENT_VERSION = '0.4.2';
const LATEST_VERSION = '0.5.0';

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerUpdateCommand(program);
  return program;
}

beforeEach(() => {
  vi.resetAllMocks();
  process.exitCode = undefined;
  fetchLatestVersion.mockResolvedValue(LATEST_VERSION);
});

describe('update command', () => {
  it('fetches latest version from npm registry', async () => {
    inquirer.prompt.mockResolvedValue({ confirm: false });

    await createProgram().parseAsync(['node', 'sfdt', 'update']);

    expect(fetchLatestVersion).toHaveBeenCalledOnce();
  });

  it('shows current and latest version then prompts for confirmation', async () => {
    inquirer.prompt.mockResolvedValue({ confirm: true });
    execa.mockResolvedValue({ exitCode: 0 });

    await createProgram().parseAsync(['node', 'sfdt', 'update']);

    expect(inquirer.prompt).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ name: 'confirm', type: 'confirm' }),
      ]),
    );
  });

  it('runs npm install -g when confirmed', async () => {
    inquirer.prompt.mockResolvedValue({ confirm: true });
    execa.mockResolvedValue({ exitCode: 0 });

    await createProgram().parseAsync(['node', 'sfdt', 'update']);

    expect(execa).toHaveBeenCalledWith(
      'npm',
      ['install', '--global', '@sfdt/cli@latest'],
      expect.objectContaining({ stdio: 'inherit' }),
    );
    expect(print.success).toHaveBeenCalled();
  });

  it('skips prompt and installs directly with --force', async () => {
    execa.mockResolvedValue({ exitCode: 0 });

    await createProgram().parseAsync(['node', 'sfdt', 'update', '--force']);

    expect(inquirer.prompt).not.toHaveBeenCalled();
    expect(execa).toHaveBeenCalledWith(
      'npm',
      ['install', '--global', '@sfdt/cli@latest'],
      expect.objectContaining({ stdio: 'inherit' }),
    );
  });

  it('prints up-to-date message and skips install when already on latest', async () => {
    fetchLatestVersion.mockResolvedValue(CURRENT_VERSION);

    await createProgram().parseAsync(['node', 'sfdt', 'update']);

    expect(execa).not.toHaveBeenCalled();
    expect(inquirer.prompt).not.toHaveBeenCalled();
    expect(print.success).toHaveBeenCalledWith(expect.stringContaining('up to date'));
  });

  it('aborts without installing when user declines confirmation', async () => {
    inquirer.prompt.mockResolvedValue({ confirm: false });

    await createProgram().parseAsync(['node', 'sfdt', 'update']);

    expect(execa).not.toHaveBeenCalled();
    expect(print.info).toHaveBeenCalledWith(expect.stringContaining('Cancelled'));
  });

  it('handles npm registry fetch failure gracefully', async () => {
    fetchLatestVersion.mockRejectedValue(new Error('ENOTFOUND'));

    await createProgram().parseAsync(['node', 'sfdt', 'update']);

    expect(print.error).toHaveBeenCalledWith(expect.stringContaining('ENOTFOUND'));
    expect(process.exitCode).toBe(1);
  });

  it('handles npm install failure gracefully', async () => {
    inquirer.prompt.mockResolvedValue({ confirm: true });
    execa.mockRejectedValue(new Error('npm ERR! permission denied'));

    await createProgram().parseAsync(['node', 'sfdt', 'update']);

    expect(print.error).toHaveBeenCalledWith(expect.stringContaining('permission denied'));
    expect(process.exitCode).toBe(1);
  });
});
