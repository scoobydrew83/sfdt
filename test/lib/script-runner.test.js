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
import { buildScriptEnv, runScript } from '../../src/lib/script-runner.js';

beforeEach(() => {
  vi.resetAllMocks();
  fs.pathExists.mockResolvedValue(true);
  fs.chmod.mockResolvedValue(undefined);
  execa.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
});

describe('buildScriptEnv', () => {
  it('returns an empty object for invalid input', () => {
    expect(buildScriptEnv(null)).toEqual({});
    expect(buildScriptEnv('nope')).toEqual({});
  });

  it('maps core config keys with documented defaults', () => {
    const env = buildScriptEnv({
      _projectRoot: '/proj',
      _configDir: '/proj/.sfdt',
      defaultOrg: 'dev-org',
    });
    expect(env.SFDT_PROJECT_ROOT).toBe('/proj');
    expect(env.SFDT_CONFIG_DIR).toBe('/proj/.sfdt');
    expect(env.SFDT_DEFAULT_ORG).toBe('dev-org');
    expect(env.SFDT_PROJECT_NAME).toBe('Salesforce Project');
    expect(env.SFDT_SOURCE_PATH).toBe('force-app/main/default');
    expect(env.SFDT_MANIFEST_DIR).toBe('manifest/release');
    expect(env.SFDT_RELEASE_NOTES_DIR).toBe('release-notes');
    expect(env.SFDT_COVERAGE_THRESHOLD).toBe('75');
    expect(env.SFDT_MANIFEST_LAYOUT).toBe('flat');
    expect(env.SFDT_CHANGELOG_DIR).toBe('changelogs');
  });

  it('maps preflight enforcement flags with their distinct default polarities', () => {
    const env = buildScriptEnv({});
    // Opt-in flags default to empty string
    expect(env.SFDT_PREFLIGHT_ENFORCE_TESTS).toBe('');
    expect(env.SFDT_PREFLIGHT_ENFORCE_BRANCH).toBe('');
    expect(env.SFDT_PREFLIGHT_ENFORCE_CHANGELOG).toBe('');
    expect(env.SFDT_PREFLIGHT_ENFORCE_UNTRACKED).toBe('');
    expect(env.SFDT_PREFLIGHT_STRICT).toBe('');
    // Opt-out flags default to 'true'
    expect(env.SFDT_PREFLIGHT_ENFORCE_GIT_CLEAN).toBe('true');
    expect(env.SFDT_PREFLIGHT_ENFORCE_SFDX_PROJECT).toBe('true');

    const disabled = buildScriptEnv({
      deployment: { preflight: { enforceGitClean: false, enforceSfdxProject: false, strict: true } },
    });
    expect(disabled.SFDT_PREFLIGHT_ENFORCE_GIT_CLEAN).toBe('false');
    expect(disabled.SFDT_PREFLIGHT_ENFORCE_SFDX_PROJECT).toBe('false');
    expect(disabled.SFDT_PREFLIGHT_STRICT).toBe('true');
  });

  it('flattens features into SFDT_FEATURE_* with camelCase split', () => {
    const env = buildScriptEnv({ features: { ai: true, releaseManagement: false } });
    expect(env.SFDT_FEATURE_AI).toBe('true');
    expect(env.SFDT_FEATURE_RELEASE_MANAGEMENT).toBe('false');
  });

  it('flattens environments and test config lists', () => {
    const env = buildScriptEnv({
      environments: { default: 'qa', orgs: [{ alias: 'qa1' }, { name: 'qa2' }] },
      testConfig: {
        coverageThreshold: 80,
        testLevel: 'RunLocalTests',
        testClasses: ['ATest', 'BTest'],
        apexClasses: ['A', 'B'],
      },
    });
    expect(env.SFDT_DEFAULT_ENV).toBe('qa');
    expect(env.SFDT_ENV_ORGS).toBe('qa1,qa2');
    expect(env.SFDT_TEST_COVERAGE_THRESHOLD).toBe('80');
    expect(env.SFDT_TEST_LEVEL).toBe('RunLocalTests');
    expect(env.SFDT_TEST_CLASSES).toBe('ATest,BTest');
    expect(env.SFDT_APEX_CLASSES).toBe('A,B');
  });

  it('maps defaultBranch to SFDT_DEFAULT_BRANCH with "main" default', () => {
    expect(buildScriptEnv({}).SFDT_DEFAULT_BRANCH).toBe('main');
    expect(buildScriptEnv({ defaultBranch: 'develop' }).SFDT_DEFAULT_BRANCH).toBe('develop');
  });

  it('maps testConfig.parallelDelay to SFDT_PARALLEL_DELAY only when defined', () => {
    expect(buildScriptEnv({ testConfig: {} })).not.toHaveProperty('SFDT_PARALLEL_DELAY');
    expect(buildScriptEnv({ testConfig: { parallelDelay: 0 } }).SFDT_PARALLEL_DELAY).toBe('0');
    expect(buildScriptEnv({ testConfig: { parallelDelay: 5 } }).SFDT_PARALLEL_DELAY).toBe('5');
  });

  it('lets user-exported SFDT_DEFAULT_BRANCH and SFDT_PARALLEL_DELAY win over config', () => {
    process.env.SFDT_DEFAULT_BRANCH = 'release';
    process.env.SFDT_PARALLEL_DELAY = '9';
    try {
      const env = buildScriptEnv({ defaultBranch: 'develop', testConfig: { parallelDelay: 5 } });
      expect(env.SFDT_DEFAULT_BRANCH).toBe('release');
      expect(env).not.toHaveProperty('SFDT_PARALLEL_DELAY');
    } finally {
      delete process.env.SFDT_DEFAULT_BRANCH;
      delete process.env.SFDT_PARALLEL_DELAY;
    }
  });

  it('serializes packageDirectories paths as a JSON array', () => {
    const env = buildScriptEnv({
      packageDirectories: [{ path: 'force-app/main/default' }, { path: 'force-app/mkt' }],
    });
    expect(JSON.parse(env.SFDT_PACKAGE_DIRS)).toEqual(['force-app/main/default', 'force-app/mkt']);
  });
});

describe('runScript', () => {
  const config = { _projectRoot: '/proj', defaultOrg: 'dev' };

  it('throws when the script does not exist', async () => {
    fs.pathExists.mockResolvedValue(false);
    await expect(runScript('ops/missing.sh', config)).rejects.toThrow('Script not found');
    expect(execa).not.toHaveBeenCalled();
  });

  it('runs the script with SFDT_ env vars and project root cwd', async () => {
    await runScript('ops/preflight.sh', config, { env: { SFDT_TARGET_ORG: 'qa' } });

    expect(fs.chmod).toHaveBeenCalled();
    const [scriptPath, args, opts] = execa.mock.calls[0];
    expect(scriptPath).toMatch(/scripts\/ops\/preflight\.sh$/);
    expect(args).toEqual([]);
    expect(opts.cwd).toBe('/proj');
    expect(opts.env.SFDT_PROJECT_ROOT).toBe('/proj');
    expect(opts.env.SFDT_DEFAULT_ORG).toBe('dev');
    expect(opts.env.SFDT_TARGET_ORG).toBe('qa');
  });

  it('throws with exit code and output attached on non-zero exit', async () => {
    execa.mockResolvedValue({ exitCode: 3, stdout: 'partial', stderr: 'boom' });

    const err = await runScript('ops/preflight.sh', config).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('exited with code 3');
    expect(err.exitCode).toBe(3);
    expect(err.stdout).toBe('partial');
    expect(err.stderr).toBe('boom');
  });

  it('dry-run does not execute or chmod anything', async () => {
    const result = await runScript('ops/preflight.sh', config, { dryRun: true });
    expect(result.exitCode).toBe(0);
    expect(execa).not.toHaveBeenCalled();
    expect(fs.chmod).not.toHaveBeenCalled();
  });
});
