import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../../src/lib/config.js', () => ({
  loadConfig: vi.fn(),
}));

vi.mock('../../src/lib/script-runner.js', () => ({
  runScript: vi.fn(),
}));

vi.mock('../../src/lib/ai.js', () => ({
  isClaudeAvailable: vi.fn(),
  runAiPrompt: vi.fn(),
}));

vi.mock('inquirer', () => ({
  default: { prompt: vi.fn() },
}));

vi.mock('fs-extra', () => ({
  default: {
    ensureDir: vi.fn(),
    pathExists: vi.fn().mockResolvedValue(false),
  },
}));

vi.mock('execa', () => ({
  execa: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '' }),
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
import { runScript } from '../../src/lib/script-runner.js';
import { isClaudeAvailable, runAiPrompt } from '../../src/lib/ai.js';
import inquirer from 'inquirer';
import { execa } from 'execa';
import { print } from '../../src/lib/output.js';
import { registerReleaseCommand } from '../../src/commands/release.js';

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerReleaseCommand(program);
  return program;
}

// Helper: mock prompt responses for the full git workflow
// generateNotes prompt (if AI available), then doCommit, doTag, proceedToDeploy, doPush
function mockPromptFlow({
  generateNotes,
  doCommit = false,
  doTag = false,
  proceedToDeploy = false,
  doPush = false,
} = {}) {
  const responses = [];
  if (generateNotes !== undefined) {
    responses.push({ generateNotes });
  }
  responses.push({ doCommit });
  if (doCommit) {
    responses.push({ doTag });
    responses.push({ proceedToDeploy });
    if (doTag) {
      responses.push({ doPush });
    }
  }
  let mock = inquirer.prompt;
  for (const response of responses) {
    mock = mock.mockResolvedValueOnce(response);
  }
}

beforeEach(() => {
  vi.resetAllMocks();
  process.exitCode = undefined;
  // Default: script returns version on stdout, git status returns no staged files
  runScript.mockResolvedValue({ exitCode: 0, stdout: '1.0.0' });
  execa.mockResolvedValue({ exitCode: 0, stdout: '' });
  loadConfig.mockResolvedValue({
    _projectRoot: '/project',
    defaultOrg: 'dev',
    features: { ai: true },
  });
});

describe('release command', () => {
  it('runs generate-release-manifest.sh with captureStdout', async () => {
    isClaudeAvailable.mockResolvedValue(false);
    mockPromptFlow();

    await createProgram().parseAsync(['node', 'sfdt', 'release']);

    expect(runScript).toHaveBeenCalledWith(
      'core/generate-release-manifest.sh',
      expect.any(Object),
      expect.objectContaining({ args: [], cwd: '/project', captureStdout: true }),
    );
  });

  it('passes version argument to script', async () => {
    isClaudeAvailable.mockResolvedValue(false);
    mockPromptFlow();

    await createProgram().parseAsync(['node', 'sfdt', 'release', '2.0.0']);

    expect(runScript).toHaveBeenCalledWith(
      'core/generate-release-manifest.sh',
      expect.any(Object),
      expect.objectContaining({ args: ['2.0.0'] }),
    );
  });

  it('offers AI release notes when AI available', async () => {
    isClaudeAvailable.mockResolvedValue(true);
    runAiPrompt.mockResolvedValue({ stdout: 'notes', exitCode: 0 });
    mockPromptFlow({ generateNotes: true });

    await createProgram().parseAsync(['node', 'sfdt', 'release', '1.0.0']);

    expect(runAiPrompt).toHaveBeenCalledWith(
      expect.stringContaining('release notes'),
      expect.objectContaining({ aiEnabled: true, interactive: true }),
    );
  });

  it('skips AI notes when user declines', async () => {
    isClaudeAvailable.mockResolvedValue(true);
    mockPromptFlow({ generateNotes: false });

    await createProgram().parseAsync(['node', 'sfdt', 'release']);

    expect(runAiPrompt).not.toHaveBeenCalled();
  });

  it('sets exitCode 1 on failure', async () => {
    runScript.mockRejectedValue(new Error('release failed'));

    await createProgram().parseAsync(['node', 'sfdt', 'release']);

    expect(print.error).toHaveBeenCalledWith(expect.stringContaining('release failed'));
    expect(process.exitCode).toBe(1);
  });

  it('stages release notes and CHANGELOG in git workflow', async () => {
    const fse = (await import('fs-extra')).default;
    fse.pathExists.mockResolvedValue(true); // release notes file exists
    isClaudeAvailable.mockResolvedValue(false);
    // CHANGELOG has changes (exitCode 1 = diff detected)
    execa
      .mockResolvedValueOnce({ exitCode: 0, stdout: '' }) // git add manifests
      .mockResolvedValueOnce({ exitCode: 1, stdout: '' }) // git diff CHANGELOG (modified)
      .mockResolvedValueOnce({ exitCode: 0, stdout: '' }) // git add CHANGELOG
      .mockResolvedValueOnce({ exitCode: 0, stdout: '' }) // git add release notes
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout:
          'A  release-notes/rl-1.0.0-RELEASE-NOTES.md\nA  manifest/release/rl-1.0.0-package.xml\nM  CHANGELOG.md',
      }); // git status

    mockPromptFlow({ doCommit: true, doTag: false });

    await createProgram().parseAsync(['node', 'sfdt', 'release', '1.0.0']);

    // Verify CHANGELOG was staged
    const addCalls = execa.mock.calls.filter(
      (c) => c[0] === 'git' && c[1][0] === 'add' && c[1].includes('CHANGELOG.md'),
    );
    expect(addCalls.length).toBe(1);
  });

  it('asks about deployment before push', async () => {
    isClaudeAvailable.mockResolvedValue(false);
    // git status shows staged files
    execa.mockImplementation((cmd, args) => {
      if (cmd === 'git' && args[0] === 'status') {
        return Promise.resolve({ exitCode: 0, stdout: 'A  manifest/release/rl-1.0.0-package.xml' });
      }
      return Promise.resolve({ exitCode: 0, stdout: '' });
    });

    mockPromptFlow({ doCommit: true, doTag: true, proceedToDeploy: false, doPush: false });

    await createProgram().parseAsync(['node', 'sfdt', 'release', '1.0.0']);

    // Verify prompt order: doCommit, doTag, proceedToDeploy, doPush
    const promptCalls = inquirer.prompt.mock.calls;
    const promptMessages = promptCalls.map((c) => c[0][0].message);
    const deployIdx = promptMessages.indexOf('Proceed to deployment?');
    const pushIdx = promptMessages.findIndex((m) => m && m.includes('Push tag'));
    expect(deployIdx).toBeLessThan(pushIdx);
  });
});
