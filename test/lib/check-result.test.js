import { describe, it, expect } from 'vitest';
import { result, errored, degraded, oneLine, summarize } from '../../src/lib/check-result.js';

describe('check-result', () => {
  it('result builds the normalised check shape', () => {
    expect(result('x', 'X', 'warn', 'sum', [{ a: 1 }])).toEqual({
      id: 'x', title: 'X', status: 'warn', summary: 'sum', findings: [{ a: 1 }],
    });
  });

  it('oneLine flattens newlines and caps length', () => {
    expect(oneLine('a\r\nb\nc')).toBe('a b c');
    expect(oneLine('z'.repeat(500))).toHaveLength(300);
    expect(oneLine(undefined)).toBe('');
  });

  it('errored prefers the sf JSON message from stdout, then stderr, then err.message', () => {
    const fromStdout = errored('a', 'A', { stdout: '{"message":"bad alias"}', message: 'execa noise' });
    expect(fromStdout).toMatchObject({ status: 'error', summary: 'Check failed: bad alias', findings: [] });
    const fromStderr = errored('a', 'A', { stderr: '{"message":"no auth"}', message: 'execa noise' });
    expect(fromStderr.summary).toBe('Check failed: no auth');
    expect(errored('a', 'A', new Error('boom')).summary).toBe('Check failed: boom');
  });

  it('degraded is a warn, never ok or error', () => {
    const r = degraded('m', 'M', new Error('INVALID_TYPE'), 'MFA coverage');
    expect(r.status).toBe('warn');
    expect(r.summary).toBe('MFA coverage unavailable in this org: INVALID_TYPE');
  });

  it('summarize counts each status', () => {
    const rows = ['ok', 'ok', 'warn', 'fail', 'error'].map((status) => ({ status }));
    expect(summarize(rows)).toEqual({ total: 5, ok: 2, warn: 1, fail: 1, error: 1 });
  });
});
