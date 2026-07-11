import { describe, it, expect } from 'vitest';
import { validateConfig, ConfigError } from '../src/lib/config.js';

describe('ConfigError', () => {
  it('has name ConfigError', () => {
    const err = new ConfigError('bad config');
    expect(err.name).toBe('ConfigError');
  });

  it('has exitCode 2', () => {
    const err = new ConfigError('bad config');
    expect(err.exitCode).toBe(2);
  });

  it('inherits from Error', () => {
    const err = new ConfigError('bad config');
    expect(err).toBeInstanceOf(Error);
  });

  it('preserves the message', () => {
    const err = new ConfigError('something is wrong');
    expect(err.message).toBe('something is wrong');
  });
});

describe('validateConfig — richer error messages', () => {
  it('throws ConfigError (not plain Error) for null', () => {
    expect(() => validateConfig(null)).toThrow(ConfigError);
  });

  it('throws ConfigError for non-object', () => {
    expect(() => validateConfig(42)).toThrow(ConfigError);
  });

  it('throws ConfigError with "missing required keys" message', () => {
    expect(() => validateConfig({})).toThrow('missing required keys: defaultOrg, features');
  });

  it('throws ConfigError only for missing features when defaultOrg present', () => {
    expect(() => validateConfig({ defaultOrg: 'dev' })).toThrow('missing required keys: features');
  });

  it('throws ConfigError when features is not an object', () => {
    expect(() => validateConfig({ defaultOrg: 'dev', features: true })).toThrow(
      '"features" must be an object',
    );
  });

  it('throws ConfigError when defaultOrg is an empty string', () => {
    expect(() => validateConfig({ defaultOrg: '', features: {} })).toThrow(
      '"defaultOrg" must be a non-empty string',
    );
  });

  it('throws ConfigError when defaultOrg is a whitespace string', () => {
    expect(() => validateConfig({ defaultOrg: '   ', features: {} })).toThrow(
      '"defaultOrg" must be a non-empty string',
    );
  });

  it('throws ConfigError when defaultOrg is a number', () => {
    expect(() => validateConfig({ defaultOrg: 123, features: {} })).toThrow(
      '"defaultOrg" must be a non-empty string',
    );
  });

  it('throws ConfigError when coverageThreshold is negative', () => {
    expect(() =>
      validateConfig({ defaultOrg: 'dev', features: {}, deployment: { coverageThreshold: -1 } }),
    ).toThrow('coverageThreshold" must be a number between 0 and 100');
  });

  it('throws ConfigError when coverageThreshold exceeds 100', () => {
    expect(() =>
      validateConfig({ defaultOrg: 'dev', features: {}, deployment: { coverageThreshold: 101 } }),
    ).toThrow('coverageThreshold" must be a number between 0 and 100');
  });

  it('throws ConfigError when coverageThreshold is a string', () => {
    expect(() =>
      validateConfig({ defaultOrg: 'dev', features: {}, deployment: { coverageThreshold: 'high' } }),
    ).toThrow('coverageThreshold" must be a number between 0 and 100');
  });

  it('accepts coverageThreshold of 0', () => {
    expect(() =>
      validateConfig({ defaultOrg: 'dev', features: {}, deployment: { coverageThreshold: 0 } }),
    ).not.toThrow();
  });

  it('accepts coverageThreshold of 100', () => {
    expect(() =>
      validateConfig({ defaultOrg: 'dev', features: {}, deployment: { coverageThreshold: 100 } }),
    ).not.toThrow();
  });

  it('throws ConfigError when environments.orgs is not an array', () => {
    expect(() =>
      validateConfig({
        defaultOrg: 'dev',
        features: {},
        environments: { orgs: 'not-an-array' },
      }),
    ).toThrow('"environments.orgs" must be an array');
  });

  it('accepts environments.orgs as an empty array', () => {
    expect(() =>
      validateConfig({ defaultOrg: 'dev', features: {}, environments: { orgs: [] } }),
    ).not.toThrow();
  });

  it('throws ConfigError when logDir is not a string', () => {
    expect(() =>
      validateConfig({ defaultOrg: 'dev', features: {}, logDir: 42 }),
    ).toThrow('"logDir" must be a string');
  });

  it('accepts logDir as a string', () => {
    expect(() =>
      validateConfig({ defaultOrg: 'dev', features: {}, logDir: '/var/log/sfdt' }),
    ).not.toThrow();
  });

  it('passes with minimal valid config', () => {
    expect(() => validateConfig({ defaultOrg: 'dev', features: {} })).not.toThrow();
  });

  it('passes with full valid config', () => {
    expect(() =>
      validateConfig({
        defaultOrg: 'prod-org',
        features: { ai: true, notifications: false },
        deployment: { coverageThreshold: 80 },
        environments: { orgs: [{ alias: 'prod' }] },
        logDir: 'logs',
      }),
    ).not.toThrow();
  });
});

describe('validateConfig — AJV schema fields', () => {
  it('throws when ai.provider is not a valid enum value', () => {
    expect(() =>
      validateConfig({ defaultOrg: 'dev', features: {}, ai: { provider: 'gpt4' } }),
    ).toThrow('ai.provider');
  });

  it('accepts ai.provider as "claude"', () => {
    expect(() =>
      validateConfig({ defaultOrg: 'dev', features: {}, ai: { provider: 'claude' } }),
    ).not.toThrow();
  });

  it('accepts ai.provider as "gemini"', () => {
    expect(() =>
      validateConfig({ defaultOrg: 'dev', features: {}, ai: { provider: 'gemini' } }),
    ).not.toThrow();
  });

  it('accepts ai.provider as "openai"', () => {
    expect(() =>
      validateConfig({ defaultOrg: 'dev', features: {}, ai: { provider: 'openai' } }),
    ).not.toThrow();
  });

  it('throws when manifestLayout is invalid', () => {
    expect(() =>
      validateConfig({ defaultOrg: 'dev', features: {}, manifestLayout: 'nested' }),
    ).toThrow('manifestLayout');
  });

  it('accepts manifestLayout "flat"', () => {
    expect(() =>
      validateConfig({ defaultOrg: 'dev', features: {}, manifestLayout: 'flat' }),
    ).not.toThrow();
  });

  it('accepts manifestLayout "subpath"', () => {
    expect(() =>
      validateConfig({ defaultOrg: 'dev', features: {}, manifestLayout: 'subpath' }),
    ).not.toThrow();
  });

  it('throws when logRetention is 0', () => {
    expect(() =>
      validateConfig({ defaultOrg: 'dev', features: {}, logRetention: 0 }),
    ).toThrow('logRetention');
  });

  it('throws when logRetention is negative', () => {
    expect(() =>
      validateConfig({ defaultOrg: 'dev', features: {}, logRetention: -5 }),
    ).toThrow('logRetention');
  });

  it('accepts logRetention as 1', () => {
    expect(() =>
      validateConfig({ defaultOrg: 'dev', features: {}, logRetention: 1 }),
    ).not.toThrow();
  });

  it('throws when pullCache.parallelism is 0', () => {
    expect(() =>
      validateConfig({ defaultOrg: 'dev', features: {}, pullCache: { parallelism: 0 } }),
    ).toThrow('parallelism');
  });

  it('throws when deployment.preflight has an unknown key', () => {
    expect(() =>
      validateConfig({
        defaultOrg: 'dev',
        features: {},
        deployment: { preflight: { typoKey: true } },
      }),
    ).toThrow();
  });

  it('accepts a valid notifications block with channels', () => {
    expect(() =>
      validateConfig({
        defaultOrg: 'dev',
        features: {},
        notifications: {
          enabled: true,
          channels: [
            { type: 'slack', name: 'team', webhookUrlEnv: 'SLACK_URL', severityThreshold: 'warn', events: ['snapshot'] },
            { type: 'webhook', url: 'https://example.com/hook', severityThreshold: 'fail', events: ['snapshot'] },
          ],
        },
      }),
    ).not.toThrow();
  });

  it('throws when a notifications channel has an unknown type', () => {
    expect(() =>
      validateConfig({
        defaultOrg: 'dev',
        features: {},
        notifications: { channels: [{ type: 'discord' }] },
      }),
    ).toThrow('notifications');
  });

  it('throws when a notifications channel severityThreshold is invalid', () => {
    expect(() =>
      validateConfig({
        defaultOrg: 'dev',
        features: {},
        notifications: { channels: [{ type: 'slack', severityThreshold: 'critical' }] },
      }),
    ).toThrow();
  });

  it('accepts a notifications.summary block', () => {
    expect(() =>
      validateConfig({
        defaultOrg: 'dev',
        features: {},
        notifications: { enabled: true, summary: { enabled: true }, channels: [] },
      }),
    ).not.toThrow();
  });

  it('throws when notifications.summary has an unknown key', () => {
    expect(() =>
      validateConfig({
        defaultOrg: 'dev',
        features: {},
        notifications: { summary: { enabled: true, typo: 1 } },
      }),
    ).toThrow();
  });

  it('accepts the legacy notifications.slack shape', () => {
    expect(() =>
      validateConfig({
        defaultOrg: 'dev',
        features: {},
        notifications: { enabled: true, slack: { webhookUrl: 'https://hooks.slack.com/x' } },
      }),
    ).not.toThrow();
  });

  it('throws when a notifications channel has an unknown key', () => {
    expect(() =>
      validateConfig({
        defaultOrg: 'dev',
        features: {},
        notifications: { channels: [{ type: 'slack', typo: true }] },
      }),
    ).toThrow();
  });

  it('accepts a valid ai.agent block', () => {
    expect(() =>
      validateConfig({
        defaultOrg: 'dev',
        features: {},
        ai: { provider: 'claude', agent: { enabled: true, maxTurns: 5, allowWrite: false } },
      }),
    ).not.toThrow();
  });

  it('throws when ai.agent.maxTurns exceeds the maximum', () => {
    expect(() =>
      validateConfig({
        defaultOrg: 'dev',
        features: {},
        ai: { agent: { maxTurns: 99 } },
      }),
    ).toThrow();
  });

  it('accepts a valid deployment.smart block', () => {
    expect(() =>
      validateConfig({
        defaultOrg: 'dev',
        features: {},
        deployment: {
          smart: {
            enabled: true,
            deltaBase: 'main',
            noOverwriteManifest: 'manifest/package-no-overwrite.xml',
            impactingTypes: ['ApexClass', 'Flow'],
            downgradeTestsOnNonProd: true,
            assumeProd: false,
          },
        },
      }),
    ).not.toThrow();
  });

  it('throws when deployment.smart has an unknown key', () => {
    expect(() =>
      validateConfig({
        defaultOrg: 'dev',
        features: {},
        deployment: { smart: { typo: true } },
      }),
    ).toThrow();
  });

  it('accepts the new audit and monitoring threshold keys', () => {
    expect(() =>
      validateConfig({
        defaultOrg: 'dev',
        features: {},
        audit: { fieldDescriptionMaxMissing: 0, connectedAppFlagPermissive: true },
        monitoring: { orgInfoTrialWarnDays: 14, deployHistoryLookback: 20, deprecatedApiLookbackDays: 7 },
      }),
    ).not.toThrow();
  });

  it('throws when audit has an unknown threshold key', () => {
    expect(() =>
      validateConfig({
        defaultOrg: 'dev',
        features: {},
        audit: { madeUpThreshold: 5 },
      }),
    ).toThrow();
  });

  it('accepts the ci block with valid values', () => {
    expect(() =>
      validateConfig({
        defaultOrg: 'dev',
        features: {},
        ci: { authMethod: 'jwt', environment: 'uat', runner: 'action' },
      }),
    ).not.toThrow();
  });

  it('rejects an unknown key under ci', () => {
    expect(() =>
      validateConfig({
        defaultOrg: 'dev',
        features: {},
        ci: { madeUpKey: true },
      }),
    ).toThrow();
  });

  it('rejects an invalid ci.authMethod value', () => {
    expect(() =>
      validateConfig({
        defaultOrg: 'dev',
        features: {},
        ci: { authMethod: 'oauth' },
      }),
    ).toThrow();
  });

  it('accepts valid full config from template', () => {
    expect(() =>
      validateConfig({
        defaultOrg: 'prod',
        projectName: 'My SF Project',
        features: { ai: true, notifications: false, releaseManagement: true },
        ai: { provider: 'claude', model: '' },
        deployment: {
          coverageThreshold: 75,
          backupBeforeRollback: true,
          preflight: {
            enforceTests: false,
            enforceBranchNaming: false,
            enforceChangelog: false,
            enforceGitClean: true,
            enforceSfdxProject: true,
            enforceUntrackedFiles: false,
            strict: false,
          },
        },
        manifestLayout: 'flat',
        changelogDir: 'changelogs',
        logRetention: 50,
        plugins: [],
        pluginOptions: { autoDiscover: false },
        pullCache: { enabled: true, parallelism: 5, batchSize: 100, retrieveTimeoutSeconds: 360 },
      }),
    ).not.toThrow();
  });
});
