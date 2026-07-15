import { describe, it, expect } from 'vitest';
import {
  SFDT_TOKENS,
  SFDT_TOKENS_DARK,
  SFDT_TOKENS_CSS,
  THEME_ATTR,
} from '../lib/tokens.js';

// WCAG relative-luminance contrast ratio.
function luminance(hex: string): number {
  let h = hex.replace('#', '');
  if (h.length === 3)
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  const [r, g, b] = [0, 2, 4]
    .map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [
    number,
    number,
    number,
  ];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const l1 = luminance(a);
  const l2 = luminance(b);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}
function ratio(map: Record<string, string>, fg: string, bg: string): number {
  const f = map[fg];
  const b = map[bg];
  if (f === undefined || b === undefined) throw new Error(`missing token ${fg}/${bg}`);
  return contrast(f, b);
}

describe('extension/lib/tokens', () => {
  it('light and dark palettes cover exactly the same tokens', () => {
    expect(Object.keys(SFDT_TOKENS_DARK).sort()).toEqual(Object.keys(SFDT_TOKENS).sort());
  });

  it('the foreground alias tokens are byte-identical to their source in LIGHT (light unchanged)', () => {
    // Each split-off foreground token must equal the token it replaced, so P0-1
    // light rendering is preserved exactly.
    expect(SFDT_TOKENS['color-on-accent']).toBe(SFDT_TOKENS['color-surface']);
    expect(SFDT_TOKENS['color-text-strong']).toBe(SFDT_TOKENS['color-brand-deep']);
    expect(SFDT_TOKENS['color-brand-text']).toBe(SFDT_TOKENS['color-brand']);
    expect(SFDT_TOKENS['color-error-text']).toBe(SFDT_TOKENS['color-error']);
    expect(SFDT_TOKENS['color-success-text']).toBe(SFDT_TOKENS['color-success']);
  });

  it('emits a light :root block, an explicit dark block, and an auto media fallback', () => {
    expect(SFDT_TOKENS_CSS).toContain(':root {');
    expect(SFDT_TOKENS_CSS).toContain(`:root[${THEME_ATTR}="dark"] {`);
    expect(SFDT_TOKENS_CSS).toContain('@media (prefers-color-scheme: dark)');
    expect(SFDT_TOKENS_CSS).toContain(`:root:not([${THEME_ATTR}])`);
    // Never emits a raw hex outside the custom-property declarations.
    expect(SFDT_TOKENS_CSS).toContain('--sfdt-color-surface: #fff;');
    expect(SFDT_TOKENS_CSS).toContain('--sfdt-color-surface: #202024;');
  });

  // AC3 — body text ≥ 4.5:1 (normal) / ≥ 3:1 (large), both themes.
  const AA = 4.5;
  describe.each([
    ['LIGHT', SFDT_TOKENS],
    ['DARK', SFDT_TOKENS_DARK],
  ] as const)('WCAG AA on key pairs (%s)', (_name, map) => {
    it('text-on-surface ≥ AA', () => {
      expect(ratio(map, 'color-text', 'color-surface')).toBeGreaterThanOrEqual(AA);
    });
    it('strong-text-on-surface ≥ AA', () => {
      expect(ratio(map, 'color-text-strong', 'color-surface')).toBeGreaterThanOrEqual(AA);
    });
    it('muted-text-on-surface ≥ AA', () => {
      expect(ratio(map, 'color-text-muted', 'color-surface')).toBeGreaterThanOrEqual(AA);
    });
    it('white text on brand button ≥ AA', () => {
      expect(ratio(map, 'color-on-accent', 'color-brand')).toBeGreaterThanOrEqual(AA);
    });
    it('white text on error button ≥ AA', () => {
      expect(ratio(map, 'color-on-accent', 'color-error')).toBeGreaterThanOrEqual(AA);
    });
    it('white text on success button ≥ AA', () => {
      expect(ratio(map, 'color-on-accent', 'color-success')).toBeGreaterThanOrEqual(AA);
    });
    it('error text on surface ≥ AA', () => {
      expect(ratio(map, 'color-error-text', 'color-surface')).toBeGreaterThanOrEqual(AA);
    });
  });
});
