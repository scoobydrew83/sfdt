import { describe, it, expect } from 'vitest';
import { buildAgentTestArgs } from '../../src/lib/agent-test.js';

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
