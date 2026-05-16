import { describe, it, expect } from 'vitest';
import { buildIssueFamilies, calculateScore, getScoreRating } from '../src/scorer.js';
import type { Finding, Severity } from '../src/types.js';
let counter = 0;
function f(
  family: string,
  severity: Severity,
  overrides: Partial<Finding> = {},
): Finding {
  counter += 1;
  return {
    id: `f-${counter}`,
    ruleId: overrides.ruleId ?? `RULE_${family.toUpperCase()}`,
    scoreFamily: family,
    title: family,
    severity,
    category: overrides.category ?? 'maintainability',
    confidence: 'high',
    message: '',
    ...overrides,
  };
}
describe('flow-core/scorer', () => {
  describe('calculateScore — empty input', () => {
    it('scores a clean flow at 100 / Excellent', () => {
      const result = calculateScore([]);
      expect(result.overallScore).toBe(100);
      expect(result.rating).toBe('Excellent');
      expect(result.severityCounts).toEqual({ high: 0, medium: 0, low: 0, info: 0 });
    });
  });
  describe('buildIssueFamilies — grouping', () => {
    it('groups findings sharing a scoreFamily into one family', () => {
      const families = buildIssueFamilies([
        f('element_descriptions', 'low'),
        f('element_descriptions', 'low'),
        f('element_descriptions', 'low'),
      ]);
      expect(families).toHaveLength(1);
      expect(families[0]!.instanceCount).toBe(3);
    });
    it('keeps separate families distinct', () => {
      const families = buildIssueFamilies([
        f('element_descriptions', 'low'),
        f('flow_description', 'low'),
      ]);
      expect(families).toHaveLength(2);
    });
    it('falls back to ruleId when scoreFamily is missing', () => {
      const findings = [f('', 'low', { ruleId: 'CUSTOM_RULE' })];
      const families = buildIssueFamilies(findings);
      expect(families[0]!.scoreFamily).toBe('CUSTOM_RULE');
    });
    it('a family with mixed severities reports the worst-case severity', () => {
      const families = buildIssueFamilies([
        f('hard_coded_ids', 'low'),
        f('hard_coded_ids', 'high'),
        f('hard_coded_ids', 'medium'),
      ]);
      expect(families[0]!.severity).toBe('high');
    });
    it('uses the worst-severity category, not the first-seen category', () => {
      const families = buildIssueFamilies([
        f('hard_coded_ids', 'low', { category: 'maintainability' }),
        f('hard_coded_ids', 'high', { category: 'reliability' }),
      ]);
      expect(families[0]!.category).toBe('reliability');
    });
    it('sorts families by descending severity, then title ascending', () => {
      const families = buildIssueFamilies([
        f('flow_description', 'low'),
        f('hard_coded_ids', 'high'),
        f('dml_inside_loops', 'high'),
        f('outdated_api_version', 'medium'),
      ]);
      expect(families.map((g) => g.severity)).toEqual(['high', 'high', 'medium', 'low']);
      expect(families[0]!.title).toBe('DML inside loops');
      expect(families[1]!.title).toBe('Possible hard-coded Salesforce IDs found');
    });
  });
  describe('scoring formula — per-severity behaviour', () => {
    it('high severity, 1 instance: deduction = 1.5 + 5.5*log2(2) = 7.0', () => {
      const families = buildIssueFamilies([f('hard_coded_ids', 'high')]);
      expect(families[0]!.scoreImpact).toBeCloseTo(7.0, 1);
    });
    it('medium severity, 1 instance: deduction = 0.5 + 3*log2(2) = 3.5', () => {
      const families = buildIssueFamilies([f('outdated_api_version', 'medium')]);
      expect(families[0]!.scoreImpact).toBeCloseTo(3.5, 1);
    });
    it('low severity, 1 instance: deduction = 0 + 1*log2(2) = 1.0', () => {
      const families = buildIssueFamilies([f('element_descriptions', 'low')]);
      expect(families[0]!.scoreImpact).toBeCloseTo(1.0, 1);
    });
    it('info severity contributes zero deduction', () => {
      const families = buildIssueFamilies([f('info_family', 'info')]);
      expect(families[0]!.scoreImpact).toBe(0);
    });
    it('high severity caps at 22 even with very large instanceCount', () => {
      const findings = Array.from({ length: 1000 }, () => f('hard_coded_ids', 'high'));
      const families = buildIssueFamilies(findings);
      expect(families[0]!.scoreImpact).toBe(22);
    });
    it('medium severity caps at 13', () => {
      const findings = Array.from({ length: 1000 }, () => f('outdated_api_version', 'medium'));
      const families = buildIssueFamilies(findings);
      expect(families[0]!.scoreImpact).toBe(13);
    });
    it('low severity caps at 6', () => {
      const findings = Array.from({ length: 1000 }, () => f('element_descriptions', 'low'));
      const families = buildIssueFamilies(findings);
      expect(families[0]!.scoreImpact).toBe(6);
    });
  });
  describe('calculateScore — totals and floors', () => {
    it('subtracts each family deduction from 100', () => {
      const families = buildIssueFamilies([
        f('a', 'low'),
        f('b', 'low'),
      ]);
      const result = calculateScore(families);
      expect(result.overallScore).toBe(98);
    });
    it('floors at 0 when deductions exceed 100', () => {
      const findings: Finding[] = [];
      for (let i = 0; i < 10; i += 1) {
        for (let j = 0; j < 1000; j += 1) {
          findings.push(f(`fam_${i}`, 'high'));
        }
      }
      const families = buildIssueFamilies(findings);
      const result = calculateScore(families);
      expect(result.overallScore).toBe(0);
      expect(result.rating).toBe('Very Poor');
    });
    it('matches the CHANGELOG-v2.0.0.md "Account Verification Flow" band', () => {
      const findings: Finding[] = [
        ...Array.from({ length: 30 }, () => f('hard_coded_ids', 'high')),
        ...Array.from({ length: 25 }, () => f('dml_inside_loops', 'high')),
        ...Array.from({ length: 8 }, () => f('outdated_api_version', 'medium')),
      ];
      const families = buildIssueFamilies(findings);
      const result = calculateScore(families);
      expect(result.overallScore).toBeGreaterThanOrEqual(40);
      expect(result.overallScore).toBeLessThanOrEqual(55);
    });
  });
  describe('getScoreRating — band thresholds', () => {
    it.each([
      [100, 'Excellent'],
      [90, 'Excellent'],
      [89, 'Very Good'],
      [80, 'Very Good'],
      [79, 'Good'],
      [70, 'Good'],
      [69, 'Poor'],
      [55, 'Poor'],
      [54, 'Very Poor'],
      [0, 'Very Poor'],
    ])('score=%i → %s', (score, rating) => {
      expect(getScoreRating(score)).toBe(rating);
    });
  });
  describe('affected items', () => {
    it('dedupes affected items within a family', () => {
      const findings: Finding[] = [
        f('element_descriptions', 'low', {
          location: { elementLabel: 'GetAccount', elementApiName: 'GetAccount' },
        }),
        f('element_descriptions', 'low', {
          location: { elementLabel: 'GetAccount', elementApiName: 'GetAccount' },
        }),
        f('element_descriptions', 'low', {
          location: { elementLabel: 'UpdateAccount', elementApiName: 'UpdateAccount' },
        }),
      ];
      const families = buildIssueFamilies(findings);
      expect(families[0]!.affectedItems).toHaveLength(2);
    });
    it('extracts dependency-shaped affected items from metadata', () => {
      const findings = [
        f('custom_apex_dependencies', 'low', {
          metadata: { dependencyName: 'MyApex.cls' },
        }),
      ];
      const families = buildIssueFamilies(findings);
      expect(families[0]!.affectedItems[0]).toEqual({
        type: 'dependency',
        label: 'MyApex.cls',
        apiName: null,
      });
    });
  });
  describe('counts', () => {
    it('counts families per severity (not findings)', () => {
      const families = buildIssueFamilies([
        f('a', 'high'),
        f('a', 'high'),
        f('b', 'medium'),
        f('c', 'low'),
        f('d', 'low'),
      ]);
      const result = calculateScore(families);
      expect(result.severityCounts).toEqual({ high: 1, medium: 1, low: 2, info: 0 });
    });
  });
});
