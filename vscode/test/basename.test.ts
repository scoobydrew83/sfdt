import { describe, it, expect } from 'vitest';
import { basenameWithoutSuffix } from '../src/lib/basename.js';

describe('basenameWithoutSuffix', () => {
  it('strips the suffix from the basename (POSIX + Windows separators)', () => {
    expect(basenameWithoutSuffix('a/b/Foo.cls', '.cls')).toBe('Foo');
    expect(basenameWithoutSuffix('C:\\x\\Bar.cls', '.cls')).toBe('Bar');
    expect(basenameWithoutSuffix('a/Eval.aiEvaluationDefinition-meta.xml', '.aiEvaluationDefinition-meta.xml')).toBe('Eval');
  });

  it('returns null when the basename does not end with the suffix', () => {
    expect(basenameWithoutSuffix('a/Foo.trigger', '.cls')).toBeNull();
  });

  it('returns null for an empty result or empty input', () => {
    expect(basenameWithoutSuffix('.cls', '.cls')).toBeNull();
    expect(basenameWithoutSuffix('', '.cls')).toBeNull();
  });
});
