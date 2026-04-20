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

  it('throws ConfigError when defaultOrg is empty string', () => {
    expect(() => validateConfig({ defaultOrg: '', features: {} })).toThrow(
      '"defaultOrg" must be a non-empty string',
    );
  });

  it('throws ConfigError when defaultOrg is whitespace', () => {
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
