import { describe, it, expect } from 'vitest';
import {
  _apexAnonymousTestApi,
  type ExecuteAnonymousResult,
} from '../features/apex-anonymous.js';

const { summariseResult } = _apexAnonymousTestApi();

function result(overrides: Partial<ExecuteAnonymousResult>): ExecuteAnonymousResult {
  return {
    compiled: true,
    compileProblem: null,
    success: true,
    line: -1,
    column: -1,
    exceptionMessage: null,
    exceptionStackTrace: null,
    ...overrides,
  };
}

describe('apex-anonymous — summariseResult', () => {
  it('reports success when compiled and executed', () => {
    expect(summariseResult(result({}))).toEqual({
      ok: true,
      message: 'Compiled and executed successfully.',
    });
  });

  it('reports compile errors with line/column', () => {
    const s = summariseResult(
      result({ compiled: false, success: false, line: 3, column: 7, compileProblem: 'Unexpected token' }),
    );
    expect(s.ok).toBe(false);
    expect(s.message).toContain('line 3');
    expect(s.message).toContain('col 7');
    expect(s.message).toContain('Unexpected token');
  });

  it('reports runtime exceptions', () => {
    const s = summariseResult(
      result({ success: false, exceptionMessage: 'System.NullPointerException' }),
    );
    expect(s.ok).toBe(false);
    expect(s.message).toContain('System.NullPointerException');
  });
});
