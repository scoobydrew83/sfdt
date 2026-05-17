import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

vi.mock('fs-extra', () => ({
  default: {
    pathExists: vi.fn(),
    chmod: vi.fn(),
  },
}));

import { execa } from 'execa';
import fs from 'fs-extra';
import { buildScriptEnv, runScript } from '../src/lib/script-runner.js';

beforeEach(() => {
  vi.resetAllMocks();
});

describe('buildScriptEnv', () => {
  it('returns empty object for null config', () => {
    expect(buildScriptEnv(null)).toEqual({});
  });

  it('returns empty object for non-object config', () => {
    expect(buildScriptEnv('string')).toEqual({});
  });

  it('maps basic config fields to SFDT_ vars', () => {
    const config = {
      _projectRoot: '/project',
      _configDir: '/project/.sfdt',
      projectName: 'My App',
      defaultOrg: 'devhub',
      defaultSourcePath: 'src/main/default',
      manifestDir: 'manifest/prod',
      releaseNotesDir: 'docs/releases',
      sourceApiVersion: '61.0',
      deployment: { coverageThreshold: 80 },
    };

    const env = buildScriptEnv(config);

    expect(env.SFDT_PROJECT_ROOT).toBe('/project');
    expect(env.SFDT_CONFIG_DIR).toBe('/project/.sfdt');
    expect(env.SFDT_PROJECT_NAME).toBe('My App');
    expect(env.SFDT_DEFAULT_ORG).toBe('devhub');
    expect(env.SFDT_SOURCE_PATH).toBe('src/main/default');
    expect(env.SFDT_MANIFEST_DIR).toBe('manifest/prod');
    expect(env.SFDT_RELEASE_NOTES_DIR).toBe('docs/releases');
    expect(env.SFDT_API_VERSION).toBe('61.0');
    expect(env.SFDT_COVERAGE_THRESHOLD).toBe('80');
  });

  it('uses defaults for missing optional fields', () => {
    const config = { features: {} };
    const env = buildScriptEnv(config);

    expect(env.SFDT_PROJECT_ROOT).toBe('');
    expect(env.SFDT_PROJECT_NAME).toBe('Salesforce Project');
    expect(env.SFDT_SOURCE_PATH).toBe('force-app/main/default');
    expect(env.SFDT_MANIFEST_DIR).toBe('manifest/release');
    expect(env.SFDT_RELEASE_NOTES_DIR).toBe('release-notes');
    expect(env.SFDT_COVERAGE_THRESHOLD).toBe('75');
  });

  it('flattens features into SFDT_FEATURE_ vars', () => {
    const config = {
      features: {
        ai: true,
        notifications: false,
        releaseManagement: true,
      },
    };

    const env = buildScriptEnv(config);

    expect(env.SFDT_FEATURE_AI).toBe('true');
    expect(env.SFDT_FEATURE_NOTIFICATIONS).toBe('false');
    expect(env.SFDT_FEATURE_RELEASE_MANAGEMENT).toBe('true');
  });

  it('flattens environments', () => {
    const config = {
      features: {},
      environments: {
        default: 'staging',
        orgs: [{ alias: 'dev' }, { name: 'prod' }, {}],
      },
    };

    const env = buildScriptEnv(config);

    expect(env.SFDT_DEFAULT_ENV).toBe('staging');
    expect(env.SFDT_ENV_ORGS).toBe('dev,prod,');
  });

  it('flattens testConfig', () => {
    const config = {
      features: {},
      testConfig: {
        coverageThreshold: 90,
        testLevel: 'RunSpecifiedTests',
        suites: ['smoke', 'integration'],
        testClasses: ['FooTest', 'BarTest'],
        apexClasses: ['Foo', 'Bar'],
      },
    };

    const env = buildScriptEnv(config);

    expect(env.SFDT_TEST_COVERAGE_THRESHOLD).toBe('90');
    expect(env.SFDT_TEST_LEVEL).toBe('RunSpecifiedTests');
    expect(env.SFDT_TEST_SUITES).toBe('smoke,integration');
    expect(env.SFDT_TEST_CLASSES).toBe('FooTest,BarTest');
    expect(env.SFDT_APEX_CLASSES).toBe('Foo,Bar');
  });


  it('sets preflight enforce vars to "true" when config flags are set', () => {
    const config = {
      features: {},
      deployment: {
        preflight: {
          enforceTests: true,
          enforceBranchNaming: true,
          enforceChangelog: true,
        },
      },
    };

    const env = buildScriptEnv(config);

    expect(env.SFDT_PREFLIGHT_ENFORCE_TESTS).toBe('true');
    expect(env.SFDT_PREFLIGHT_ENFORCE_BRANCH).toBe('true');
    expect(env.SFDT_PREFLIGHT_ENFORCE_CHANGELOG).toBe('true');
  });

  it('sets preflight enforce vars to empty string when config flags are false or absent', () => {
    const config = {
      features: {},
      deployment: {
        preflight: {
          enforceTests: false,
          enforceBranchNaming: false,
          enforceChangelog: false,
        },
      },
    };

    const env = buildScriptEnv(config);

    expect(env.SFDT_PREFLIGHT_ENFORCE_TESTS).toBe('');
    expect(env.SFDT_PREFLIGHT_ENFORCE_BRANCH).toBe('');
    expect(env.SFDT_PREFLIGHT_ENFORCE_CHANGELOG).toBe('');
  });

  it('sets SFDT_PREFLIGHT_ENFORCE_GIT_CLEAN to "false" when enforceGitClean is explicitly false', () => {
    const config = {
      features: {},
      deployment: {
        preflight: {
          enforceGitClean: false,
        },
      },
    };

    const env = buildScriptEnv(config);
    expect(env.SFDT_PREFLIGHT_ENFORCE_GIT_CLEAN).toBe('false');
  });

  it('sets SFDT_PREFLIGHT_ENFORCE_GIT_CLEAN to "true" by default when not specified', () => {
    const config = { features: {} };
    const env = buildScriptEnv(config);
    expect(env.SFDT_PREFLIGHT_ENFORCE_GIT_CLEAN).toBe('true');
  });

  it('sets SFDT_PREFLIGHT_ENFORCE_SFDX_PROJECT to "false" when enforceSfdxProject is explicitly false', () => {
    const config = {
      features: {},
      deployment: {
        preflight: {
          enforceSfdxProject: false,
        },
      },
    };

    const env = buildScriptEnv(config);
    expect(env.SFDT_PREFLIGHT_ENFORCE_SFDX_PROJECT).toBe('false');
  });

  it('sets SFDT_PREFLIGHT_ENFORCE_SFDX_PROJECT to "true" by default', () => {
    const config = { features: {} };
    const env = buildScriptEnv(config);
    expect(env.SFDT_PREFLIGHT_ENFORCE_SFDX_PROJECT).toBe('true');
  });

  it('sets SFDT_PREFLIGHT_ENFORCE_UNTRACKED to "true" when enforceUntrackedFiles is set', () => {
    const config = {
      features: {},
      deployment: {
        preflight: {
          enforceUntrackedFiles: true,
        },
      },
    };

    const env = buildScriptEnv(config);
    expect(env.SFDT_PREFLIGHT_ENFORCE_UNTRACKED).toBe('true');
  });

  it('sets SFDT_PREFLIGHT_STRICT to "true" when strict is set', () => {
    const config = {
      features: {},
      deployment: {
        preflight: {
          strict: true,
        },
      },
    };

    const env = buildScriptEnv(config);
    expect(env.SFDT_PREFLIGHT_STRICT).toBe('true');
  });

  it('maps packageDirectories to SFDT_PACKAGE_DIRS as JSON array of paths', () => {
    const config = {
      features: {},
      packageDirectories: [
        { path: 'force-app/main/default' },
        { path: 'force-app/feature-a' },
      ],
    };

    const env = buildScriptEnv(config);
    expect(env.SFDT_PACKAGE_DIRS).toBe(JSON.stringify(['force-app/main/default', 'force-app/feature-a']));
  });

  it('does not set SFDT_PACKAGE_DIRS when packageDirectories is absent', () => {
    const config = { features: {} };
    const env = buildScriptEnv(config);
    expect(env.SFDT_PACKAGE_DIRS).toBeUndefined();
  });

  it('maps manifestLayout to SFDT_MANIFEST_LAYOUT with default "flat"', () => {
    const configNoLayout = { features: {} };
    expect(buildScriptEnv(configNoLayout).SFDT_MANIFEST_LAYOUT).toBe('flat');

    const configSubpath = { features: {}, manifestLayout: 'subpath' };
    expect(buildScriptEnv(configSubpath).SFDT_MANIFEST_LAYOUT).toBe('subpath');
  });

  it('maps changelogDir to SFDT_CHANGELOG_DIR with default "changelogs"', () => {
    const configNoDir = { features: {} };
    expect(buildScriptEnv(configNoDir).SFDT_CHANGELOG_DIR).toBe('changelogs');

    const configCustomDir = { features: {}, changelogDir: 'my-changelogs' };
    expect(buildScriptEnv(configCustomDir).SFDT_CHANGELOG_DIR).toBe('my-changelogs');
  });

  it('maps logDir to SFDT_LOG_DIR', () => {
    const config = { features: {}, logDir: '/var/log/sfdt' };
    const env = buildScriptEnv(config);
    expect(env.SFDT_LOG_DIR).toBe('/var/log/sfdt');
  });

  it('sets SFDT_LOG_DIR to empty string when logDir is absent', () => {
    const config = { features: {} };
    const env = buildScriptEnv(config);
    expect(env.SFDT_LOG_DIR).toBe('');
  });

  it('skips SFDT_DEFAULT_ENV when environments.default is absent', () => {
    const config = { features: {}, environments: { orgs: [] } };
    const env = buildScriptEnv(config);
    expect(env.SFDT_DEFAULT_ENV).toBeUndefined();
  });

  it('skips SFDT_ENV_ORGS when environments.orgs is not an array', () => {
    const config = { features: {}, environments: { default: 'prod' } };
    const env = buildScriptEnv(config);
    expect(env.SFDT_ENV_ORGS).toBeUndefined();
  });

  it('ignores non-object features value', () => {
    const config = { features: null };
    // should not throw, features block is skipped
    const env = buildScriptEnv(config);
    expect(env.SFDT_PROJECT_NAME).toBe('Salesforce Project');
  });

  it('ignores non-object testConfig value', () => {
    const config = { features: {}, testConfig: null };
    const env = buildScriptEnv(config);
    expect(env.SFDT_TEST_LEVEL).toBeUndefined();
  });
});

describe('runScript', () => {
  const config = {
    _projectRoot: '/project',
    _configDir: '/project/.sfdt',
    defaultOrg: 'dev',
    features: { ai: true },
  };

  it('throws when script does not exist', async () => {
    fs.pathExists.mockResolvedValue(false);
    await expect(runScript('missing.sh', config)).rejects.toThrow('Script not found');
  });

  it('throws when chmod fails', async () => {
    fs.pathExists.mockResolvedValue(true);
    fs.chmod.mockRejectedValue(new Error('permission denied'));

    await expect(runScript('test.sh', config)).rejects.toThrow(
      'Failed to set executable permission',
    );
  });

  it('runs script with merged environment variables', async () => {
    fs.pathExists.mockResolvedValue(true);
    fs.chmod.mockResolvedValue();
    execa.mockResolvedValue({ exitCode: 0, stdout: 'ok', stderr: '' });

    const result = await runScript('deploy/push.sh', config, {
      args: ['--verbose'],
      env: { EXTRA_VAR: 'value' },
    });

    expect(result.exitCode).toBe(0);

    const call = execa.mock.calls[0];
    expect(call[0]).toMatch(/scripts\/deploy\/push\.sh$/);
    expect(call[1]).toEqual(['--verbose']);

    const passedEnv = call[2].env;
    expect(passedEnv.SFDT_DEFAULT_ORG).toBe('dev');
    expect(passedEnv.EXTRA_VAR).toBe('value');
  });

  it('throws on non-zero exit code', async () => {
    fs.pathExists.mockResolvedValue(true);
    fs.chmod.mockResolvedValue();
    execa.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'deploy failed' });

    await expect(runScript('deploy/push.sh', config)).rejects.toThrow('exited with code 1');
  });

  it('uses stdio inherit when interactive is true', async () => {
    fs.pathExists.mockResolvedValue(true);
    fs.chmod.mockResolvedValue();
    execa.mockResolvedValue({ exitCode: 0 });

    await runScript('test.sh', config, { interactive: true });

    const execOptions = execa.mock.calls[0][2];
    expect(execOptions.stdio).toBe('inherit');
  });

  it('does not set stdio when interactive is false', async () => {
    fs.pathExists.mockResolvedValue(true);
    fs.chmod.mockResolvedValue();
    execa.mockResolvedValue({ exitCode: 0 });

    await runScript('test.sh', config, { interactive: false });

    const execOptions = execa.mock.calls[0][2];
    expect(execOptions.stdio).toBeUndefined();
  });

  it('uses project root as default cwd', async () => {
    fs.pathExists.mockResolvedValue(true);
    fs.chmod.mockResolvedValue();
    execa.mockResolvedValue({ exitCode: 0 });

    await runScript('test.sh', config);

    const execOptions = execa.mock.calls[0][2];
    expect(execOptions.cwd).toBe('/project');
  });

  it('uses custom cwd when provided', async () => {
    fs.pathExists.mockResolvedValue(true);
    fs.chmod.mockResolvedValue();
    execa.mockResolvedValue({ exitCode: 0 });

    await runScript('test.sh', config, { cwd: '/custom/dir' });

    const execOptions = execa.mock.calls[0][2];
    expect(execOptions.cwd).toBe('/custom/dir');
  });

  it('sets stdio to pipe+inherit when captureStdout is true', async () => {
    fs.pathExists.mockResolvedValue(true);
    fs.chmod.mockResolvedValue();
    execa.mockResolvedValue({ exitCode: 0, stdout: 'output', stderr: '' });

    await runScript('test.sh', config, { captureStdout: true });

    const execOptions = execa.mock.calls[0][2];
    expect(execOptions.stdio).toEqual(['inherit', 'pipe', 'inherit']);
  });

  it('attaches exitCode property to the thrown error on non-zero exit', async () => {
    fs.pathExists.mockResolvedValue(true);
    fs.chmod.mockResolvedValue();
    execa.mockResolvedValue({ exitCode: 2, stdout: 'partial', stderr: 'boom' });

    let caught;
    try {
      await runScript('deploy/push.sh', config);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    expect(caught.exitCode).toBe(2);
    expect(caught.stdout).toBe('partial');
    expect(caught.stderr).toBe('boom');
  });

  it('includes stderr in thrown error message when present', async () => {
    fs.pathExists.mockResolvedValue(true);
    fs.chmod.mockResolvedValue();
    execa.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'something went wrong' });

    await expect(runScript('deploy/push.sh', config)).rejects.toThrow('something went wrong');
  });

  it('returns stdout from successful captureStdout run', async () => {
    fs.pathExists.mockResolvedValue(true);
    fs.chmod.mockResolvedValue();
    execa.mockResolvedValue({ exitCode: 0, stdout: 'captured output', stderr: '' });

    const result = await runScript('test.sh', config, { captureStdout: true });

    expect(result.stdout).toBe('captured output');
  });

  it('sets reject: false on execa options', async () => {
    fs.pathExists.mockResolvedValue(true);
    fs.chmod.mockResolvedValue();
    execa.mockResolvedValue({ exitCode: 0 });

    await runScript('test.sh', config);

    const execOptions = execa.mock.calls[0][2];
    expect(execOptions.reject).toBe(false);
  });

  it('passes extra env vars merged into the environment', async () => {
    fs.pathExists.mockResolvedValue(true);
    fs.chmod.mockResolvedValue();
    execa.mockResolvedValue({ exitCode: 0 });

    await runScript('test.sh', config, { env: { MY_CUSTOM_VAR: 'hello' } });

    const passedEnv = execa.mock.calls[0][2].env;
    expect(passedEnv.MY_CUSTOM_VAR).toBe('hello');
  });
});
