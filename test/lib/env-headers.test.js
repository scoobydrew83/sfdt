import { describe, it, expect, afterEach } from 'vitest';
import { resolveEnvHeaders } from '../../src/lib/env-headers.js';

// Shared by the notifier's webhook channels and the `http` AI provider. The
// precedence and unset-var semantics are security-relevant in both, so they are
// pinned here once rather than re-asserted per consumer.
describe('resolveEnvHeaders', () => {
  afterEach(() => {
    delete process.env.SFDT_TEST_H1;
    delete process.env.SFDT_TEST_H2;
  });

  it('returns literal headers untouched when no env map is given', () => {
    expect(resolveEnvHeaders({ 'X-Plain': 'literal' })).toEqual({ 'X-Plain': 'literal' });
  });

  it('returns an empty object when both inputs are absent', () => {
    expect(resolveEnvHeaders()).toEqual({});
  });

  it('resolves a header value from the named env var', () => {
    process.env.SFDT_TEST_H1 = 'secret-value';
    expect(resolveEnvHeaders({}, { 'X-Token': 'SFDT_TEST_H1' })).toEqual({ 'X-Token': 'secret-value' });
  });

  it('lets the env-referenced value win over a literal of the same name', () => {
    process.env.SFDT_TEST_H1 = 'from-env';
    const out = resolveEnvHeaders({ 'X-Token': 'from-config' }, { 'X-Token': 'SFDT_TEST_H1' });
    expect(out['X-Token']).toBe('from-env');
  });

  it('merges literal and env-referenced headers side by side', () => {
    process.env.SFDT_TEST_H1 = 'v1';
    const out = resolveEnvHeaders({ 'X-Plain': 'literal' }, { 'X-Token': 'SFDT_TEST_H1' });
    expect(out).toEqual({ 'X-Plain': 'literal', 'X-Token': 'v1' });
  });

  it('throws naming the env var when it is unset', () => {
    expect(() => resolveEnvHeaders({}, { 'X-Token': 'SFDT_TEST_H2' })).toThrow(/SFDT_TEST_H2/);
  });

  it('throws on an empty-string env var rather than sending a blank header', () => {
    process.env.SFDT_TEST_H2 = '';
    expect(() => resolveEnvHeaders({}, { 'X-Token': 'SFDT_TEST_H2' })).toThrow(/SFDT_TEST_H2/);
  });

  it('includes the caller context in the error so the failure names its config block', () => {
    expect(() => resolveEnvHeaders({}, { 'X-Token': 'SFDT_TEST_H2' }, 'ai.headersEnv')).toThrow(
      /ai\.headersEnv/,
    );
  });

  it('never puts the secret value itself in the error message', () => {
    process.env.SFDT_TEST_H1 = 'resolved';
    // Only the *unset* path throws, but assert the shape holds if it ever changes:
    // an error naming a variable must not also echo a sibling's resolved value.
    try {
      resolveEnvHeaders({}, { 'X-Ok': 'SFDT_TEST_H1', 'X-Bad': 'SFDT_TEST_H2' });
      throw new Error('expected a throw');
    } catch (e) {
      expect(e.message).not.toContain('resolved');
    }
  });
});
