import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import path from 'path';

vi.mock('fs-extra', () => ({
  default: {
    pathExistsSync: vi.fn(),
    pathExists: vi.fn(),
    readJson: vi.fn(),
    ensureDir: vi.fn(),
    writeJson: vi.fn(),
  },
}));

vi.mock('glob', () => ({
  glob: vi.fn(),
}));

vi.mock('inquirer', () => ({
  default: { prompt: vi.fn() },
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
  createSpinner: vi.fn(() => ({
    start: vi.fn(),
    succeed: vi.fn(),
    fail: vi.fn(),
  })),
}));

import fs from 'fs-extra';
import { glob } from 'glob';
import inquirer from 'inquirer';
import { print } from '../../src/lib/output.js';
import { registerInitCommand } from '../../src/commands/init.js';

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerInitCommand(program);
  return program;
}

beforeEach(() => {
  vi.resetAllMocks();
  process.exitCode = undefined;

  // Default: project root found
  fs.pathExistsSync.mockImplementation((p) => p.endsWith('sfdx-project.json'));

  // .sfdt does not exist yet
  fs.pathExists.mockResolvedValue(false);

  // sfdx-project.json content
  fs.readJson.mockResolvedValue({
    name: 'test-project',
    sourceApiVersion: '61.0',
    packageDirectories: [{ path: 'force-app', default: true }],
  });

  fs.ensureDir.mockResolvedValue();
  fs.writeJson.mockResolvedValue();

  // No apex classes found
  glob.mockResolvedValue([]);

  // User answers
  inquirer.prompt.mockResolvedValue({
    projectName: 'test-project',
    defaultOrg: 'dev',
    coverageThreshold: 75,
    aiEnabled: true,
  });
});

describe('init command', () => {
  it('creates config files in .sfdt directory', async () => {
    await createProgram().parseAsync(['node', 'sfdt', 'init']);

    expect(fs.ensureDir).toHaveBeenCalled();
    expect(fs.writeJson).toHaveBeenCalledTimes(4);

    const writtenFiles = fs.writeJson.mock.calls.map((c) => path.basename(c[0]));
    expect(writtenFiles).toContain('config.json');
    expect(writtenFiles).toContain('environments.json');
    expect(writtenFiles).toContain('pull-config.json');
    expect(writtenFiles).toContain('test-config.json');
  });

  it('writes correct config.json content', async () => {
    await createProgram().parseAsync(['node', 'sfdt', 'init']);

    const configCall = fs.writeJson.mock.calls.find((c) => c[0].endsWith('config.json'));
    const config = configCall[1];

    expect(config.projectName).toBe('test-project');
    expect(config.defaultOrg).toBe('dev');
    expect(config.features.ai).toBe(true);
  });

  it('prompts for overwrite when .sfdt already exists', async () => {
    fs.pathExists.mockResolvedValue(true);
    inquirer.prompt.mockResolvedValueOnce({ overwrite: true }).mockResolvedValueOnce({
      projectName: 'test-project',
      defaultOrg: 'dev',
      coverageThreshold: 75,
      aiEnabled: true,
    });

    await createProgram().parseAsync(['node', 'sfdt', 'init']);

    expect(inquirer.prompt).toHaveBeenCalledTimes(2);
    expect(fs.writeJson).toHaveBeenCalled();
  });

  it('cancels when user declines overwrite', async () => {
    fs.pathExists.mockResolvedValue(true);
    inquirer.prompt.mockResolvedValueOnce({ overwrite: false });

    await createProgram().parseAsync(['node', 'sfdt', 'init']);

    expect(print.info).toHaveBeenCalledWith('Init cancelled.');
    expect(fs.writeJson).not.toHaveBeenCalled();
  });

  it('detects test classes from glob scan', async () => {
    glob.mockImplementation(async (pattern) => {
      if (pattern.includes('Test.cls')) {
        return ['classes/MyClassTest.cls', 'classes/OtherTest.cls'];
      }
      return ['classes/MyClass.cls', 'classes/Other.cls', 'classes/MyClassTest.cls'];
    });

    await createProgram().parseAsync(['node', 'sfdt', 'init']);

    const testConfigCall = fs.writeJson.mock.calls.find((c) => c[0].endsWith('test-config.json'));
    const testConfig = testConfigCall[1];

    expect(testConfig.testClasses).toContain('MyClassTest');
    expect(testConfig.testClasses).toContain('OtherTest');
    expect(testConfig.apexClasses).toContain('MyClass');
    expect(testConfig.apexClasses).toContain('Other');
  });

  it('sets exitCode 1 when no sfdx-project.json found', async () => {
    fs.pathExistsSync.mockReturnValue(false);

    await createProgram().parseAsync(['node', 'sfdt', 'init']);

    expect(print.error).toHaveBeenCalledWith(expect.stringContaining('No sfdx-project.json'));
    expect(process.exitCode).toBe(1);
  });
});
