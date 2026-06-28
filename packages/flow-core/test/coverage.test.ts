import { describe, it, expect } from 'vitest';
import { shapeClassCoverage, classCoverageBand } from '../src/coverage.js';

describe('classCoverageBand', () => {
  it('bands a fraction: green ≥0.9, amber ≥0.75, red below, none for null', () => {
    expect(classCoverageBand(0.95)).toBe('green');
    expect(classCoverageBand(0.8)).toBe('amber');
    expect(classCoverageBand(0.5)).toBe('red');
    expect(classCoverageBand(null)).toBe('none');
  });
});

describe('shapeClassCoverage', () => {
  it('computes pct/total and sorts worst-first, no-line rows last', () => {
    const out = shapeClassCoverage([
      { ApexClassOrTrigger: { Name: 'Good' }, NumLinesCovered: 95, NumLinesUncovered: 5 },
      { ApexClassOrTrigger: { Name: 'Bad' }, NumLinesCovered: 2, NumLinesUncovered: 8 },
      { ApexClassOrTrigger: { Name: 'Empty' }, NumLinesCovered: 0, NumLinesUncovered: 0 },
    ]);
    expect(out.map((r) => r.name)).toEqual(['Bad', 'Good', 'Empty']);
    expect(out[0]!.pct).toBeCloseTo(0.2);
    expect(out[0]!.total).toBe(10);
    expect(out[2]!.pct).toBeNull();
  });

  it('falls back to (unknown) when the name is missing', () => {
    expect(shapeClassCoverage([{ NumLinesCovered: 1, NumLinesUncovered: 1 }])[0]!.name).toBe('(unknown)');
  });
});
