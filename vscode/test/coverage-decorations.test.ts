import { describe, it, expect } from 'vitest';
import {
  coverageRowsFromResult,
  apexNameFromPath,
  planCoverageDecoration,
  COVERAGE_BAND_STYLE,
  type CoverageClassRow,
} from '../src/lib/coverage-decorations.js';

describe('coverageRowsFromResult', () => {
  it('extracts rows from an sfdt coverage --json result', () => {
    const result = {
      org: 'dev',
      threshold: 75,
      orgWide: 82,
      belowThreshold: false,
      classes: [
        { name: 'AccountService', covered: 90, uncovered: 10, total: 100, pct: 0.9 },
        { name: 'LegacyHelper', covered: 0, uncovered: 0, total: 0, pct: null },
      ],
    };
    expect(coverageRowsFromResult(result)).toEqual([
      { name: 'AccountService', pct: 0.9 },
      { name: 'LegacyHelper', pct: null },
    ]);
  });

  it('drops malformed rows but keeps the rest', () => {
    const rows = coverageRowsFromResult({
      classes: [{ name: 'Ok', pct: 0.5 }, { pct: 0.4 }, null, { name: '', pct: 1 }, { name: 'NoPct' }],
    });
    expect(rows).toEqual([
      { name: 'Ok', pct: 0.5 },
      { name: 'NoPct', pct: null },
    ]);
  });

  it('returns null when the payload is not a coverage result', () => {
    expect(coverageRowsFromResult(null)).toBeNull();
    expect(coverageRowsFromResult({})).toBeNull();
    expect(coverageRowsFromResult({ classes: 'nope' })).toBeNull();
    expect(coverageRowsFromResult('text')).toBeNull();
  });
});

describe('apexNameFromPath', () => {
  it('extracts class and trigger names', () => {
    expect(apexNameFromPath('/proj/force-app/main/default/classes/AccountService.cls')).toBe('AccountService');
    expect(apexNameFromPath('/proj/force-app/main/default/triggers/CaseTrigger.trigger')).toBe('CaseTrigger');
  });

  it('handles Windows separators regardless of host platform', () => {
    expect(apexNameFromPath('C:\\proj\\classes\\AccountService.cls')).toBe('AccountService');
  });

  it('returns null for non-Apex files', () => {
    expect(apexNameFromPath('/proj/classes/AccountService.cls-meta.xml')).toBeNull();
    expect(apexNameFromPath('/proj/lwc/cmp/cmp.js')).toBeNull();
    expect(apexNameFromPath('/proj/README.md')).toBeNull();
    expect(apexNameFromPath('.cls')).toBeNull();
  });
});

describe('planCoverageDecoration', () => {
  const rows: CoverageClassRow[] = [
    { name: 'AccountService', pct: 0.95 },
    { name: 'CaseTrigger', pct: 0.8 },
    { name: 'RiskyThing', pct: 0.4 },
    { name: 'NeverRun', pct: null },
  ];

  it('bands by the shared flow-core thresholds (green ≥90, amber ≥75, red below)', () => {
    expect(planCoverageDecoration('/x/AccountService.cls', rows)?.band).toBe('green');
    expect(planCoverageDecoration('/x/CaseTrigger.trigger', rows)?.band).toBe('amber');
    expect(planCoverageDecoration('/x/RiskyThing.cls', rows)?.band).toBe('red');
    expect(planCoverageDecoration('/x/NeverRun.cls', rows)?.band).toBe('none');
  });

  it('matches class names case-insensitively (Apex names are)', () => {
    const plan = planCoverageDecoration('/x/accountservice.cls', rows);
    expect(plan?.className).toBe('AccountService');
    expect(plan?.pct).toBe(0.95);
  });

  it('builds a human-readable label with the rounded percentage', () => {
    expect(planCoverageDecoration('/x/RiskyThing.cls', rows)?.label).toBe(
      'Apex coverage: RiskyThing — 40% covered',
    );
    expect(planCoverageDecoration('/x/NeverRun.cls', rows)?.label).toBe(
      'Apex coverage: NeverRun — no coverable lines',
    );
  });

  it('returns null for non-Apex files and classes without a coverage row', () => {
    expect(planCoverageDecoration('/x/notes.md', rows)).toBeNull();
    expect(planCoverageDecoration('/x/BrandNew.cls', rows)).toBeNull();
  });
});

describe('COVERAGE_BAND_STYLE', () => {
  it('defines a color and background for every band', () => {
    for (const band of ['green', 'amber', 'red', 'none'] as const) {
      expect(COVERAGE_BAND_STYLE[band].color).toMatch(/^rgba\(/);
      expect(COVERAGE_BAND_STYLE[band].background).toMatch(/^rgba\(/);
    }
  });
});
