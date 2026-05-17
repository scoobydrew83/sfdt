import { describe, it, expect } from 'vitest';
import { diffInventories } from '../../src/lib/org-diff.js';

describe('diffInventories', () => {
  it('marks members only in source as source-only', () => {
    const source = new Map([['ApexClass', new Set(['MyClass'])]]);
    const target = new Map();

    const result = diffInventories(source, target);
    expect(result).toEqual([{ type: 'ApexClass', member: 'MyClass', status: 'source-only' }]);
  });

  it('marks members only in target as target-only', () => {
    const source = new Map();
    const target = new Map([['ApexClass', new Set(['TargetClass'])]]);

    const result = diffInventories(source, target);
    expect(result).toEqual([{ type: 'ApexClass', member: 'TargetClass', status: 'target-only' }]);
  });

  it('marks members in both as both', () => {
    const source = new Map([['ApexClass', new Set(['SharedClass'])]]);
    const target = new Map([['ApexClass', new Set(['SharedClass'])]]);

    const result = diffInventories(source, target);
    expect(result).toEqual([{ type: 'ApexClass', member: 'SharedClass', status: 'both' }]);
  });

  it('handles mixed statuses across types', () => {
    const source = new Map([
      ['ApexClass', new Set(['A', 'B'])],
      ['Flow', new Set(['F1'])],
    ]);
    const target = new Map([
      ['ApexClass', new Set(['B', 'C'])],
    ]);

    const result = diffInventories(source, target);
    const byKey = Object.fromEntries(result.map((r) => [`${r.type}.${r.member}`, r.status]));

    expect(byKey['ApexClass.A']).toBe('source-only');
    expect(byKey['ApexClass.B']).toBe('both');
    expect(byKey['ApexClass.C']).toBe('target-only');
    expect(byKey['Flow.F1']).toBe('source-only');
  });

  it('returns results sorted by type then member', () => {
    const source = new Map([['ApexClass', new Set(['Z', 'A'])]]);
    const target = new Map();

    const result = diffInventories(source, target);
    expect(result.map((r) => r.member)).toEqual(['A', 'Z']);
  });

  it('returns empty array when both inventories are empty', () => {
    expect(diffInventories(new Map(), new Map())).toEqual([]);
  });
});
