import { describe, it, expect } from 'vitest';
import {
  buildAgentTestArgs,
  parseThreshold,
  computePassRate,
  parseAgentTestResult,
} from '../../src/lib/agent-test.js';

describe('buildAgentTestArgs', () => {
  it('builds a run with the required spec + org and a default 30-minute wait', () => {
    expect(buildAgentTestArgs({ spec: 'MyAgentTest' }, 'dev')).toEqual([
      'agent', 'test', 'run', '--api-name', 'MyAgentTest', '--target-org', 'dev', '--wait', '30', '--json',
    ]);
  });

  it('throws when no org is resolved', () => {
    expect(() => buildAgentTestArgs({ spec: 'X' }, undefined)).toThrow(/No org specified/);
    expect(() => buildAgentTestArgs({ spec: 'X' }, '')).toThrow(/No org specified/);
  });

  it('throws when no spec is given', () => {
    expect(() => buildAgentTestArgs({}, 'dev')).toThrow(/--spec .* is required/);
  });

  it('honours an explicit positive --wait', () => {
    const args = buildAgentTestArgs({ spec: 'X', wait: '5' }, 'dev');
    expect(args[args.indexOf('--wait') + 1]).toBe('5');
  });

  it('rejects a --wait that would defeat the gate (0, negative, or non-integer)', () => {
    expect(() => buildAgentTestArgs({ spec: 'X', wait: 0 }, 'dev')).toThrow(/must be a whole number of minutes >= 1/);
    expect(() => buildAgentTestArgs({ spec: 'X', wait: '0' }, 'dev')).toThrow(/defeat the CI gate/);
    expect(() => buildAgentTestArgs({ spec: 'X', wait: '-5' }, 'dev')).toThrow(/>= 1/);
    expect(() => buildAgentTestArgs({ spec: 'X', wait: '2.5' }, 'dev')).toThrow(/whole number/);
  });
});

describe('parseThreshold', () => {
  it('returns null when unset (exit-code gate stays authoritative)', () => {
    expect(parseThreshold(undefined)).toBeNull();
    expect(parseThreshold('')).toBeNull();
  });

  it('accepts a percentage 0-100', () => {
    expect(parseThreshold('80')).toBe(80);
    expect(parseThreshold(0)).toBe(0);
    expect(parseThreshold('100')).toBe(100);
  });

  it('rejects out-of-range or non-numeric values', () => {
    expect(() => parseThreshold('-1')).toThrow(/between 0 and 100/);
    expect(() => parseThreshold('101')).toThrow(/between 0 and 100/);
    expect(() => parseThreshold('abc')).toThrow(/between 0 and 100/);
  });
});

describe('computePassRate', () => {
  // Field names pinned from salesforcecli/plugin-agent handleTestResults.ts.
  it('grades the new Agentforce Studio shape (testScorerResults[].scorerResponse)', () => {
    const result = {
      status: 'COMPLETED',
      testCases: [
        { testScorerResults: [{ scorerResponse: '{"status":"PASS"}' }, { scorerResponse: '{"status":"PASS"}' }] },
        { testScorerResults: [{ scorerResponse: '{"status":"PASS"}' }, { scorerResponse: '{"status":"FAIL"}' }] },
      ],
    };
    expect(computePassRate(result)).toEqual({ total: 2, passed: 1, rate: 50 });
  });

  it('grades the legacy shape (testResults[].result)', () => {
    const result = {
      subjectName: 'MyBot',
      testCases: [
        { testResults: [{ result: 'PASS' }, { result: 'PASS' }] },
        { testResults: [{ result: 'PASS' }, { result: 'PASS' }] },
        { testResults: [{ result: 'PASS' }, { result: 'FAIL' }] },
        { testResults: [{ result: 'PASS' }, { result: 'PASS' }] },
      ],
    };
    expect(computePassRate(result)).toEqual({ total: 4, passed: 3, rate: 75 });
  });

  it('treats an unparseable scorer as not-passing rather than crashing', () => {
    const result = { testCases: [{ testScorerResults: [{ scorerResponse: 'not json' }] }] };
    expect(computePassRate(result)).toEqual({ total: 1, passed: 0, rate: 0 });
  });

  it('returns null when there are no recognisable test cases', () => {
    expect(computePassRate({})).toBeNull();
    expect(computePassRate({ testCases: [] })).toBeNull();
    expect(computePassRate(null)).toBeNull();
  });
});

describe('parseAgentTestResult', () => {
  it('unwraps the sf --json envelope (.result)', () => {
    const stdout = JSON.stringify({ status: 0, result: { testCases: [] }, warnings: [] });
    expect(parseAgentTestResult(stdout)).toEqual({ testCases: [] });
  });

  it('returns null for non-JSON stdout', () => {
    expect(parseAgentTestResult('Deploying...\nDone')).toBeNull();
    expect(parseAgentTestResult('')).toBeNull();
    expect(parseAgentTestResult(undefined)).toBeNull();
  });
});
