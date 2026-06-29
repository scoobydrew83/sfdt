import { describe, it, expect } from 'vitest';
import { resolveInitialTheme } from './theme.js';

describe('resolveInitialTheme', () => {
  it('lets the ?theme= param win over saved preference', () => {
    expect(resolveInitialTheme('?theme=light', 'dark')).toBe(false);
    expect(resolveInitialTheme('?theme=dark', 'light')).toBe(true);
  });
  it('falls back to the saved preference when no param', () => {
    expect(resolveInitialTheme('', 'light')).toBe(false);
    expect(resolveInitialTheme('?token=abc', 'dark')).toBe(true);
  });
  it('defaults to dark when neither is set', () => {
    expect(resolveInitialTheme('', null)).toBe(true);
    expect(resolveInitialTheme('?token=abc', null)).toBe(true);
  });
});
