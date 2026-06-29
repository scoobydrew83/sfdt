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

  // fs.readJson: return template or sfdx-project.json based on path
  fs.readJson.mockImplementation((filePath) => {
    if (filePath.endsWith('sfdt.config.json')) {
      return Promise.resolve({
        projectName: '',
        defaultOrg: '',
        releaseNotesDir: 'release-notes',
        manifestDir: 'manifest/release',
        deployment: {
          coverageThreshold: 75,
          preflight: {
            enforceTests: false,
            enforceBranchNaming: false,
            enforceChangelog: false,
          },
        },
        features: {
          ai: true,
          notifications: false,
          releaseManagement: true,
        },
      });
    }
    return Promise.resolve({
      name: 'test-project',
      sourceApiVersion: '61.0',
      packageDirectories: [{ path: 'force-app', default: true }],
    });
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
    releaseNotesDir: 'release-notes',
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
    expect(config.deployment.preflight).toBeDefined();
    expect(config.deployment.preflight.enforceTests).toBe(false);
    expect(config.deployment.preflight.enforceBranchNaming).toBe(false);
    expect(config.deployment.preflight.enforceChangelog).toBe(false);
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

  it('prompts for manifest layout when multiple package directories are detected', async () => {
    fs.readJson.mockImplementation((filePath) => {
      if (filePath.endsWith('sfdt.config.json')) {
        return Promise.resolve({
          projectName: '',
          defaultOrg: '',
          releaseNotesDir: 'release-notes',
          manifestDir: 'manifest/release',
          deployment: { coverageThreshold: 75, preflight: {} },
          features: { ai: true, notifications: false, releaseManagement: true },
        });
      }
      return Promise.resolve({
        name: 'multi-pkg-project',
        sourceApiVersion: '61.0',
        packageDirectories: [
          { path: 'force-app', default: true },
          { path: 'force-app-two', default: false },
        ],
      });
    });

    inquirer.prompt
      .mockResolvedValueOnce({
        projectName: 'multi-pkg-project',
        defaultOrg: 'dev',
        coverageThreshold: 75,
        aiEnabled: true,
        releaseNotesDir: 'release-notes',
      })
      .mockResolvedValueOnce({ useSubpath: true });

    await createProgram().parseAsync(['node', 'sfdt', 'init']);

    const configCall = fs.writeJson.mock.calls.find((c) => c[0].endsWith('config.json'));
    expect(configCall[1].manifestLayout).toBe('subpath');
  });

  it('sets exitCode 1 when init fails after config dir is created', async () => {
    fs.writeJson.mockRejectedValue(new Error('disk full'));

    await createProgram().parseAsync(['node', 'sfdt', 'init']);

    expect(print.error).toHaveBeenCalledWith(expect.stringContaining('Init failed'));
    expect(process.exitCode).toBe(1);
  });

  it('enforces validation and conditional display rules on the prompts', async () => {
    await createProgram().parseAsync(['node', 'sfdt', 'init']);

    // The main questionnaire is the prompt-call array holding the projectName question.
    const questions = inquirer.prompt.mock.calls
      .map((c) => c[0])
      .find((arg) => Array.isArray(arg) && arg.some((q) => q.name === 'projectName'));
    const byName = Object.fromEntries(questions.map((q) => [q.name, q]));

    // defaultOrg requires a non-empty alias (line 131).
    expect(byName.defaultOrg.validate('  ')).toBe('Org alias is required');
    expect(byName.defaultOrg.validate('dev')).toBe(true);

    // coverageThreshold must be an integer 0–100 (lines 138-140).
    expect(byName.coverageThreshold.validate(75)).toBe(true);
    expect(byName.coverageThreshold.validate(150)).toContain('between 0 and 100');
    expect(byName.coverageThreshold.validate(3.5)).toContain('between 0 and 100');

    // aiProvider only shown when AI enabled (line 159).
    expect(byName.aiProvider.when({ aiEnabled: true })).toBe(true);
    expect(byName.aiProvider.when({ aiEnabled: false })).toBe(false);

    // http-specific prompts only when provider === 'http' (lines 166, 172, 178).
    expect(byName.aiBaseURL.when({ aiEnabled: true, aiProvider: 'http' })).toBe(true);
    expect(byName.aiBaseURL.when({ aiEnabled: true, aiProvider: 'claude' })).toBe(false);
    expect(byName.aiModel.when({ aiEnabled: true, aiProvider: 'http' })).toBe(true);
    expect(byName.aiApiKeyEnv.when({ aiEnabled: true, aiProvider: 'http' })).toBe(true);
    expect(byName.aiApiKeyEnv.when({ aiEnabled: false, aiProvider: 'http' })).toBe(false);
  });

  it('writes http provider keys when the http AI provider is chosen', async () => {
    inquirer.prompt.mockResolvedValue({
      projectName: 'test-project',
      defaultOrg: 'dev',
      coverageThreshold: 75,
      aiEnabled: true,
      aiProvider: 'http',
      aiBaseURL: 'http://localhost:11434/v1',
      aiModel: 'llama3.1',
      aiApiKeyEnv: 'OLLAMA_KEY',
      releaseNotesDir: 'release-notes',
      mcpEnabled: false,
    });

    await createProgram().parseAsync(['node', 'sfdt', 'init']);

    const config = fs.writeJson.mock.calls.find((c) => c[0].endsWith('config.json'))[1];
    expect(config.ai.provider).toBe('http');
    expect(config.ai.baseURL).toBe('http://localhost:11434/v1');
    expect(config.ai.apiKeyEnv).toBe('OLLAMA_KEY');
    expect(config.ai.model).toBe('llama3.1');
  });

  it('records AI as disabled when the user opts out', async () => {
    inquirer.prompt.mockResolvedValue({
      projectName: 'test-project',
      defaultOrg: 'dev',
      coverageThreshold: 75,
      aiEnabled: false,
      releaseNotesDir: 'release-notes',
      mcpEnabled: false,
    });

    await createProgram().parseAsync(['node', 'sfdt', 'init']);

    const config = fs.writeJson.mock.calls.find((c) => c[0].endsWith('config.json'))[1];
    expect(config.features.ai).toBe(false);
    // http keys are omitted for non-http providers.
    expect(config.ai.baseURL).toBeUndefined();
    expect(print.step).toHaveBeenCalledWith('  AI features: disabled');
  });
});
