import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import path from 'path';

vi.mock('fs-extra', () => ({
  default: {
    pathExists: vi.fn(),
    ensureDir: vi.fn(),
    writeJson: vi.fn(),
    writeFile: vi.fn(),
  },
}));

vi.mock('inquirer', () => ({
  default: { prompt: vi.fn() },
}));

vi.mock('execa', () => ({
  execa: vi.fn(),
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
import inquirer from 'inquirer';
import { execa } from 'execa';
import { print } from '../../src/lib/output.js';
import { registerPluginCommand } from '../../src/commands/plugin.js';

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerPluginCommand(program);
  return program;
}

beforeEach(() => {
  vi.resetAllMocks();
  process.exitCode = undefined;

  // Defaults: target folder does not exist
  fs.pathExists.mockResolvedValue(false);
  fs.ensureDir.mockResolvedValue();
  fs.writeJson.mockResolvedValue();
  fs.writeFile.mockResolvedValue();

  execa.mockResolvedValue({ stdout: 'Mock Author Name\n' });

  // Default inquirer prompt resolved values
  inquirer.prompt.mockResolvedValue({
    name: 'sfdt-plugin-custom',
    description: 'A custom plugin for sfdt',
    author: 'Mock Author Name',
  });
});

describe('plugin create command', () => {
  it('scaffolds plugin project files successfully when positional name is passed', async () => {
    // Resolve description/author via prompts
    inquirer.prompt.mockResolvedValue({
      description: 'Custom description',
      author: 'John Doe',
    });

    await createProgram().parseAsync(['node', 'sfdt', 'plugin', 'create', 'sfdt-plugin-my-test']);

    expect(fs.ensureDir).toHaveBeenCalled();
    expect(fs.writeJson).toHaveBeenCalledTimes(1);
    expect(fs.writeFile).toHaveBeenCalledTimes(3);

    // Verify package.json call
    const packageJsonCall = fs.writeJson.mock.calls.find((c) => c[0].endsWith('package.json'));
    expect(packageJsonCall).toBeDefined();
    expect(packageJsonCall[1].name).toBe('sfdt-plugin-my-test');
    expect(packageJsonCall[1].description).toBe('Custom description');
    expect(packageJsonCall[1].author).toBe('John Doe');

    // Verify print outputs
    expect(print.header).toHaveBeenCalledWith(expect.stringContaining('sfdt-plugin-my-test'));
    expect(print.success).toHaveBeenCalledWith(expect.stringContaining('Successfully created custom plugin project'));
  });

  it('scaffolds successfully by prompting for name when none is passed', async () => {
    inquirer.prompt.mockResolvedValue({
      name: 'sfdt-plugin-prompted',
      description: 'Another desc',
      author: 'Jane Doe',
    });

    await createProgram().parseAsync(['node', 'sfdt', 'plugin', 'create']);

    expect(fs.ensureDir).toHaveBeenCalled();
    // Verify package.json contains correct name
    const packageJsonCall = fs.writeJson.mock.calls.find((c) => c[0].endsWith('package.json'));
    expect(packageJsonCall[1].name).toBe('sfdt-plugin-prompted');
    expect(packageJsonCall[1].description).toBe('Another desc');
    expect(packageJsonCall[1].author).toBe('Jane Doe');
  });

  it('warns when the plugin name does not start with sfdt-plugin-', async () => {
    inquirer.prompt.mockResolvedValue({
      description: 'Desc',
      author: 'Jane Doe',
    });

    await createProgram().parseAsync(['node', 'sfdt', 'plugin', 'create', 'my-custom-ext']);

    expect(print.warning).toHaveBeenCalledWith(expect.stringContaining('does not start with "sfdt-plugin-"'));
    expect(fs.ensureDir).toHaveBeenCalled();
  });

  it('throws an error if target directory already exists', async () => {
    fs.pathExists.mockResolvedValue(true);

    await createProgram().parseAsync(['node', 'sfdt', 'plugin', 'create', 'sfdt-plugin-exists']);

    expect(print.error).toHaveBeenCalledWith(expect.stringContaining('already exists'));
    expect(fs.ensureDir).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
