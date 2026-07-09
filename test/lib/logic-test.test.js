import { describe, it, expect } from 'vitest';
import { buildLogicTestArgs, LOGIC_TEST_LEVELS, LOGIC_TEST_CATEGORIES } from '../../src/lib/logic-test.js';

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

  it('honours an explicit --wait (including 0)', () => {
    expect(buildLogicTestArgs({ wait: '5' }, 'dev')).toContain('5');
    // 0 is a legitimate caller-provided value, not "unset".
    const args = buildLogicTestArgs({ wait: 0 }, 'dev');
    expect(args[args.indexOf('--wait') + 1]).toBe('0');
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
