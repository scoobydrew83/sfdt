import { describe, it, expect } from 'vitest';
import { fuzzyScore, fuzzyScoreFields, stableSortByScore } from '../lib/fuzzy.js';

describe('extension/lib/fuzzy — fuzzyScore', () => {
  it('returns null for no match', () => {
    expect(fuzzyScore('zzz', 'SOQL Runner')).toBeNull();
  });

  it('matches an empty query at a neutral score (show-all)', () => {
    expect(fuzzyScore('', 'anything')).toBe(0);
    expect(fuzzyScore('   ', 'anything')).toBe(0);
  });

  it('is case-insensitive', () => {
    expect(fuzzyScore('soql', 'SOQL Runner')).not.toBeNull();
    expect(fuzzyScore('SOQL', 'soql runner')).not.toBeNull();
  });

  it('ranks exact > prefix > substring > subsequence', () => {
    const exact = fuzzyScore('flow', 'flow')!;
    const prefix = fuzzyScore('flow', 'Flow List Search')!;
    const substring = fuzzyScore('list', 'Flow List Search')!;
    const subsequence = fuzzyScore('fls', 'Flow List Search')!;
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(substring);
    expect(substring).toBeGreaterThan(subsequence);
  });

  it('prefix beats subsequence for the same query', () => {
    // "abc" is a prefix of "abcdef" but only a scattered mid-word subsequence
    // of "xaxbxcx" (a,b,c in order, none at a word boundary).
    const prefix = fuzzyScore('abc', 'abcdef')!;
    const subseq = fuzzyScore('abc', 'xaxbxcx')!;
    expect(prefix).not.toBeNull();
    expect(subseq).not.toBeNull();
    expect(prefix).toBeGreaterThan(subseq);
  });

  it('word-boundary acronyms match (fls -> Flow List Search)', () => {
    expect(fuzzyScore('fls', 'Flow List Search')).not.toBeNull();
    // A word-boundary acronym outranks the same chars as a loose subsequence
    // buried mid-word.
    const acronym = fuzzyScore('fls', 'Flow List Search')!;
    const loose = fuzzyScore('fls', 'baffles')!;
    expect(acronym).toBeGreaterThan(loose);
  });

  it('matches camelCase humps at word boundaries', () => {
    expect(fuzzyScore('ff', 'fooFlow')).not.toBeNull();
  });
});

describe('extension/lib/fuzzy — fuzzyScoreFields', () => {
  it('takes the better of an api-name hit vs a label hit', () => {
    // Query matches the api name as a prefix (strong) and the label loosely.
    const score = fuzzyScoreFields('setup-tabs', 'setup-tabs', 'Setup Tabs')!;
    const labelOnly = fuzzyScore('setup-tabs', 'Setup Tabs');
    const apiOnly = fuzzyScore('setup-tabs', 'setup-tabs')!;
    expect(score).toBe(Math.max(apiOnly, labelOnly ?? -Infinity));
  });

  it('matches when only one field hits', () => {
    expect(fuzzyScoreFields('tabs', 'setup-tabs', undefined)).not.toBeNull();
    expect(fuzzyScoreFields('Tabs', undefined, 'Setup Tabs')).not.toBeNull();
  });

  it('returns null when neither field matches', () => {
    expect(fuzzyScoreFields('zzz', 'setup-tabs', 'Setup Tabs')).toBeNull();
  });

  it('skips null/undefined keys', () => {
    expect(fuzzyScoreFields('tabs', null, undefined, 'Setup Tabs')).not.toBeNull();
  });
});

describe('extension/lib/fuzzy — stableSortByScore', () => {
  it('sorts descending by score', () => {
    const items = [
      { name: 'a', s: 1 },
      { name: 'b', s: 3 },
      { name: 'c', s: 2 },
    ];
    expect(stableSortByScore(items, (x) => x.s).map((x) => x.name)).toEqual(['b', 'c', 'a']);
  });

  it('preserves input order for equal scores (stable)', () => {
    const items = [
      { name: 'first', s: 5 },
      { name: 'second', s: 5 },
      { name: 'third', s: 5 },
      { name: 'low', s: 1 },
    ];
    expect(stableSortByScore(items, (x) => x.s).map((x) => x.name)).toEqual([
      'first',
      'second',
      'third',
      'low',
    ]);
  });
});
