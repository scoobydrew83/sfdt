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
    pathExists: vi.fn(),
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
import { registerManifestCommand } from '../../src/commands/manifest.js';

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerManifestCommand(program);
  return program;
}

const defaultConfig = {
  _projectRoot: '/project',
  defaultOrg: 'dev',
  defaultSourcePath: 'force-app/main/default',
  sourceApiVersion: '63.0',
  manifestDir: 'manifest/release',
  features: { ai: false },
};

beforeEach(() => {
  vi.resetAllMocks();
  process.exitCode = undefined;
  loadConfig.mockResolvedValue(defaultConfig);
  fs.ensureDir.mockResolvedValue();
  fs.writeFile.mockResolvedValue();
});

describe('manifest command', () => {
  it('generates package.xml from git diff', async () => {
    const diffOutput = [
      'A\tforce-app/main/default/classes/AccountHelper.cls',
      'A\tforce-app/main/default/classes/AccountHelper.cls-meta.xml',
    ].join('\n');

    execa
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'abc1234' }) // merge-base
      .mockResolvedValueOnce({ exitCode: 0, stdout: diffOutput }); // git diff

    await createProgram().parseAsync(['node', 'sfdt', 'manifest']);

    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('preview-package.xml'),
      expect.stringContaining('<name>ApexClass</name>'),
    );
    expect(print.success).toHaveBeenCalledWith(
      expect.stringContaining('preview-package.xml'),
    );
  });

  it('warns when no metadata changes detected', async () => {
    execa
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'abc1234' }) // merge-base
      .mockResolvedValueOnce({ exitCode: 0, stdout: '' }); // empty diff

    await createProgram().parseAsync(['node', 'sfdt', 'manifest']);

    expect(print.warning).toHaveBeenCalledWith(
      expect.stringContaining('No metadata changes'),
    );
  });

  it('prints package.xml to stdout with --print', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const diffOutput = 'A\tforce-app/main/default/classes/Foo.cls';

    execa
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'abc1234' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: diffOutput });

    await createProgram().parseAsync(['node', 'sfdt', 'manifest', '--print']);

    expect(spy).toHaveBeenCalledWith(expect.stringContaining('<name>ApexClass</name>'));
    expect(fs.writeFile).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('reports git diff failure', async () => {
    execa
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'abc1234' })
      .mockResolvedValueOnce({ exitCode: 128, stderr: 'bad ref', stdout: '' });

    await createProgram().parseAsync(['node', 'sfdt', 'manifest']);

    expect(print.error).toHaveBeenCalledWith(expect.stringContaining('git diff failed'));
    expect(process.exitCode).toBe(1);
  });

  it('writes destructive changes when --destructive is given', async () => {
    const diffOutput = [
      'D\tforce-app/main/default/classes/Deleted.cls',
      'D\tforce-app/main/default/classes/Deleted.cls-meta.xml',
    ].join('\n');

    execa
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'abc1234' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: diffOutput });

    await createProgram().parseAsync([
      'node',
      'sfdt',
      'manifest',
      '--destructive',
      'manifest/destructive.xml',
    ]);

    // The additive manifest should be written too (even if empty),
    // but the destructive one is what we test here.
    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('destructive.xml'),
      expect.stringContaining('<name>ApexClass</name>'),
    );
  });

  it('runs AI cleanup when AI is enabled and --ai-cleanup is set', async () => {
    const aiConfig = { ...defaultConfig, features: { ai: true } };
    loadConfig.mockResolvedValue(aiConfig);
    isAiAvailable.mockResolvedValue(true);

    const diffOutput = 'A\tforce-app/main/default/classes/Foo.cls';
    execa
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'abc1234' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: diffOutput });

    await createProgram().parseAsync(['node', 'sfdt', 'manifest', '--ai-cleanup']);

    expect(runAiPrompt).toHaveBeenCalledWith(
      expect.stringContaining('DRAFT MANIFEST'),
      expect.objectContaining({ interactive: true }),
    );
  });

  it('sets exitCode 1 on failure', async () => {
    loadConfig.mockRejectedValue(new Error('no config'));

    await createProgram().parseAsync(['node', 'sfdt', 'manifest']);

    expect(print.error).toHaveBeenCalledWith(expect.stringContaining('no config'));
    expect(process.exitCode).toBe(1);
  });
});
