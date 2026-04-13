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
  isClaudeAvailable: vi.fn(),
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
import { glob } from 'glob';
import { loadConfig } from '../../src/lib/config.js';
import { isClaudeAvailable, runAiPrompt } from '../../src/lib/ai.js';
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
  defaultOrg: 'dev',
  features: { ai: true },
};

beforeEach(() => {
  vi.resetAllMocks();
  process.exitCode = undefined;
  loadConfig.mockResolvedValue(defaultConfig);
});

describe('explain command', () => {
  it('reads an explicit log file and runs AI analysis', async () => {
    fs.pathExists.mockResolvedValue(true);
    fs.readFile.mockResolvedValue(
      "Error: No such column 'MissingField__c' on entity 'Account'\nDEPLOYMENT FAILED",
    );
    isClaudeAvailable.mockResolvedValue(true);
    runAiPrompt.mockResolvedValue({ stdout: 'analysis', exitCode: 0 });

    await createProgram().parseAsync(['node', 'sfdt', 'explain', 'logs/deploy.log']);

    // Should call AI with the log content
    expect(runAiPrompt).toHaveBeenCalledWith(
      expect.stringContaining('DEPLOYMENT LOG'),
      expect.objectContaining({ interactive: true }),
    );
  });

  it('prints heuristic matches when AI is disabled', async () => {
    loadConfig.mockResolvedValue({ ...defaultConfig, features: { ai: false } });
    fs.pathExists.mockResolvedValue(true);
    fs.readFile.mockResolvedValue(
      "Error: No such column 'Custom__c' on entity 'Account'\n",
    );

    await createProgram().parseAsync(['node', 'sfdt', 'explain', 'logs/deploy.log']);

    expect(print.step).toHaveBeenCalledWith(expect.stringContaining('Missing field Custom__c'));
    expect(runAiPrompt).not.toHaveBeenCalled();
  });

  it('reports info when Claude CLI is not available', async () => {
    fs.pathExists.mockResolvedValue(true);
    fs.readFile.mockResolvedValue('Some error log content');
    isClaudeAvailable.mockResolvedValue(false);

    await createProgram().parseAsync(['node', 'sfdt', 'explain', 'logs/deploy.log']);

    expect(print.info).toHaveBeenCalledWith(expect.stringContaining('Claude CLI is not installed'));
    expect(runAiPrompt).not.toHaveBeenCalled();
  });

  it('errors when file is not found', async () => {
    fs.pathExists.mockResolvedValue(false);

    await createProgram().parseAsync(['node', 'sfdt', 'explain', 'nonexistent.log']);

    expect(print.error).toHaveBeenCalledWith(expect.stringContaining('Log file not found'));
    expect(process.exitCode).toBe(1);
  });

  it('finds latest log when no file arg is given', async () => {
    // First pathExists: log directory exists
    // Second pathExists in resolveLogContent for logDir
    fs.pathExists.mockResolvedValue(true);
    glob.mockResolvedValue(['/project/logs/old.log', '/project/logs/new.log']);
    fs.stat
      .mockResolvedValueOnce({ mtimeMs: 1000 }) // old.log
      .mockResolvedValueOnce({ mtimeMs: 2000 }); // new.log
    fs.readFile.mockResolvedValue('Latest log content');
    isClaudeAvailable.mockResolvedValue(true);
    runAiPrompt.mockResolvedValue({ stdout: 'result', exitCode: 0 });

    await createProgram().parseAsync(['node', 'sfdt', 'explain', '--latest']);

    expect(print.info).toHaveBeenCalledWith(expect.stringContaining('latest log'));
    expect(runAiPrompt).toHaveBeenCalled();
  });

  it('warns when log directory has no files', async () => {
    fs.pathExists.mockResolvedValue(true);
    glob.mockResolvedValue([]);

    await createProgram().parseAsync(['node', 'sfdt', 'explain']);

    expect(print.warning).toHaveBeenCalledWith(expect.stringContaining('No log files'));
    expect(process.exitCode).toBe(1);
  });

  it('sets exitCode 1 on failure', async () => {
    loadConfig.mockRejectedValue(new Error('no config'));

    await createProgram().parseAsync(['node', 'sfdt', 'explain', 'file.log']);

    expect(print.error).toHaveBeenCalledWith(expect.stringContaining('no config'));
    expect(process.exitCode).toBe(1);
  });
});
