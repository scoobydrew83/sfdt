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
    pathExists: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    appendFile: vi.fn(),
  },
}));

vi.mock('inquirer', () => ({
  default: { prompt: vi.fn() },
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

import { loadConfig } from '../../src/lib/config.js';
import { execa } from 'execa';
import fs from 'fs-extra';
import inquirer from 'inquirer';
import { isClaudeAvailable, runAiPrompt } from '../../src/lib/ai.js';
import { print } from '../../src/lib/output.js';
import { registerChangelogCommand } from '../../src/commands/changelog.js';

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerChangelogCommand(program);
  return program;
}

beforeEach(() => {
  vi.resetAllMocks();
  process.exitCode = undefined;
  loadConfig.mockResolvedValue({
    _projectRoot: '/project',
    defaultOrg: 'dev',
    features: { ai: true },
  });
});

describe('changelog release command', () => {
  it('calls bash with version passed as SFDT_VERSION env var', async () => {
    execa.mockResolvedValue({ stdout: '', exitCode: 0 });

    await createProgram().parseAsync(['node', 'sfdt', 'changelog', 'release', '1.2.3']);

    expect(execa).toHaveBeenCalledWith(
      'bash',
      [
        '-c',
        'source "$1" && move_unreleased_to_version "$SFDT_VERSION"',
        'bash',
        expect.stringContaining('changelog-utils.sh'),
      ],
      expect.objectContaining({
        env: expect.objectContaining({ SFDT_VERSION: '1.2.3' }),
      }),
    );
    expect(print.success).toHaveBeenCalled();
  });

  it('does not interpolate version into the script body', async () => {
    const maliciousVersion = '1.0"; rm -rf /; echo "';
    execa.mockResolvedValue({ stdout: '', exitCode: 0 });

    await createProgram().parseAsync(['node', 'sfdt', 'changelog', 'release', maliciousVersion]);

    const [, args] = execa.mock.calls[0];
    const scriptBody = args[1];
    // The script body must NOT contain the raw version string
    expect(scriptBody).not.toContain(maliciousVersion);
    // It must reference the env var instead
    expect(scriptBody).toContain('$SFDT_VERSION');
    // Path is safely in args, not the script body
    expect(args[3]).toContain('changelog-utils.sh');
    // The version is safely in env
    const options = execa.mock.calls[0][2];
    expect(options.env.SFDT_VERSION).toBe(maliciousVersion);
  });

  it('sets exitCode 1 on failure', async () => {
    execa.mockRejectedValue(new Error('script failed'));

    await createProgram().parseAsync(['node', 'sfdt', 'changelog', 'release', '1.0.0']);

    expect(print.error).toHaveBeenCalledWith(expect.stringContaining('script failed'));
    expect(process.exitCode).toBe(1);
  });
});

describe('changelog check command', () => {
  it('reports when git has changes but changelog is empty', async () => {
    execa
      .mockResolvedValueOnce({ stdout: 'M src/file.js' }) // git status
      .mockResolvedValueOnce({ stdout: 'EMPTY' }); // has_unreleased_content

    await createProgram().parseAsync(['node', 'sfdt', 'changelog', 'check']);

    expect(print.warning).toHaveBeenCalledWith(
      expect.stringContaining('[Unreleased] section in CHANGELOG.md is empty'),
    );
    expect(process.exitCode).toBe(1);
  });

  it('reports success when git has changes and changelog has content', async () => {
    execa
      .mockResolvedValueOnce({ stdout: 'M src/file.js' }) // git status
      .mockResolvedValueOnce({ stdout: 'HAS_CONTENT' }); // has_unreleased_content

    await createProgram().parseAsync(['node', 'sfdt', 'changelog', 'check']);

    expect(print.success).toHaveBeenCalledWith(expect.stringContaining('synced'));
  });

  it('reports no changes when git is clean and changelog is empty', async () => {
    execa
      .mockResolvedValueOnce({ stdout: '' }) // git status
      .mockResolvedValueOnce({ stdout: 'EMPTY' }); // has_unreleased_content

    await createProgram().parseAsync(['node', 'sfdt', 'changelog', 'check']);

    expect(print.info).toHaveBeenCalledWith(expect.stringContaining('No changes'));
  });

  it('sets exitCode 1 on failure', async () => {
    execa.mockRejectedValue(new Error('check failed'));

    await createProgram().parseAsync(['node', 'sfdt', 'changelog', 'check']);

    expect(print.error).toHaveBeenCalledWith(expect.stringContaining('check failed'));
    expect(process.exitCode).toBe(1);
  });
});

describe('changelog generate command', () => {
  it('errors when AI is disabled', async () => {
    loadConfig.mockResolvedValue({
      _projectRoot: '/project',
      features: { ai: false },
    });
    fs.pathExists.mockResolvedValue(true);
    isClaudeAvailable.mockResolvedValue(false);

    await createProgram().parseAsync(['node', 'sfdt', 'changelog', 'generate']);

    expect(print.error).toHaveBeenCalledWith(expect.stringContaining('AI features are disabled'));
    expect(runAiPrompt).not.toHaveBeenCalled();
  });

  it('offers to create CHANGELOG.md when missing', async () => {
    fs.pathExists.mockResolvedValue(false);
    inquirer.prompt.mockResolvedValueOnce({ create: false });

    await createProgram().parseAsync(['node', 'sfdt', 'changelog', 'generate']);

    expect(inquirer.prompt).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ name: 'create' })]),
    );
    // User declined, so no AI call
    expect(runAiPrompt).not.toHaveBeenCalled();
  });

  it('appends AI response to [Unreleased] section when user approves', async () => {
    fs.pathExists.mockResolvedValue(true);
    isClaudeAvailable.mockResolvedValue(true);
    runAiPrompt.mockResolvedValue('### Added\n- New feature');
    inquirer.prompt.mockResolvedValueOnce({ apply: true });
    fs.readFile.mockResolvedValue('# Changelog\n\n## [Unreleased]\n\n## [1.0.0]\n');
    fs.writeFile.mockResolvedValue();

    await createProgram().parseAsync(['node', 'sfdt', 'changelog', 'generate']);

    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('CHANGELOG.md'),
      expect.stringContaining('### Added\n- New feature'),
    );
    expect(print.success).toHaveBeenCalledWith('Updated CHANGELOG.md');
  });

  it('sets exitCode 1 on failure', async () => {
    loadConfig.mockRejectedValue(new Error('no config'));

    await createProgram().parseAsync(['node', 'sfdt', 'changelog', 'generate']);

    expect(print.error).toHaveBeenCalledWith(expect.stringContaining('no config'));
    expect(process.exitCode).toBe(1);
  });
});
