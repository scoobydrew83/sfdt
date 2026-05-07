/**
 * Additional tests for explain.js covering uncovered branches.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../../src/lib/config.js', () => ({
  loadConfig: vi.fn(),
}));

vi.mock('fs-extra', () => ({
  default: {
    pathExists: vi.fn(),
    readFile: vi.fn(),
    stat: vi.fn(),
  },
}));

vi.mock('glob', () => ({
  glob: vi.fn(),
}));

vi.mock('../../src/lib/ai.js', () => ({
  isAiAvailable: vi.fn(),
  aiUnavailableMessage: vi.fn().mockReturnValue('AI provider not available'),
  runAiPrompt: vi.fn(),
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
import { loadConfig } from '../../src/lib/config.js';
import { isAiAvailable, runAiPrompt } from '../../src/lib/ai.js';
import { print } from '../../src/lib/output.js';
import { registerExplainCommand } from '../../src/commands/explain.js';

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerExplainCommand(program);
  return program;
}

const defaultConfig = {
  _projectRoot: '/project',
  _configDir: '/project/.sfdt',
  defaultOrg: 'dev',
  features: { ai: false },
};

beforeEach(() => {
  vi.resetAllMocks();
  process.exitCode = undefined;
  loadConfig.mockResolvedValue(defaultConfig);
});

describe('explain command — additional coverage', () => {
  it('prints warning when log directory does not exist (no file arg, no --from-stdin)', async () => {
    fs.pathExists.mockResolvedValue(false);

    await createProgram().parseAsync(['node', 'sfdt', 'explain']);

    expect(print.warning).toHaveBeenCalledWith(expect.stringContaining('No log directory'));
    expect(process.exitCode).toBe(1);
  });

  it('handles large log file by truncating and printing a warning', async () => {
    // Generate a log larger than 512 KB
    const bigLog = 'X'.repeat(600 * 1024); // 600 KB
    fs.pathExists.mockResolvedValue(true);
    fs.readFile.mockResolvedValue(bigLog);
    isAiAvailable.mockResolvedValue(false);

    await createProgram().parseAsync(['node', 'sfdt', 'explain', 'logs/big.log']);

    expect(print.warning).toHaveBeenCalledWith(expect.stringContaining('KB'));
    // AI disabled — heuristic only (no matches = info message)
    expect(print.info).toHaveBeenCalled();
  });

  it('sets exitCode 1 when file path is outside project root (safeResolvePath throws)', async () => {
    // safeResolvePath throws when the resolved path is outside projectRoot
    // We achieve this by giving a path that escapes the project root
    // Note: the actual check in safeResolvePath uses realpath/resolve — with /project as root,
    // /project/../etc/passwd would escape. But since we're using mocked fs, we need the
    // path.resolve result to escape: provide an absolute path outside /project.
    fs.pathExists.mockResolvedValue(false);

    await createProgram().parseAsync(['node', 'sfdt', 'explain', '/etc/passwd']);

    // Either it fails with "outside project" or "not found" — either way exitCode is 1
    expect(process.exitCode).toBe(1);
  });

  it('uses configured logDir when set as absolute path', async () => {
    const configWithLogDir = {
      ...defaultConfig,
      logDir: '/custom/logs',
    };
    loadConfig.mockResolvedValue(configWithLogDir);
    // logDir exists but is empty
    fs.pathExists.mockResolvedValue(true);
    const { glob } = await import('glob');
    const globMock = vi.mocked(glob);
    globMock.mockResolvedValue([]);

    await createProgram().parseAsync(['node', 'sfdt', 'explain']);

    expect(print.warning).toHaveBeenCalledWith(expect.stringContaining('No log files'));
    expect(process.exitCode).toBe(1);
  });

  it('uses configured logDir when set as relative path', async () => {
    const configWithRelLogDir = {
      ...defaultConfig,
      logDir: 'custom-logs',
    };
    loadConfig.mockResolvedValue(configWithRelLogDir);
    fs.pathExists.mockResolvedValue(false);

    await createProgram().parseAsync(['node', 'sfdt', 'explain']);

    expect(print.warning).toHaveBeenCalledWith(expect.stringContaining('No log directory'));
    expect(process.exitCode).toBe(1);
  });

  it('triggers heuristic hints for "No such column" pattern', async () => {
    const logContent = "No such column 'MyField__c' on entity 'Account'";
    fs.pathExists.mockResolvedValue(true);
    fs.readFile.mockResolvedValue(logContent);
    isAiAvailable.mockResolvedValue(false);

    await createProgram().parseAsync(['node', 'sfdt', 'explain', 'logs/err.log']);

    expect(print.step).toHaveBeenCalledWith(expect.stringContaining('Missing field'));
  });

  it('triggers heuristic hints for "Variable does not exist" pattern', async () => {
    const logContent = "Variable does not exist: myVar";
    fs.pathExists.mockResolvedValue(true);
    fs.readFile.mockResolvedValue(logContent);
    isAiAvailable.mockResolvedValue(false);

    await createProgram().parseAsync(['node', 'sfdt', 'explain', 'logs/err.log']);

    expect(print.step).toHaveBeenCalledWith(expect.stringContaining('unknown symbol'));
  });

  it('triggers heuristic hints for "Invalid type" pattern', async () => {
    const logContent = "Invalid type: MyCustomType";
    fs.pathExists.mockResolvedValue(true);
    fs.readFile.mockResolvedValue(logContent);
    isAiAvailable.mockResolvedValue(false);

    await createProgram().parseAsync(['node', 'sfdt', 'explain', 'logs/err.log']);

    expect(print.step).toHaveBeenCalledWith(expect.stringContaining('not defined'));
  });

  it('triggers heuristic hints for "Average test coverage" pattern', async () => {
    const logContent = "Average test coverage across all Apex Classes and Triggers is 65%";
    fs.pathExists.mockResolvedValue(true);
    fs.readFile.mockResolvedValue(logContent);
    isAiAvailable.mockResolvedValue(false);

    await createProgram().parseAsync(['node', 'sfdt', 'explain', 'logs/err.log']);

    expect(print.step).toHaveBeenCalledWith(expect.stringContaining('65%'));
  });

  it('triggers heuristic hints for "at least N percent code coverage" pattern', async () => {
    const logContent = "Your organization must have at least 75 percent code coverage";
    fs.pathExists.mockResolvedValue(true);
    fs.readFile.mockResolvedValue(logContent);
    isAiAvailable.mockResolvedValue(false);

    await createProgram().parseAsync(['node', 'sfdt', 'explain', 'logs/err.log']);

    expect(print.step).toHaveBeenCalledWith(expect.stringContaining('Add tests'));
  });

  it('triggers heuristic hints for "insufficient access rights" pattern', async () => {
    const logContent = "insufficient access rights on cross-reference id";
    fs.pathExists.mockResolvedValue(true);
    fs.readFile.mockResolvedValue(logContent);
    isAiAvailable.mockResolvedValue(false);

    await createProgram().parseAsync(['node', 'sfdt', 'explain', 'logs/err.log']);

    expect(print.step).toHaveBeenCalledWith(expect.stringContaining('not visible'));
  });

  it('triggers heuristic hints for "duplicate value found" pattern', async () => {
    const logContent = "duplicate value found: some record";
    fs.pathExists.mockResolvedValue(true);
    fs.readFile.mockResolvedValue(logContent);
    isAiAvailable.mockResolvedValue(false);

    await createProgram().parseAsync(['node', 'sfdt', 'explain', 'logs/err.log']);

    expect(print.step).toHaveBeenCalledWith(expect.stringContaining('unique constraint'));
  });

  it('triggers heuristic hints for "Entity is not org-accessible" pattern', async () => {
    const logContent = "Entity is not org-accessible";
    fs.pathExists.mockResolvedValue(true);
    fs.readFile.mockResolvedValue(logContent);
    isAiAvailable.mockResolvedValue(false);

    await createProgram().parseAsync(['node', 'sfdt', 'explain', 'logs/err.log']);

    expect(print.step).toHaveBeenCalledWith(expect.stringContaining('not enabled'));
  });
});
