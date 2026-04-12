import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../../src/lib/config.js', () => ({
  loadConfig: vi.fn(),
}));

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

vi.mock('fs-extra', () => ({
  default: {
    ensureDir: vi.fn(),
    writeFile: vi.fn(),
  },
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

import { execa } from 'execa';
import fs from 'fs-extra';
import { loadConfig } from '../../src/lib/config.js';
import { isClaudeAvailable, runAiPrompt } from '../../src/lib/ai.js';
import { print } from '../../src/lib/output.js';
import { registerPrDescriptionCommand } from '../../src/commands/prDescription.js';

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerPrDescriptionCommand(program);
  return program;
}

const defaultConfig = {
  _projectRoot: '/project',
  defaultOrg: 'dev',
  defaultSourcePath: 'force-app/main/default',
  features: { ai: true },
};

beforeEach(() => {
  vi.resetAllMocks();
  process.exitCode = undefined;
  loadConfig.mockResolvedValue(defaultConfig);
  fs.ensureDir.mockResolvedValue();
  fs.writeFile.mockResolvedValue();
});

describe('pr-description command', () => {
  it('errors when AI features disabled', async () => {
    loadConfig.mockResolvedValue({
      _projectRoot: '/project',
      features: { ai: false },
    });

    await createProgram().parseAsync(['node', 'sfdt', 'pr-description']);

    expect(print.error).toHaveBeenCalledWith(expect.stringContaining('AI features are disabled'));
    expect(process.exitCode).toBe(1);
  });

  it('errors when Claude CLI not available', async () => {
    isClaudeAvailable.mockResolvedValue(false);

    await createProgram().parseAsync(['node', 'sfdt', 'pr-description']);

    expect(print.error).toHaveBeenCalledWith(
      expect.stringContaining('Claude CLI is not installed'),
    );
    expect(process.exitCode).toBe(1);
  });

  it('generates github-format description and prints to stdout', async () => {
    isClaudeAvailable.mockResolvedValue(true);
    execa
      .mockResolvedValueOnce({ stdout: 'abc1234 Add AccountHelper' }) // git log
      .mockResolvedValueOnce({
        stdout: 'A\tforce-app/main/default/classes/AccountHelper.cls',
      }); // git diff

    runAiPrompt.mockResolvedValue({
      stdout: '## Summary\nAdded AccountHelper class.',
      exitCode: 0,
    });

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await createProgram().parseAsync(['node', 'sfdt', 'pr-description']);

    expect(runAiPrompt).toHaveBeenCalledWith(
      expect.stringContaining('pull request description'),
      expect.objectContaining({ interactive: false }),
    );

    expect(spy).toHaveBeenCalledWith(expect.stringContaining('AccountHelper'));
    spy.mockRestore();
  });

  it('writes output to file with --output', async () => {
    isClaudeAvailable.mockResolvedValue(true);
    execa
      .mockResolvedValueOnce({ stdout: 'abc1234 Commit msg' })
      .mockResolvedValueOnce({ stdout: 'A\tforce-app/main/default/classes/Foo.cls' });

    runAiPrompt.mockResolvedValue({ stdout: '## Summary\nPR body', exitCode: 0 });

    await createProgram().parseAsync([
      'node',
      'sfdt',
      'pr-description',
      '--output',
      'pr-body.md',
    ]);

    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('pr-body.md'),
      expect.stringContaining('## Summary'),
    );
    expect(print.success).toHaveBeenCalled();
  });

  it('supports slack format', async () => {
    isClaudeAvailable.mockResolvedValue(true);
    execa
      .mockResolvedValueOnce({ stdout: 'abc1234 Commit' })
      .mockResolvedValueOnce({ stdout: 'A\tforce-app/main/default/classes/Foo.cls' });

    runAiPrompt.mockResolvedValue({
      stdout: ':rocket: *feature/new* is ready for deploy',
      exitCode: 0,
    });

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await createProgram().parseAsync([
      'node',
      'sfdt',
      'pr-description',
      '--format',
      'slack',
    ]);

    // Prompt should use Slack-specific template
    expect(runAiPrompt).toHaveBeenCalledWith(
      expect.stringContaining('Slack announcement'),
      expect.any(Object),
    );

    spy.mockRestore();
  });

  it('rejects unknown format', async () => {
    await createProgram().parseAsync([
      'node',
      'sfdt',
      'pr-description',
      '--format',
      'xml',
    ]);

    expect(print.error).toHaveBeenCalledWith(expect.stringContaining('Unknown format'));
    expect(process.exitCode).toBe(1);
  });

  it('warns when no changes between refs', async () => {
    isClaudeAvailable.mockResolvedValue(true);
    execa
      .mockResolvedValueOnce({ stdout: '' }) // no commits
      .mockResolvedValueOnce({ stdout: '' }); // no diff

    await createProgram().parseAsync(['node', 'sfdt', 'pr-description']);

    expect(print.warning).toHaveBeenCalledWith(expect.stringContaining('No commits'));
  });

  it('handles AI returning empty output', async () => {
    isClaudeAvailable.mockResolvedValue(true);
    execa
      .mockResolvedValueOnce({ stdout: 'abc1234 Commit' })
      .mockResolvedValueOnce({ stdout: 'A\tforce-app/main/default/classes/Foo.cls' });
    runAiPrompt.mockResolvedValue({ stdout: '', exitCode: 0 });

    await createProgram().parseAsync(['node', 'sfdt', 'pr-description']);

    expect(print.error).toHaveBeenCalledWith(expect.stringContaining('empty output'));
    expect(process.exitCode).toBe(1);
  });

  it('sets exitCode 1 on failure', async () => {
    loadConfig.mockRejectedValue(new Error('no config'));

    await createProgram().parseAsync(['node', 'sfdt', 'pr-description']);

    expect(print.error).toHaveBeenCalledWith(expect.stringContaining('no config'));
    expect(process.exitCode).toBe(1);
  });
});
