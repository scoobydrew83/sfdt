import { describe, it, expect } from 'vitest';
import { ExitCode, resolveExitCode } from '../src/lib/exit-codes.js';

describe('ExitCode constants', () => {
  it('defines SUCCESS as 0', () => {
    expect(ExitCode.SUCCESS).toBe(0);
  });

  it('defines ERROR as 1', () => {
    expect(ExitCode.ERROR).toBe(1);
  });

  it('defines CONFIG_ERROR as 2', () => {
    expect(ExitCode.CONFIG_ERROR).toBe(2);
  });

  it('defines CONNECT_ERROR as 3', () => {
    expect(ExitCode.CONNECT_ERROR).toBe(3);
  });
});

describe('resolveExitCode', () => {
  it('returns ERROR for null', () => {
    expect(resolveExitCode(null)).toBe(ExitCode.ERROR);
  });

  it('returns ERROR for undefined', () => {
    expect(resolveExitCode(undefined)).toBe(ExitCode.ERROR);
  });

  it('returns ERROR for a generic Error', () => {
    expect(resolveExitCode(new Error('something went wrong'))).toBe(ExitCode.ERROR);
  });

  it('returns CONFIG_ERROR for an error named ConfigError', () => {
    const err = new Error('bad config');
    err.name = 'ConfigError';
    expect(resolveExitCode(err)).toBe(ExitCode.CONFIG_ERROR);
  });

  it('returns CONFIG_ERROR when err.exitCode is 2', () => {
    const err = new Error('config missing');
    err.exitCode = 2;
    expect(resolveExitCode(err)).toBe(ExitCode.CONFIG_ERROR);
  });

  it('returns CONNECT_ERROR for ECONNREFUSED in message', () => {
    expect(resolveExitCode(new Error('connect ECONNREFUSED 127.0.0.1:8080'))).toBe(
      ExitCode.CONNECT_ERROR,
    );
  });

  it('returns CONNECT_ERROR for ETIMEDOUT in message', () => {
    expect(resolveExitCode(new Error('ETIMEDOUT'))).toBe(ExitCode.CONNECT_ERROR);
  });

  it('returns CONNECT_ERROR for ENOTFOUND in message', () => {
    expect(resolveExitCode(new Error('getaddrinfo ENOTFOUND login.salesforce.com'))).toBe(
      ExitCode.CONNECT_ERROR,
    );
  });

  it('returns CONNECT_ERROR for "No authorized org" in message', () => {
    expect(resolveExitCode(new Error('No authorized org found'))).toBe(ExitCode.CONNECT_ERROR);
  });

  it('returns CONNECT_ERROR for "NamedOrgNotFound" in message', () => {
    expect(resolveExitCode(new Error('NamedOrgNotFound: my-org'))).toBe(ExitCode.CONNECT_ERROR);
  });

  it('returns CONNECT_ERROR for connectivity keyword in stderr', () => {
    const err = new Error('Script exited');
    err.stderr = 'Failed to refresh auth token';
    expect(resolveExitCode(err)).toBe(ExitCode.CONNECT_ERROR);
  });

  it('returns CONNECT_ERROR for "socket hang up" in message', () => {
    expect(resolveExitCode(new Error('socket hang up'))).toBe(ExitCode.CONNECT_ERROR);
  });

  it('returns CONNECT_ERROR for expired access token message', () => {
    expect(resolveExitCode(new Error('expired access/refresh token'))).toBe(ExitCode.CONNECT_ERROR);
  });

  it('CONFIG_ERROR takes priority over connectivity patterns', () => {
    const err = new Error('config ECONNREFUSED');
    err.name = 'ConfigError';
    expect(resolveExitCode(err)).toBe(ExitCode.CONFIG_ERROR);
  });
});
