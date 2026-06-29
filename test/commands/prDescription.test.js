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
  isAiAvailable: vi.fn(), aiUnavailableMessage: vi.fn().mockReturnValue("AI provider not available"),
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
import { isAiAvailable, aiUnavailableMessage, runAiPrompt } from '../../src/lib/ai.js';
import { print } from '../../src/lib/output.js';
import { registerPrDescriptionCommand } from '../../src/commands/prDescription.js';

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerPrDescriptionCommand(program);
  return program;
}

// Dispatch git invocations by subcommand so tests are independent of call
// order. collectDiffContext now calls `git merge-base` (resolveBaseRef) before
// `git log` and `git diff`.
function mockGit({ log = '', diff = '' } = {}) {
  execa.mockImplementation((_cmd, args) => {
    const sub = args?.[0];
    if (sub === 'merge-base') return Promise.resolve({ exitCode: 0, stdout: 'base000sha', stderr: '' });
    if (sub === 'log') return Promise.resolve({ exitCode: 0, stdout: log, stderr: '' });
    if (sub === 'diff') return Promise.resolve({ exitCode: 0, stdout: diff, stderr: '' });
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  });
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
  aiUnavailableMessage.mockReturnValue('AI provider not available');
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

  it('errors when AI provider not available', async () => {
    isAiAvailable.mockResolvedValue(false);

    await createProgram().parseAsync(['node', 'sfdt', 'pr-description']);

    expect(print.error).toHaveBeenCalledWith(expect.stringContaining('not available'));
    expect(process.exitCode).toBe(1);
  });

  it('generates github-format description and prints to stdout', async () => {
    isAiAvailable.mockResolvedValue(true);
    mockGit({
      log: 'abc1234 Add AccountHelper',
      diff: 'A\tforce-app/main/default/classes/AccountHelper.cls',
    });

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
    isAiAvailable.mockResolvedValue(true);
    mockGit({ log: 'abc1234 Commit msg', diff: 'A\tforce-app/main/default/classes/Foo.cls' });

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
    isAiAvailable.mockResolvedValue(true);
    mockGit({ log: 'abc1234 Commit', diff: 'A\tforce-app/main/default/classes/Foo.cls' });

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
      expect.stringContaining('Slack deployment announcement'),
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
    isAiAvailable.mockResolvedValue(true);
    mockGit({ log: '', diff: '' }); // no commits, no diff

    await createProgram().parseAsync(['node', 'sfdt', 'pr-description']);

    expect(print.warning).toHaveBeenCalledWith(expect.stringContaining('No commits'));
  });

  it('handles AI returning empty output', async () => {
    isAiAvailable.mockResolvedValue(true);
    mockGit({ log: 'abc1234 Commit', diff: 'A\tforce-app/main/default/classes/Foo.cls' });
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

  it('rejects an unsafe git ref before loading config', async () => {
    await createProgram().parseAsync([
      'node',
      'sfdt',
      'pr-description',
      '--base',
      '--evil',
    ]);

    expect(print.error).toHaveBeenCalledWith(expect.stringContaining('Invalid git ref'));
    expect(process.exitCode).toBe(1);
    expect(loadConfig).not.toHaveBeenCalled();
  });

  it('errors when AI response has a non-zero exit code', async () => {
    isAiAvailable.mockResolvedValue(true);
    mockGit({ log: 'abc1234 Commit', diff: 'A\tforce-app/main/default/classes/Foo.cls' });
    runAiPrompt.mockResolvedValue({ stdout: 'partial', exitCode: 2 });

    await createProgram().parseAsync(['node', 'sfdt', 'pr-description']);

    expect(print.error).toHaveBeenCalledWith(expect.stringContaining('AI call failed'));
    expect(process.exitCode).toBe(1);
  });

  it('errors when AI returns a null response', async () => {
    isAiAvailable.mockResolvedValue(true);
    mockGit({ log: 'abc1234 Commit', diff: 'A\tforce-app/main/default/classes/Foo.cls' });
    runAiPrompt.mockResolvedValue(null);

    await createProgram().parseAsync(['node', 'sfdt', 'pr-description']);

    expect(print.error).toHaveBeenCalledWith(expect.stringContaining('AI call failed'));
    expect(process.exitCode).toBe(1);
  });

  it('formats destructive changes and truncates large member lists in the prompt', async () => {
    isAiAvailable.mockResolvedValue(true);
    // 12 additive classes (>10 triggers the "...N more" suffix) plus a deletion.
    const added = Array.from({ length: 12 }, (_, i) =>
      `A\tforce-app/main/default/classes/Cls${i}.cls`,
    );
    const removed = 'D\tforce-app/main/default/classes/OldThing.cls';
    mockGit({
      log: 'abc1234 Big change',
      diff: [...added, removed].join('\n'),
    });
    runAiPrompt.mockResolvedValue({ stdout: '## Summary', exitCode: 0 });

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'pr-description']);

    const prompt = runAiPrompt.mock.calls[0][0];
    expect(prompt).toContain('Additive:');
    expect(prompt).toContain('Destructive:');
    expect(prompt).toContain('OldThing');
    expect(prompt).toContain('more'); // "...N more" suffix for the 12 additive classes
    spy.mockRestore();
  });

  it('uses the working-tree-only note when metadata changed but no commits exist', async () => {
    isAiAvailable.mockResolvedValue(true);
    // No commits, but a staged metadata change → hasChanges via addCount.
    mockGit({ log: '', diff: 'A\tforce-app/main/default/classes/Foo.cls' });
    runAiPrompt.mockResolvedValue({ stdout: '## Summary', exitCode: 0 });

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // Non-numeric --commit-limit exercises the parseInt fallback (default 30).
    await createProgram().parseAsync([
      'node', 'sfdt', 'pr-description', '--commit-limit', 'abc',
    ]);

    const prompt = runAiPrompt.mock.calls[0][0];
    expect(prompt).toContain('no commits');
    spy.mockRestore();
  });

  it('emits a no-metadata placeholder when only commits changed', async () => {
    isAiAvailable.mockResolvedValue(true);
    // Commits exist (hasChanges) but the diff touches no source metadata.
    mockGit({ log: 'abc1234 Docs only', diff: '' });
    runAiPrompt.mockResolvedValue({ stdout: '## Summary', exitCode: 0 });

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'pr-description']);

    const prompt = runAiPrompt.mock.calls[0][0];
    expect(prompt).toContain('no metadata changes detected');
    spy.mockRestore();
  });
});
