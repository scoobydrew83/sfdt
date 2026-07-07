import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import path from 'path';
import { fileURLToPath } from 'url';

// Mirrors the SKILLS_DIR resolution in src/commands/skills.js (both are two dirs
// up from their own location → repo root → skills/).
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = path.resolve(TEST_DIR, '..', '..', 'skills');

vi.mock('fs-extra', async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    default: {
      ...actual.default,
      pathExists: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(),
      writeJson: vi.fn(),
      copy: vi.fn(),
      emptyDir: vi.fn(),
    },
  };
});

vi.mock('glob', () => ({
  glob: vi.fn(),
}));

import fs from 'fs-extra';
import { glob } from 'glob';
import { registerSkillsCommand } from '../../src/commands/skills.js';

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerSkillsCommand(program);
  return program;
}

beforeEach(() => {
  vi.resetAllMocks();
  process.exitCode = undefined;

  fs.pathExists.mockResolvedValue(true);
  glob.mockResolvedValue([
    '/mock/skills/sf-apex-review/SKILL.md',
    '/mock/skills/sf-flow-review/SKILL.md',
  ]);

  fs.readFile.mockImplementation(async (file) => {
    if (file.includes('sf-apex-review')) {
      return `---
name: sf-apex-review
description: Production-grade Apex code review
triggers:
  - apex review
---
Some body text for Apex review.`;
    }
    return `---
name: sf-flow-review
description: Production-grade Flow review
triggers:
  - flow review
---
Some body text for Flow review.`;
  });

  fs.writeFile.mockResolvedValue();
  fs.writeJson.mockResolvedValue();
  fs.copy.mockResolvedValue();
  fs.emptyDir.mockResolvedValue();
});

describe('skills export command', () => {
  it('throws an error for invalid targets', async () => {
    const program = createProgram();
    await program.parseAsync(['node', 'sfdt', 'skills', 'export', '--target', 'invalid-target']);
    expect(process.exitCode).toBe(1);
  });

  it('generates and writes .cursorrules file for target "cursor"', async () => {
    await createProgram().parseAsync(['node', 'sfdt', 'skills', 'export', '--target', 'cursor']);

    expect(fs.writeFile).toHaveBeenCalledTimes(1);
    const writeCall = fs.writeFile.mock.calls[0];
    expect(writeCall[0]).toContain('.cursorrules');
    
    const content = writeCall[1];
    expect(content).toContain('# Skill: sf-apex-review');
    expect(content).toContain('**Description:** Production-grade Apex code review');
    expect(content).toContain('**Triggers:** apex review');
    expect(content).toContain('Some body text for Apex review.');

    expect(content).toContain('# Skill: sf-flow-review');
    expect(content).toContain('Some body text for Flow review.');
  });

  it('generates and writes both .clauderules and .claudecode.json for target "claude"', async () => {
    await createProgram().parseAsync(['node', 'sfdt', 'skills', 'export', '--target', 'claude']);

    expect(fs.writeFile).toHaveBeenCalledTimes(1);
    expect(fs.writeJson).toHaveBeenCalledTimes(1);

    const writeCall = fs.writeFile.mock.calls[0];
    expect(writeCall[0]).toContain('.clauderules');

    const jsonCall = fs.writeJson.mock.calls[0];
    expect(jsonCall[0]).toContain('.claudecode.json');
    expect(jsonCall[1].customInstructions).toContain('sf-apex-review');
  });

  it('emits results as JSON when --json option is passed', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await createProgram().parseAsync([
      'node',
      'sfdt',
      'skills',
      'export',
      '--target',
      'cursor',
      '--json',
    ]);

    expect(stdoutSpy).toHaveBeenCalled();
    const output = JSON.parse(stdoutSpy.mock.calls[0][0]);
    expect(output.status).toBe(0);
    expect(output.result.ok).toBe(true);
    expect(output.result.target).toBe('cursor');
    expect(output.result.skillsCount).toBe(2);
    expect(output.result.files[0]).toContain('.cursorrules');

    stdoutSpy.mockRestore();
  });
});

describe('skills export --target pack', () => {
  beforeEach(() => {
    // Per-pattern glob: SKILL.md lookup returns absolute paths under the real
    // SKILLS_DIR (so folderRel resolves cleanly); the file sweep returns repo-
    // relative paths as glob(cwd: SKILLS_DIR) would.
    glob.mockImplementation(async (pattern) => {
      if (pattern === '**/SKILL.md') {
        return [
          path.join(SKILLS_DIR, 'sf-deploy', 'SKILL.md'),
          path.join(SKILLS_DIR, 'sfdt-cli', 'SKILL.md'),
        ];
      }
      return ['sf-deploy/SKILL.md', 'sfdt-cli/SKILL.md', 'sfdt-cli/references/commands.md'];
    });

    fs.readFile.mockImplementation(async (file) => {
      if (file.includes('sfdt-cli')) {
        return `---\nname: sfdt-cli\ndescription: SFDT CLI usage\n---\nbody`;
      }
      return `---\nname: sf-deploy\ndescription: Deploy metadata\n---\nbody`;
    });
  });

  it('writes a manifest.json and copies each skill folder', async () => {
    await createProgram().parseAsync([
      'node', 'sfdt', 'skills', 'export', '--target', 'pack', '--out', 'out-pack',
    ]);

    expect(process.exitCode).toBeUndefined();

    // Output skills/ tree is emptied before copying so re-exports are reproducible.
    expect(fs.emptyDir).toHaveBeenCalledWith(expect.stringContaining(path.join('out-pack', 'skills')));

    // One copy per skill folder, from SKILLS_DIR/<name> → <out>/skills/<name>
    expect(fs.copy).toHaveBeenCalledTimes(2);
    expect(fs.copy).toHaveBeenCalledWith(
      path.join(SKILLS_DIR, 'sf-deploy'),
      expect.stringContaining(path.join('out-pack', 'skills', 'sf-deploy')),
    );

    expect(fs.writeJson).toHaveBeenCalledTimes(1);
    const [manifestPath, manifest] = fs.writeJson.mock.calls[0];
    expect(manifestPath).toContain(path.join('out-pack', 'manifest.json'));
    expect(manifest.version).toBe(1);
    expect(typeof manifest.generatedAt).toBe('string');
    expect(manifest.skills).toHaveLength(2);
  });

  it('produces npx-skills-compatible manifest entries', async () => {
    await createProgram().parseAsync([
      'node', 'sfdt', 'skills', 'export', '--target', 'pack', '--out', 'out-pack',
    ]);

    const manifest = fs.writeJson.mock.calls[0][1];
    const deploy = manifest.skills.find((s) => s.name === 'sf-deploy');
    expect(deploy).toEqual({
      name: 'sf-deploy',
      path: 'skills/sf-deploy/SKILL.md',
      folderPath: 'skills/sf-deploy',
      category: 'salesforce',
      files: ['SKILL.md'],
      description: 'Deploy metadata',
    });

    const cli = manifest.skills.find((s) => s.name === 'sfdt-cli');
    expect(cli.category).toBe('sfdt');
    // SKILL.md first, then remaining files alphabetically.
    expect(cli.files).toEqual(['SKILL.md', 'references/commands.md']);
  });

  it('emits pack results as JSON', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await createProgram().parseAsync([
      'node', 'sfdt', 'skills', 'export', '--target', 'pack', '--out', 'out-pack', '--json',
    ]);

    const output = JSON.parse(stdoutSpy.mock.calls[0][0]);
    stdoutSpy.mockRestore();
    expect(output.status).toBe(0);
    expect(output.result.ok).toBe(true);
    expect(output.result.target).toBe('pack');
    expect(output.result.skillsCount).toBe(2);
    expect(output.result.skills).toContain('sf-deploy');
  });
});
