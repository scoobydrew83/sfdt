import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import path from 'path';

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
    expect(output.ok).toBe(true);
    expect(output.target).toBe('cursor');
    expect(output.skillsCount).toBe(2);
    expect(output.files[0]).toContain('.cursorrules');

    stdoutSpy.mockRestore();
  });
});
