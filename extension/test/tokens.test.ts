import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

// Regression guard for the defect class that hit the shadow host, the Workspace
// host, and the toolbar popup: a saturated FILL token (surface / brand /
// brand-deep) used as a `color:`. It looks fine in light mode — the light values
// of the foreground aliases are byte-identical to the fills they replaced — and
// goes dark-on-dark the moment the dark theme swaps the fill. Use the
// foreground aliases instead: on-accent, brand-text, text-strong.
describe('fill tokens are never used as a foreground', () => {
  const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
  const DIRS = ['ui', 'entrypoints', 'features', 'lib'];

  // Every fill that has a dedicated foreground variant. `info` is deliberately
  // absent — it has no `-text` alias yet, so there is nothing to demand instead.
  // (The v0.8.1 guard listed only surface/brand-deep/brand, which is why
  // `color: var(--sfdt-color-warning)` in the API Version Audit slipped past it.)
  const FILLS = ['surface', 'brand-deep', 'brand', 'error', 'success', 'warning'];
  // A trailing `\)` keeps the `-text` / `-bg-*` variants from matching.
  const FILL_VAR = String.raw`var\(--sfdt-color-(?:${FILLS.join('|')})\)`;
  // `(^|[^-])` so border-color / outline-color / background-color don't match.
  const FILL_AS_FG = new RegExp(String.raw`(^|[^-])color:\s*${FILL_VAR}`);
  // The second hole: `color: ${SOME_CONST}` where the const holds a fill var.
  // Resolve single-line `const X = 'var(--sfdt-color-fill)'` bindings per file.
  const FILL_CONST = new RegExp(String.raw`const\s+(\w+)\s*=\s*['"\`]${FILL_VAR}['"\`]`, 'g');
  const INTERPOLATED_FG = /(^|[^-])color:\s*\$\{(\w+)\}/;

  function tsFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return tsFiles(full);
      return e.isFile() && full.endsWith('.ts') ? [full] : [];
    });
  }

  function scan(source: string): Array<{ line: number; text: string }> {
    const fillConsts = new Set([...source.matchAll(FILL_CONST)].map((m) => m[1]));
    const hits: Array<{ line: number; text: string }> = [];
    source.split('\n').forEach((line, i) => {
      const interpolated = INTERPOLATED_FG.exec(line);
      if (FILL_AS_FG.test(line) || (interpolated && fillConsts.has(interpolated[2])))
        hits.push({ line: i + 1, text: line.trim() });
    });
    return hits;
  }

  it('no source file sets `color:` to a fill token', () => {
    const offenders: string[] = [];
    for (const dir of DIRS) {
      for (const file of tsFiles(path.join(ROOT, dir))) {
        for (const hit of scan(fs.readFileSync(file, 'utf8')))
          offenders.push(`${path.relative(ROOT, file)}:${hit.line}: ${hit.text}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // The guard must actually catch both shapes — a guard that silently matches
  // nothing is worse than no guard, which is how this class escaped four times.
  it('catches a fill token used directly as a foreground', () => {
    expect(scan(`el.style.cssText = 'color: var(--sfdt-color-warning)';`)).toHaveLength(1);
    expect(scan(`el.style.cssText = 'color: var(--sfdt-color-brand)';`)).toHaveLength(1);
  });

  it('catches a fill token reached through a const', () => {
    const source = [
      `const BEHIND = 'var(--sfdt-color-warning)';`,
      'el.style.cssText = `color: ${BEHIND}`;',
    ].join('\n');
    expect(scan(source)).toHaveLength(1);
  });

  it('does not flag foreground variants, fills used as backgrounds, or borders', () => {
    const source = [
      `a.style.cssText = 'color: var(--sfdt-color-warning-text)';`,
      `b.style.cssText = 'background: var(--sfdt-color-warning)';`,
      `c.style.cssText = 'border-color: var(--sfdt-color-brand)';`,
      `d.style.cssText = 'background-color: var(--sfdt-color-surface)';`,
      `const FILL = 'var(--sfdt-color-warning)';`,
      'e.style.cssText = `background: ${FILL}`;',
    ].join('\n');
    expect(scan(source)).toEqual([]);
  });
});
