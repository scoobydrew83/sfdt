import { describe, it, expect } from 'vitest';
import { buildScriptEnv } from '../../src/lib/script-runner.js';

const config = {
  _projectRoot: '/tmp/test-project',
  _configDir: '/tmp/test-project/.sfdt',
  projectName: 'Test Project',
  defaultOrg: 'test-org',
  defaultSourcePath: 'force-app/main/default',
  manifestDir: 'manifest/release',
  releaseNotesDir: 'release-notes',
  sourceApiVersion: '61.0',
  logDir: '/tmp/sfdt-logs',
  deployment: { coverageThreshold: 80 },
  features: { ai: false, advancedDeploy: true },
  environments: {
    default: 'staging',
    orgs: [{ alias: 'staging' }, { alias: 'production' }],
  },
  testConfig: {
    coverageThreshold: 80,
    testLevel: 'RunSpecifiedTests',
    suites: ['MySuite'],
    testClasses: ['AccountServiceTest', 'OpportunityHandlerTest'],
    apexClasses: ['AccountService', 'OpportunityHandler'],
  },
};

describe('buildScriptEnv integration', () => {
  const env = buildScriptEnv(config);

  it('maps SFDT_PROJECT_ROOT', () => {
    expect(env.SFDT_PROJECT_ROOT).toBe('/tmp/test-project');
  });

  it('maps SFDT_CONFIG_DIR', () => {
    expect(env.SFDT_CONFIG_DIR).toBe('/tmp/test-project/.sfdt');
  });

  it('maps SFDT_PROJECT_NAME', () => {
    expect(env.SFDT_PROJECT_NAME).toBe('Test Project');
  });

  it('maps SFDT_DEFAULT_ORG', () => {
    expect(env.SFDT_DEFAULT_ORG).toBe('test-org');
  });

  it('maps SFDT_SOURCE_PATH', () => {
    expect(env.SFDT_SOURCE_PATH).toBe('force-app/main/default');
  });

  it('maps SFDT_MANIFEST_DIR', () => {
    expect(env.SFDT_MANIFEST_DIR).toBe('manifest/release');
  });

  it('maps SFDT_RELEASE_NOTES_DIR', () => {
    expect(env.SFDT_RELEASE_NOTES_DIR).toBe('release-notes');
  });

  it('maps SFDT_API_VERSION', () => {
    expect(env.SFDT_API_VERSION).toBe('61.0');
  });

  it('maps SFDT_COVERAGE_THRESHOLD from deployment config', () => {
    expect(env.SFDT_COVERAGE_THRESHOLD).toBe('80');
  });

  it('maps SFDT_LOG_DIR', () => {
    expect(env.SFDT_LOG_DIR).toBe('/tmp/sfdt-logs');
  });

  it('maps SFDT_FEATURE_AI (false → string "false")', () => {
    expect(env.SFDT_FEATURE_AI).toBe('false');
  });

  it('maps SFDT_FEATURE_ADVANCED_DEPLOY via camelCase → UPPER_SNAKE conversion', () => {
    // advancedDeploy → insert _ before each uppercase letter → advanced_Deploy → toUpperCase → ADVANCED_DEPLOY
    expect(env.SFDT_FEATURE_ADVANCED_DEPLOY).toBe('true');
  });

  it('maps SFDT_DEFAULT_ENV', () => {
    expect(env.SFDT_DEFAULT_ENV).toBe('staging');
  });

  it('maps SFDT_ENV_ORGS as comma-joined aliases', () => {
    expect(env.SFDT_ENV_ORGS).toBe('staging,production');
  });

  it('maps SFDT_TEST_COVERAGE_THRESHOLD', () => {
    expect(env.SFDT_TEST_COVERAGE_THRESHOLD).toBe('80');
  });

  it('maps SFDT_TEST_LEVEL', () => {
    expect(env.SFDT_TEST_LEVEL).toBe('RunSpecifiedTests');
  });

  it('maps SFDT_TEST_SUITES as comma-joined array', () => {
    expect(env.SFDT_TEST_SUITES).toBe('MySuite');
  });

  it('maps SFDT_TEST_CLASSES as comma-joined array', () => {
    expect(env.SFDT_TEST_CLASSES).toBe('AccountServiceTest,OpportunityHandlerTest');
  });

  it('maps SFDT_APEX_CLASSES as comma-joined array', () => {
    expect(env.SFDT_APEX_CLASSES).toBe('AccountService,OpportunityHandler');
  });

it('does NOT set SFDT_NON_INTERACTIVE (that is set by runScript at call time)', () => {
    expect(env.SFDT_NON_INTERACTIVE).toBeUndefined();
  });
});
