import { describe, it, expect } from 'vitest';
import { SFDT_COMPONENT_CSS } from '../lib/ui-styles.js';
import { HOST_STYLES } from '../ui/workspace-host.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Three surfaces inject a page-local stylesheet ALONGSIDE the shared component
// sheet: the Workspace/side-panel host, the toolbar popup, and the options
// page. Each one legitimately owns its own chrome — an app bar, a tab strip, a
// 360px popup shell — and none of that belongs in a sheet destined for
// injection onto a live Salesforce page.
//
// What does NOT belong in them is a second definition of a `.sfdt-*` COMPONENT.
// Both sheets land in the same document, the page-local one is concatenated
// last, so it silently wins by load order — and the component quietly means
// something different on the Workspace than it does in an injected modal, with
// nothing to catch it. That is strictly worse than an inline style, which is at
// least visibly local.
//
// This shipped: `#sfdt-topbar button { … }` re-declared the entire button
// (padding, radius, background, colour, cursor) so the app bar's icon buttons
// drifted from every other icon button in the product, and the audit could not
// see it because it was a rule in a template literal, not a cssText assignment.
//
// Golden principle #12 — the check excludes the artifacts that define it: this
// file is not scanned, and neither is lib/ui-styles.ts.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/**
 * Strip CSS comments before parsing.
 *
 * Not optional: these sheets are heavily commented, and a comment sits exactly
 * where a selector does — immediately before a `{`. Without this the guard
 * reports the PROSE as an offender, which is how its first run produced four
 * findings that were all sentences mentioning `.sfdt-btn`.
 */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Every `.sfdt-*` class name a stylesheet DEFINES a rule for. */
function definedClasses(css: string): Set<string> {
  const out = new Set<string>();
  // Selector list = everything before a `{`, minus at-rule preludes and the
  // insides of a declaration block.
  for (const rule of stripComments(css).matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selector = rule[1]!;
    if (selector.trim().startsWith('@')) continue;
    for (const cls of selector.matchAll(/\.(sfdt-[\w-]+)/g)) out.add(cls[1]!);
  }
  return out;
}

const COMPONENT_CLASSES = definedClasses(SFDT_COMPONENT_CSS);

/**
 * A page sheet's `.sfdt-*` rules, minus the ones that are explicitly scoped to
 * that page.
 *
 * A page-scoped rule — `#sfdt-topbar .sfdt-btn { gap: 6px }` or
 * `[data-sfdt-surface='panel'] .sfdt-tile { … }` — is a legitimate override:
 * it cannot leak, it reads as an override at the call site, and it is how a
 * surface adapts a shared component without forking it. A BARE
 * `.sfdt-btn { … }` in a page sheet is the redefinition this guard is for.
 */
function unscopedComponentRules(css: string): string[] {
  const out: string[] = [];
  for (const rule of stripComments(css).matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selector = rule[1]!.trim();
    if (selector.startsWith('@')) continue;
    for (const part of selector.split(',')) {
      const s = part.trim();
      if (!/\.sfdt-/.test(s)) continue;
      // Scoped by an id or a data-attribute surface switch.
      if (/^[#[]/.test(s)) continue;
      // …or by a PAGE-PRIVATE class anywhere in the selector. A rule like
      // `.sfdt-popup-dot.sfdt-ok` or `.sfdt-popup-btn .sfdt-glyph` can only
      // ever match an element the page itself built, so it adapts a shared
      // component rather than redefining it. That is the same contract as an
      // id scope, expressed with a class.
      const classes = [...s.matchAll(/\.(sfdt-[\w-]+)/g)].map((m) => m[1]!);
      if (classes.some((c) => !COMPONENT_CLASSES.has(c))) continue;
      out.push(s);
    }
  }
  return out;
}

function pageSheet(rel: string, exportName: string): string {
  // The popup and options sheets are module-private `const STYLES`, so they are
  // read from source rather than imported. Reading the text is enough — this
  // guard is about what the CSS says, not what it does at runtime.
  const src = readFileSync(path.join(ROOT, rel), 'utf8');
  const start = src.indexOf(`${exportName} = \``);
  if (start === -1) throw new Error(`could not find ${exportName} in ${rel}`);
  const open = src.indexOf('`', start);
  const close = src.indexOf('`', open + 1);
  if (close === -1) throw new Error(`unterminated ${exportName} in ${rel}`);
  return src.slice(open + 1, close);
}

const PAGE_SHEETS: { name: string; css: string }[] = [
  { name: 'ui/workspace-host.ts (HOST_STYLES)', css: HOST_STYLES },
  { name: 'entrypoints/popup/main.ts (STYLES)', css: pageSheet('entrypoints/popup/main.ts', 'const STYLES') },
  { name: 'entrypoints/options/main.ts (STYLES)', css: pageSheet('entrypoints/options/main.ts', 'const STYLES') },
];

describe('page stylesheets do not redefine shared components', () => {
  it('no page sheet declares an UNSCOPED rule for a component class', () => {
    const offenders: string[] = [];
    for (const sheet of PAGE_SHEETS) {
      for (const selector of unscopedComponentRules(sheet.css)) {
        const classes = [...selector.matchAll(/\.(sfdt-[\w-]+)/g)].map((m) => m[1]!);
        if (classes.some((c) => COMPONENT_CLASSES.has(c))) {
          offenders.push(`${sheet.name}: ${selector}`);
        }
      }
    }
    expect(
      offenders,
      `page-local rules that silently override a shared component (scope them to the page, or move the rule into lib/ui-styles.ts):\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('the guard actually fires (not a vacuous pass)', () => {
    // A guard that cannot fail is decoration. Pin both halves: an unscoped
    // component rule is caught, a page-scoped override is not.
    expect(unscopedComponentRules('.sfdt-btn { padding: 0; }')).toEqual(['.sfdt-btn']);
    expect(unscopedComponentRules('.sfdt-btn, .sfdt-pill { padding: 0; }')).toHaveLength(2);
    expect(unscopedComponentRules('#sfdt-topbar .sfdt-btn { gap: 6px; }')).toEqual([]);
    expect(unscopedComponentRules("[data-sfdt-surface='panel'] .sfdt-tile { padding: 0; }")).toEqual([]);
    // Prose that mentions a class is not a rule for it.
    expect(unscopedComponentRules('/* Quick actions wear .sfdt-btn */\n#x .y { gap: 0; }')).toEqual([]);
    // A page-private class anywhere in the selector scopes the rule as surely
    // as an id does.
    expect(unscopedComponentRules('.sfdt-popup-dot.sfdt-ok { background: red; }')).toEqual([]);
    expect(unscopedComponentRules('.sfdt-popup-btn .sfdt-glyph { margin: 0; }')).toEqual([]);
    // …but an element-qualified component rule is NOT scoped — it still
    // restyles every .sfdt-card on the page.
    expect(unscopedComponentRules('section.sfdt-card { padding: 0; }')).toEqual(['section.sfdt-card']);
    // A page-private class is not a component and is nobody's business but the
    // page's, even unscoped.
    expect(COMPONENT_CLASSES.has('sfdt-popup-dot')).toBe(false);
    expect(COMPONENT_CLASSES.has('sfdt-btn')).toBe(true);
  });

  it('reads a real selector set out of each page sheet', () => {
    // If a rename ever breaks the source extraction above, every sheet would
    // silently become an empty string and the guard would pass on nothing.
    for (const sheet of PAGE_SHEETS) {
      expect(sheet.css.length, sheet.name).toBeGreaterThan(200);
      expect(definedClasses(sheet.css).size + sheet.css.split('{').length, sheet.name).toBeGreaterThan(5);
    }
  });
});
