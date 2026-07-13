import { describe, it, expect } from 'vitest';
import {
  buildLogicTestArgs,
  detectZeroTests,
  LOGIC_TEST_LEVELS,
  LOGIC_TEST_CATEGORIES,
} from '../../src/lib/logic-test.js';

describe('buildLogicTestArgs', () => {
  it('builds a minimal run with the required org and a default 30-minute wait', () => {
    expect(buildLogicTestArgs({}, 'dev')).toEqual([
      'logic', 'run', 'test', '--target-org', 'dev', '--wait', '30',
    ]);
  });

  it('throws when no org is resolved', () => {
    expect(() => buildLogicTestArgs({}, undefined)).toThrow(/No org specified/);
    expect(() => buildLogicTestArgs({}, '')).toThrow(/No org specified/);
  });

  it('honours an explicit valid --wait', () => {
    expect(buildLogicTestArgs({ wait: '5' }, 'dev')).toContain('5');
    const args = buildLogicTestArgs({ wait: 120 }, 'dev');
    expect(args[args.indexOf('--wait') + 1]).toBe('120');
  });

  it('rejects non-integer, zero, and negative --wait values', () => {
    for (const wait of ['0', 0, '-5', '2.5', 'abc', '10m', ' 5']) {
      expect(() => buildLogicTestArgs({ wait }, 'dev'), `wait=${JSON.stringify(wait)}`)
        .toThrow(/Invalid --wait/);
    }
  });

  it('appends test level, tests, category, and code-coverage when provided', () => {
    const args = buildLogicTestArgs(
      { testLevel: 'RunSpecifiedTests', tests: 'FooTest,FlowTesting.MyFlow', category: 'Flow', codeCoverage: true },
      'dev',
    );
    expect(args).toEqual([
      'logic', 'run', 'test', '--target-org', 'dev', '--wait', '30',
      '--test-level', 'RunSpecifiedTests',
      '--tests', 'FooTest,FlowTesting.MyFlow',
      '--test-category', 'Flow',
      '--code-coverage',
    ]);
  });

  it('passes a comma-separated --tests value through verbatim (no splitting)', () => {
    const args = buildLogicTestArgs({ tests: 'A,FlowTesting.B,C' }, 'dev');
    expect(args[args.indexOf('--tests') + 1]).toBe('A,FlowTesting.B,C');
  });

  it('rejects an invalid test level', () => {
    expect(() => buildLogicTestArgs({ testLevel: 'RunAllTests' }, 'dev')).toThrow(/Invalid --test-level/);
    // every advertised level is accepted
    for (const level of LOGIC_TEST_LEVELS) {
      expect(() => buildLogicTestArgs({ testLevel: level }, 'dev')).not.toThrow();
    }
  });

  it('rejects an invalid category', () => {
    expect(() => buildLogicTestArgs({ category: 'Trigger' }, 'dev')).toThrow(/Invalid --category/);
    for (const cat of LOGIC_TEST_CATEGORIES) {
      expect(() => buildLogicTestArgs({ category: cat }, 'dev')).not.toThrow();
    }
  });
});

describe('detectZeroTests', () => {
  it('flags the human summary table and JSON summary when zero tests ran', () => {
    expect(detectZeroTests('=== Test Summary\nTests Ran        0\nPassing          0')).toBe(true);
    expect(detectZeroTests('Tests Ran: 0')).toBe(true);
    expect(detectZeroTests('Tests Ran | 0 |')).toBe(true);
    expect(detectZeroTests('{"summary":{"testsRan": 0,"passing":0}}')).toBe(true);
  });

  it('does not flag runs that executed tests', () => {
    expect(detectZeroTests('Tests Ran        10\nPassing          10')).toBe(false);
    expect(detectZeroTests('Tests Ran: 20')).toBe(false);
    expect(detectZeroTests('{"summary":{"testsRan": 105}}')).toBe(false);
  });

  it('returns false for empty or unrecognized output (never a false failure)', () => {
    expect(detectZeroTests('')).toBe(false);
    expect(detectZeroTests(undefined)).toBe(false);
    expect(detectZeroTests('Run completed.')).toBe(false);
  });
});
