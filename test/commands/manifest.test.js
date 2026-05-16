import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import path from 'path';
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
import { isAiAvailable, runAiPrompt } from '../../src/lib/ai.js';
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
const multiPkgConfig = {
  ...defaultConfig,
  packageDirectories: [
    { name: 'core', path: 'force-app/main/default' },
    { name: 'marketing', path: 'force-app/marketing' },
  ],
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
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'abc1234' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: diffOutput });
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
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'abc1234' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '' });
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
    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('destructive.xml'),
      expect.stringContaining('<name>ApexClass</name>'),
    );
  });
  it('warns about destructive components when deletions found but --destructive not given', async () => {
    const diffOutput = 'D\tforce-app/main/default/classes/OldClass.cls\nD\tforce-app/main/default/classes/OldClass.cls-meta.xml';
    execa
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'abc1234' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: diffOutput });
    await createProgram().parseAsync(['node', 'sfdt', 'manifest']);
    expect(print.warning).toHaveBeenCalledWith(
      expect.stringContaining('destructive components detected'),
    );
  });
  it('reports AI disabled when --ai-cleanup is set but features.ai is false', async () => {
    const diffOutput = 'A\tforce-app/main/default/classes/Foo.cls';
    execa
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'abc1234' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: diffOutput });
    await createProgram().parseAsync(['node', 'sfdt', 'manifest', '--ai-cleanup']);
    expect(print.info).toHaveBeenCalledWith(
      expect.stringContaining('AI features are disabled'),
    );
  });
  it('reports AI unavailable when features.ai is true but provider not available', async () => {
    const aiConfig = { ...defaultConfig, features: { ai: true } };
    loadConfig.mockResolvedValue(aiConfig);
    isAiAvailable.mockResolvedValue(false);
    const diffOutput = 'A\tforce-app/main/default/classes/Foo.cls';
    execa
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'abc1234' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: diffOutput });
    await createProgram().parseAsync(['node', 'sfdt', 'manifest', '--ai-cleanup']);
    expect(print.info).toHaveBeenCalledWith(
      expect.stringContaining('AI provider not available'),
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
  it('uses release name in filename when --name is given', async () => {
    const diffOutput = 'A\tforce-app/main/default/classes/AccountHelper.cls';
    execa
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'abc1234' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: diffOutput });
    await createProgram().parseAsync(['node', 'sfdt', 'manifest', '--name', '1.2.3']);
    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('rl-1.2.3-package.xml'),
      expect.any(String),
    );
  });
  it('uses release name from --version alias', async () => {
    const diffOutput = 'A\tforce-app/main/default/classes/AccountHelper.cls';
    execa
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'abc1234' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: diffOutput });
    await createProgram().parseAsync(['node', 'sfdt', 'manifest', '--version', 'sprint-42']);
    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('rl-sprint-42-package.xml'),
      expect.any(String),
    );
  });
  it('resolves "today" to current ISO date in --name', async () => {
    const diffOutput = 'A\tforce-app/main/default/classes/AccountHelper.cls';
    execa
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'abc1234' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: diffOutput });
    const today = new Date().toISOString().slice(0, 10);
    await createProgram().parseAsync(['node', 'sfdt', 'manifest', '--name', 'today']);
    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining(`rl-${today}-package.xml`),
      expect.any(String),
    );
  });
  it('diffs only the specified package when --package is given', async () => {
    loadConfig.mockResolvedValue(multiPkgConfig);
    const diffOutput = 'A\tforce-app/marketing/classes/LeadHelper.cls';
    execa
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'abc1234' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: diffOutput });
    await createProgram().parseAsync(['node', 'sfdt', 'manifest', '--package', 'marketing']);
    const diffCall = execa.mock.calls.find((c) => c[1]?.includes('--name-status'));
    expect(diffCall[1]).toContain('force-app/marketing/');
    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('preview-package.xml'),
      expect.any(String),
    );
  });
  it('includes package name in filename when --package and --name are both given', async () => {
    loadConfig.mockResolvedValue(multiPkgConfig);
    const diffOutput = 'A\tforce-app/marketing/classes/LeadHelper.cls';
    execa
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'abc1234' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: diffOutput });
    await createProgram().parseAsync([
      'node', 'sfdt', 'manifest', '--package', 'marketing', '--name', '2.0.0',
    ]);
    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('rl-2.0.0-marketing-package.xml'),
      expect.any(String),
    );
  });
  it('errors when --package names an unknown package', async () => {
    loadConfig.mockResolvedValue(multiPkgConfig);
    execa.mockResolvedValueOnce({ exitCode: 0, stdout: 'abc1234' });
    await createProgram().parseAsync(['node', 'sfdt', 'manifest', '--package', 'unknown-pkg']);
    expect(print.error).toHaveBeenCalledWith(expect.stringContaining('Unknown package "unknown-pkg"'));
    expect(process.exitCode).toBe(1);
  });
  it('uses subpath layout when manifestLayout is "subpath" and --name is given', async () => {
    const subpathConfig = { ...defaultConfig, manifestLayout: 'subpath' };
    loadConfig.mockResolvedValue(subpathConfig);
    const diffOutput = 'A\tforce-app/main/default/classes/AccountHelper.cls';
    execa
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'abc1234' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: diffOutput });
    await createProgram().parseAsync(['node', 'sfdt', 'manifest', '--name', '3.0.0']);
    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining(path.join('all', 'rl-3.0.0-package.xml')),
      expect.any(String),
    );
  });
  it('includes [pkgTarget] in print.header when --package is given', async () => {
    loadConfig.mockResolvedValue(multiPkgConfig);
    const diffOutput = 'A\tforce-app/main/default/classes/AccountHelper.cls';
    execa
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'abc1234' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: diffOutput });
    await createProgram().parseAsync(['node', 'sfdt', 'manifest', '--package', 'core']);
    expect(print.header).toHaveBeenCalledWith(expect.stringContaining('[core]'));
  });
});
