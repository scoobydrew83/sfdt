import { describe, it, expect } from 'vitest';
import { validateCustomShortcuts } from '../lib/custom-shortcuts.js';

describe('extension/lib/custom-shortcuts', () => {
  it('trims and returns valid entries', () => {
    expect(
      validateCustomShortcuts([{ name: '  Docs  ', url: '  https://sfdt.dev/  ' }]),
    ).toEqual([{ name: 'Docs', url: 'https://sfdt.dev/' }]);
  });

  it('drops fully-blank rows', () => {
    expect(
      validateCustomShortcuts([
        { name: '', url: '' },
        { name: 'Keep', url: 'https://x.example/' },
      ]),
    ).toEqual([{ name: 'Keep', url: 'https://x.example/' }]);
  });

  it('rejects a duplicate name', () => {
    expect(() =>
      validateCustomShortcuts([
        { name: 'Dup', url: 'https://a.example/' },
        { name: 'Dup', url: 'https://b.example/' },
      ]),
    ).toThrow(/duplicate/i);
  });

  it('rejects a malformed URL', () => {
    expect(() => validateCustomShortcuts([{ name: 'Bad', url: 'not-a-url' }])).toThrow(
      /invalid url/i,
    );
  });

  it('rejects a URL-only row with no name', () => {
    expect(() => validateCustomShortcuts([{ name: '', url: 'https://x.example/' }])).toThrow(
      /needs a name/i,
    );
  });
});
