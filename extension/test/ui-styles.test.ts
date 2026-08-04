import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach } from 'vitest';
import { SFDT_COMPONENT_CSS, ensureComponentStyles } from '../lib/ui-styles.js';

const EXT_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');

/**
 * Pull the selector list out of every rule in the sheet. Crude but sufficient:
 * the sheet is flat (no @media / nesting), so everything before a `{` that
 * isn't inside a declaration block is a selector list.
 */
function selectors(css: string): string[] {
  // Comments come out FIRST: a comma inside a comment would otherwise split
  // into a bogus "selector" and fail the scoping check for no reason.
  let stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  // …then whole @keyframes blocks. Their steps ('0%', 'to') are not page
  // selectors — they are scoped to the animation name, which IS prefixed — so
  // holding them to the '.sfdt-' rule flags a shape that cannot leak.
  stripped = stripped.replace(/@keyframes\s+[\w-]+\s*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  const out: string[] = [];
  // '{' is a delimiter too, not just '}' — otherwise a rule NESTED inside an
  // at-rule is invisible, and a bare `button { … }` inside an @media block
  // would have slipped past this check entirely.
  // Zero-width lookbehind, not a consuming alternation: matching the previous
  // '{' would EAT it, so the very next rule (the one nested inside an at-rule)
  // would have no delimiter left to start on and would be skipped.
  for (const match of stripped.matchAll(/(?:^|(?<=[{}]))([^{}]+)\{/g)) {
    for (const sel of (match[1] ?? '').split(',')) {
      const trimmed = sel.trim();
      // An at-rule PRELUDE ('@media (…)') is a condition, not a selector; the
      // rules inside it are checked on their own.
      if (trimmed && !trimmed.startsWith('@')) out.push(trimmed);
    }
  }
  return out;
}

describe('lib/ui-styles', () => {
  beforeEach(() => {
    document.getElementById('sfdt-component-styles')?.remove();
  });

  it('injects the sheet once and is safe to call repeatedly', () => {
    ensureComponentStyles(document);
    ensureComponentStyles(document);
    ensureComponentStyles(document);
    expect(document.querySelectorAll('#sfdt-component-styles').length).toBe(1);
    expect(document.getElementById('sfdt-component-styles')?.textContent).toBe(
      SFDT_COMPONENT_CSS,
    );
  });

  // The load-bearing guard. This sheet is destined for content-script surfaces
  // where it lands on a live Salesforce page: a bare `button {}` or a generic
  // `.card {}` would restyle Salesforce's own UI or collide with SLDS.
  it('keyframe steps are not treated as page selectors, but @media rules are', () => {
    // Both halves matter: dropping @keyframes must not also drop the rules
    // inside an @media block, which CAN leak and must stay prefixed.
    expect(selectors('@keyframes sfdt-spin { to { transform: rotate(360deg); } }')).toEqual([]);
    expect(
      selectors('@media (prefers-reduced-motion: reduce) { .sfdt-spinner { animation: none; } }'),
    ).toContain('.sfdt-spinner');
    // A bare selector inside @media is still caught.
    expect(selectors('@media print { button { color: red; } }')).toContain('button');
  });

  it('scopes every selector under .sfdt-', () => {
    const leaks = selectors(SFDT_COMPONENT_CSS).filter((sel) => !sel.startsWith('.sfdt-'));
    expect(leaks).toEqual([]);
  });

  it('has selectors at all (the scoping guard must not pass vacuously)', () => {
    // A regex that silently matched nothing would make the test above green
    // while the sheet leaked freely — the failure mode that guard exists for.
    const all = selectors(SFDT_COMPONENT_CSS);
    expect(all.length).toBeGreaterThan(20);
    expect(all).toContain('.sfdt-card');
    expect(all).toContain('.sfdt-btn.sfdt-primary');
  });

  it('catches a leaking selector if one is ever added', () => {
    expect(selectors('button { color: red; }')).toEqual(['button']);
    expect(selectors('.sfdt-card { color: red; }\ntable { color: red; }')).toContain('table');
  });

  it('holds no raw colour values — every colour goes through a token', () => {
    // Comments are stripped first (golden principle #12: a check must not flag
    // its own documentation — the rules legitimately explain WHY a token was
    // chosen by naming the values it resolves to in each theme).
    const declarations = SFDT_COMPONENT_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(declarations.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
    expect(declarations.match(/\b(rgb|rgba|hsl|hsla)\(/g) ?? []).toEqual([]);
  });

  it('the raw-colour guard still fires on an actual declaration', () => {
    // Non-vacuity: stripping comments must not have neutered the check.
    const offending = '.sfdt-card { background: #ffffff; border-color: rgb(0,0,0); }';
    const declarations = offending.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(declarations.match(/#[0-9a-fA-F]{3,8}\b/g)).toEqual(['#ffffff']);
    expect(declarations.match(/\b(rgb|rgba|hsl|hsla)\(/g)).toEqual(['rgb(']);
  });

  it('never uses a fill token as a foreground', () => {
    // Same defect class test/tokens.test.ts guards in the feature source: a fill
    // (brand/error/success/warning/surface) used as `color:` looks fine in light
    // and goes dark-on-dark the moment the dark palette swaps it.
    const fills = ['surface', 'brand-deep', 'brand', 'error', 'success', 'warning'];
    const pattern = new RegExp(
      String.raw`(^|[^-])color:\s*var\(--sfdt-color-(?:${fills.join('|')})\)`,
      'gm',
    );
    expect(SFDT_COMPONENT_CSS.match(pattern) ?? []).toEqual([]);
  });

  it('keeps a visible focus ring on every interactive component', () => {
    // Keyboard path is a CONVENTIONS.md requirement, and a component library is
    // exactly where a missing focus style would propagate everywhere at once.
    for (const base of ['.sfdt-btn', '.sfdt-nav-item', '.sfdt-field', '.sfdt-segment > button']) {
      expect(SFDT_COMPONENT_CSS).toContain(`${base}:focus-visible`);
    }
  });

  it('states the segmented toggle in ARIA, not colour alone', () => {
    // The pressed segment is brand-filled. If that fill were the only signal,
    // the control would be unreadable to a screen reader and invisible to
    // anyone who cannot separate the two colours — so the CSS keys off
    // aria-pressed, which forces the DOM to carry the state.
    expect(SFDT_COMPONENT_CSS).toContain('.sfdt-segment > button[aria-pressed="true"]');
  });

  it('gives inputs an explicit colour, like buttons', () => {
    // A native <input>, like a native <button>, takes colour from UA styles
    // rather than inheritance — an input without this renders light-on-light in
    // the dark palette. This is the single most repeated dark-mode defect.
    const field = SFDT_COMPONENT_CSS.slice(SFDT_COMPONENT_CSS.indexOf('.sfdt-field {'));
    expect(field.slice(0, field.indexOf('}'))).toContain('color: var(--sfdt-color-text)');
  });
});

// The consolidation guard. Before lib/ui-styles.ts existed there were four
// independently hand-rolled stylesheets, each with its own slightly different
// card and button — the drift that made the UI look hand-made. These pin the
// rule that a surface CONSUMES the shared components rather than restating them.
describe('every UI surface consumes the shared component sheet', () => {
  // Own-page surfaces inject it directly; injected UI gets it adopted into the
  // closed shadow root (stylesheets do not cross a shadow boundary).
  const SURFACES = [
    'entrypoints/app/main.ts',
    'entrypoints/sidepanel/main.ts',
    'entrypoints/popup/main.ts',
    'entrypoints/options/main.ts',
    'ui/shadow-host.ts',
  ];

  it.each(SURFACES)('%s pulls in SFDT_COMPONENT_CSS', (surface) => {
    const source = fs.readFileSync(path.join(EXT_ROOT, surface), 'utf8');
    expect(source).toContain('SFDT_COMPONENT_CSS');
  });

  it('no surface re-declares a component the shared sheet owns', () => {
    // A page-local `button { … }` or `.card { … }` that sets its own background
    // AND border-radius is a restatement, not layout — that is how the four
    // sheets drifted apart in the first place. Layout-only rules (padding,
    // margin, flex) on the same selectors stay legitimate and are not flagged.
    const RESTATEMENTS = [
      // A bare element rule that paints a surface.
      /(^|\n)\s*button\s*\{[^}]*\bbackground:[^}]*\bborder-radius:/,
      /(^|\n)\s*button\s*\{[^}]*\bborder-radius:[^}]*\bbackground:/,
    ];
    const offenders: string[] = [];
    for (const surface of SURFACES) {
      const source = fs.readFileSync(path.join(EXT_ROOT, surface), 'utf8');
      for (const pattern of RESTATEMENTS) {
        if (pattern.test(source)) offenders.push(`${surface} restates a shared component`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('compact surfaces use the shared header row, not their own', () => {
    // The popup and the ⚡ side menu declared this row identically — same
    // padding, border and gap — in two files, one of them an inline cssText
    // string. Both must now carry .sfdt-panel-head and neither may re-declare it.
    expect(SFDT_COMPONENT_CSS).toContain('.sfdt-panel-head');
    expect(SFDT_COMPONENT_CSS).toContain('.sfdt-panel-head .sfdt-panel-title');

    for (const surface of ['lib/popup.ts', 'ui/side-button.ts']) {
      const source = fs.readFileSync(path.join(EXT_ROOT, surface), 'utf8');
      expect(source, `${surface} must use the shared header row`).toContain('sfdt-panel-head');
    }

    // And nobody re-declares the row's geometry locally.
    const LOCAL_HEADER_RULE = /\.sfdt-(popup-head|menu-header)\s*\{|border-bottom: 1px solid var\(--sfdt-color-border\);\s*display: flex/;
    for (const surface of ['entrypoints/popup/main.ts', 'ui/side-button.ts']) {
      const source = fs.readFileSync(path.join(EXT_ROOT, surface), 'utf8');
      const declarations = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(LOCAL_HEADER_RULE.test(declarations), `${surface} re-declares the header row`).toBe(
        false,
      );
    }
  });

  it('the header guard fires on a re-declared row', () => {
    // Non-vacuity, using the exact shape both surfaces had.
    const LOCAL_HEADER_RULE = /\.sfdt-(popup-head|menu-header)\s*\{|border-bottom: 1px solid var\(--sfdt-color-border\);\s*display: flex/;
    expect(LOCAL_HEADER_RULE.test('.sfdt-popup-head { display: flex; }')).toBe(true);
    expect(
      LOCAL_HEADER_RULE.test(
        "'padding: var(--sfdt-space-4); border-bottom: 1px solid var(--sfdt-color-border); display: flex;'",
      ),
    ).toBe(true);
    expect(LOCAL_HEADER_RULE.test('.sfdt-popup-foot { display: flex; }')).toBe(false);
  });

  // A hand-rolled button is `padding` + `border-radius` + `cursor: pointer` in
  // one cssText string. That combination is what 123 of the extension's 134
  // buttons were, each retyped from memory — which is why the same button
  // existed in four sizes. Files join this list as they migrate onto
  // lib/ui-controls.ts.
  const BUTTON_MIGRATED = [
    'entrypoints/app/main.ts',
    'entrypoints/options/main.ts',
    'entrypoints/popup/main.ts',
    'entrypoints/sidepanel/main.ts',
    'features/ai-assistant.ts',
    'features/apex-anonymous.ts',
    'features/apex-test-runner.ts',
    'features/api-name-generator.ts',
    'features/api-version-audit.ts',
    'features/bridge-tools.ts',
    'features/canvas-search.ts',
    'features/code-coverage.ts',
    'features/comparison-exporter.ts',
    'features/data-import.ts',
    'features/debug-log-viewer.ts',
    'features/dependency-explorer.ts',
    'features/event-monitor.ts',
    'features/field-creator.ts',
    'features/field-impact.ts',
    'features/flow-deploy.ts',
    'features/flow-list-search.ts',
    'features/flow-quality.ts',
    'features/flow-trigger-explorer-enhancer.ts',
    'features/flow-version-manager.ts',
    'features/inspect-record.ts',
    'features/metadata-retrieve.ts',
    'features/missing-description-flags.ts',
    'features/org-health-checks.ts',
    'features/org-health.ts',
    'features/org-limits.ts',
    'features/org-release-badge.ts',
    'features/org-switcher.ts',
    'features/rest-explore.ts',
    'features/saved-soql.ts',
    'features/scheduled-flow-explorer.ts',
    'features/schema-browser.ts',
    'features/setup-tabs.ts',
    'features/show-api-names.ts',
    'features/soap-explore.ts',
    'features/soql-runner.ts',
    'features/subflow-graph.ts',
    'features/trace-flags.ts',
    'features/trigger-conflicts.ts',
    'lib/code-editor.ts',
    'lib/download.ts',
    'lib/trace-flag.ts',
    'lib/history.ts',
    'lib/popup.ts',
    'lib/xml.ts',
    'lib/zod-to-dom.ts',
    'ui/apex-limit-tiles.ts',
    'ui/apex-log-analyzer.ts',
    'ui/apex-log-console.ts',
    'ui/apex-log-flame-chart.ts',
    'ui/command-palette.ts',
    'ui/confirm-dialog.ts',
    'ui/health-modal.ts',
    'ui/menu.ts',
    'ui/clipboard.ts',
    'ui/meter-card.ts',
    'ui/node-graph.ts',
    'ui/panels.ts',
    'ui/present-view.ts',
    'ui/shadow-host.ts',
    'ui/side-button.ts',
    'ui/toast.ts',
    'ui/workspace-host.ts',
    'ui/workspace-tabs.ts',
  ];
  // Styling set one property at a time. The button guard below only ever looked
  // at `style.cssText`, so a file could be "migrated" by rewriting the same
  // declarations as `el.style.padding = …` and score clean — which is exactly
  // what happened to schema-browser (0 cssText, 54 discrete assignments) before
  // this existed. The allowlist is per-instance VALUES no stylesheet can know.
  const DYNAMIC_STYLE_PROPS = new Set([
    'display', 'width', 'height', 'left', 'top', 'right', 'bottom',
    'transform', 'opacity', 'zIndex', 'visibility', 'maxHeight', 'scrollTop',
    // SVG paint: a var() does not resolve in a presentation attribute, so the
    // CSS property is the only way to theme a shape, and it is per-node.
    'fill', 'stroke',
  ]);
  // Reviewed exceptions. Both read an element's CURRENT value and set it only
  // if absent, on DOM this extension does not own — a class always sets, so it
  // would clobber the host page.
  const INLINE_STYLE_EXEMPT = [
    /canvasHost\.style\.position = canvasHost\.style\.position \|\|/,
    /if \(!view\.body\.style\.flex\) view\.body\.style\.flex/,
  ];

  it('migrated surfaces style through classes, not one property at a time', () => {
    const offenders: string[] = [];
    for (const file of BUTTON_MIGRATED) {
      const source = fs.readFileSync(path.join(EXT_ROOT, file), 'utf8');
      source.split('\n').forEach((line, i) => {
        if (line.trim().startsWith('*') || line.trim().startsWith('//')) return;
        if (INLINE_STYLE_EXEMPT.some((re) => re.test(line))) return;
        for (const m of line.matchAll(/\.style\.([a-zA-Z]+)\s*=/g)) {
          const prop = m[1]!;
          if (prop === 'cssText' || DYNAMIC_STYLE_PROPS.has(prop)) continue;
          offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('a FILL token is never used as a foreground', () => {
    // The palette splits fills from foregrounds on purpose (see the header of
    // lib/tokens.ts): '-brand' is a background, '-brand-text' is the readable
    // version. Using a fill where text goes renders low-contrast in dark mode.
    //
    // This shipped, in the relationship graph, and BOTH existing guards were
    // blind to it: the cssText scan only reads cssText, and the inline-style
    // scan explicitly allowlists SVG `fill`/`stroke` because a var() cannot
    // resolve in a presentation attribute. An allowlist carved for one reason
    // silently covered a second, unrelated one. On an SVG <text>, `fill` IS the
    // foreground.
    const FILL_ONLY = [
      'brand', 'brand-deep', 'brand-active', 'error', 'success', 'success-2',
      'warning', 'info', 'surface', 'surface-alt', 'bg', 'code-bg',
    ];
    // Where the value lands as READ TEXT: a CSS `color`, or `fill` on an SVG
    // <text>. `fill` on a <rect> is a background and is fine.
    const TEXT_SINKS = /\b(\w*[Tt]ext\w*)\.style\.fill\s*=|\.style\.color\s*=/;
    const offenders: string[] = [];

    for (const file of BUTTON_MIGRATED) {
      const src = fs.readFileSync(path.join(EXT_ROOT, file), 'utf8');
      const lines = src.split('\n');
      lines.forEach((line, i) => {
        if (line.trim().startsWith('*') || line.trim().startsWith('//')) return;
        if (!TEXT_SINKS.test(line)) return;
        // The value may continue onto the next lines (a wrapped ternary).
        const expr = lines.slice(i, i + 4).join(' ');
        for (const m of expr.matchAll(/var\(--sfdt-color-([a-z0-9-]+)\)/g)) {
          if (FILL_ONLY.includes(m[1]!)) {
            offenders.push(`${file}:${i + 1}: reads as text but uses the fill token '${m[1]}'`);
          }
        }
      });
    }
    expect(
      offenders,
      `fill tokens used as foregrounds — use the '-text' / '-strong' alias:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('the fill-as-foreground guard actually fires (not a vacuous pass)', () => {
    const TEXT_SINKS = /\b(\w*[Tt]ext\w*)\.style\.fill\s*=|\.style\.color\s*=/;
    // The exact line that shipped.
    expect(TEXT_SINKS.test("    text.style.fill = 'var(--sfdt-color-brand-deep)';")).toBe(true);
    expect(TEXT_SINKS.test("    label.style.color = 'var(--sfdt-color-error)';")).toBe(true);
    // A rect's fill is a background, not text — must NOT be flagged.
    expect(TEXT_SINKS.test("    rect.style.fill = 'var(--sfdt-color-surface-shade)';")).toBe(false);
    expect(TEXT_SINKS.test("    path.style.fill = fill;")).toBe(false);
  });

  it('every text-entry control carries .sfdt-field or sets its own colour', () => {
    // THE dark-mode defect class. A bare <input>/<select>/<textarea> takes its
    // colour and background from UA styles, not from anything it inherits. On
    // our own pages that is survivable because they declare a color-scheme; in
    // an injected modal on a Salesforce page nothing does, so Chrome paints a
    // white box with black text — a glaring rectangle on the dark palette.
    //
    // Found live in features/api-name-generator.ts (three controls) after the
    // whole migration was reported complete, because the audit counted SHAPES
    // (cssText, inline styles) and this defect is the ABSENCE of one.
    //
    // Checkboxes, radios and file inputs are excluded: those are UA-drawn
    // widgets, '.sfdt-field' would box them oddly, and they carry no text of
    // their own to mis-colour.
    // UA-drawn widgets and non-text controls. A `type='button'` <input> is a
    // button wearing an input tag — Salesforce's own version of one, in the case
    // that turned up here.
    const UA_DRAWN = /\.type = '(checkbox|radio|file|range|color|button|submit|reset|hidden)'/;
    // Any class whose rule in the component sheet declares a colour counts —
    // derived from the sheet, not listed, so it cannot vouch for a class after
    // the declaration is deleted. '.sfdt-editor-input' qualifies: it sets
    // `color: transparent` deliberately, with the caret coloured separately.
    const COLOURED_CLASSES = new Set<string>();
    for (const rule of SFDT_COMPONENT_CSS.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      if (!/(?:^|[;\s])color:/.test(rule[2]!)) continue;
      for (const sel of rule[1]!.matchAll(/\.(sfdt-[\w-]+)/g)) COLOURED_CLASSES.add(sel[1]!);
    }
    const offenders: string[] = [];

    for (const file of BUTTON_MIGRATED) {
      const src = fs.readFileSync(path.join(EXT_ROOT, file), 'utf8');
      const lines = src.split('\n');
      lines.forEach((line, i) => {
        const m = /const (\w+) = (?:doc|document)\.createElement\('(input|select|textarea)'\)/.exec(line);
        if (!m) return;
        const name = m[1]!;
        // Read the control's own setup block — the lines that mention it before
        // it is appended anywhere.
        const block = lines.slice(i, i + 14).join('\n');
        if (UA_DRAWN.test(block)) return;
        const applied = [
          ...block.matchAll(new RegExp(`\\b${name}\\.(?:className\\s*=\\s*'([^']*)'|classList\\.add\\('([^']*)')`, 'g')),
        ].flatMap((mm) => (mm[1] ?? mm[2] ?? '').split(/\s+/));
        const wearsColouredClass = applied.some((c) => c && COLOURED_CLASSES.has(c));
        // A cssText built from a module const — `input.style.cssText = INPUT_STYLE`
        // — is still a colour declaration; follow the reference.
        const viaConst = new RegExp(`\\b${name}\\.style\\.cssText\\s*=\\s*(\\w+)`).exec(block);
        const constDeclares =
          viaConst !== null &&
          new RegExp(`${viaConst[1]}\\s*=[\\s\\S]{0,600}?[^-\\w]color:`).test(src);
        const setsOwnColour =
          new RegExp(`\\b${name}\\.style\\.color\\s*=`).test(block) ||
          new RegExp(`\\b${name}\\.style\\.cssText[^;]*[^-]color:`).test(block) ||
          constDeclares;
        if (!wearsColouredClass && !setsOwnColour) {
          offenders.push(`${file}:${i + 1}: ${name} (<${m[2]}>)`);
        }
      });
    }

    expect(
      offenders,
      `form controls that will render dark-on-dark — give them '.sfdt-field':\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('the bare-control guard actually fires (not a vacuous pass)', () => {
    // Pin the detector, since a guard for a MISSING declaration passes trivially
    // if its matcher is wrong.
    const bare = "const x = doc.createElement('input');\nx.type = 'text';";
    const dressed = "const x = doc.createElement('input');\nx.className = 'sfdt-field';";
    const uaDrawn = "const x = doc.createElement('input');\nx.type = 'checkbox';";
    const wears = (b: string) => /\bx\.(?:className\s*=\s*'[^']*sfdt-field|classList\.add\('sfdt-field)/.test(b);
    // A class that exists only as a test hook, with no rule anywhere, must NOT
    // count — that was features/canvas-search.ts's bare search box.
    expect(wears("const x = doc.createElement('input');\nx.className = 'sfdt-canvas-search-bar-input';")).toBe(false);
    const ua = (b: string) => /\.type = '(checkbox|radio|file|range|color)'/.test(b);
    expect(wears(bare) || ua(bare)).toBe(false);
    expect(wears(dressed)).toBe(true);
    expect(ua(uaDrawn)).toBe(true);
    // `border-color:` must not be mistaken for a foreground declaration.
    expect(/[^-]color:/.test('border-color: red;')).toBe(false);
    expect(/[^-]color:/.test('padding: 0; color: red;')).toBe(true);
  });

  it('never assigns className twice to the same element', () => {
    // `el.className = x` REPLACES. Two assignments in a row means the first is
    // dead — and when the first was the element's identity class and the second
    // a shape class, the identity silently disappears. That is exactly how a
    // bulk migration in this codebase deleted `.sfdt-health-flow-name` from
    // five elements while every type check and lint rule stayed green; only a
    // test that queried the class by name caught it.
    const offenders: string[] = [];
    for (const file of BUTTON_MIGRATED) {
      const lines = fs.readFileSync(path.join(EXT_ROOT, file), 'utf8').split('\n');
      lines.forEach((line, i) => {
        const a = /^\s*(\w+)\.className = /.exec(line);
        const b = /^\s*(\w+)\.className = /.exec(lines[i + 1] ?? '');
        if (a && b && a[1] === b[1]) {
          offenders.push(`${file}:${i + 2}: ${b[1]} — the assignment above it is dead`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('the double-className guard actually fires (not a vacuous pass)', () => {
    const doubled = ["  x.className = 'a';", "  x.className = 'b';"];
    const a = /^\s*(\w+)\.className = /.exec(doubled[0]!);
    const b = /^\s*(\w+)\.className = /.exec(doubled[1]!);
    expect(a?.[1] === b?.[1]).toBe(true);
    // Different elements on adjacent lines are fine.
    const other = /^\s*(\w+)\.className = /.exec("  y.className = 'b';");
    expect(a?.[1] === other?.[1]).toBe(false);
  });

  it('the inline-style guard actually fires (not a vacuous pass)', () => {
    const flag = (line: string): boolean => {
      for (const m of line.matchAll(/\.style\.([a-zA-Z]+)\s*=/g)) {
        const prop = m[1]!;
        if (prop === 'cssText' || DYNAMIC_STYLE_PROPS.has(prop)) continue;
        return true;
      }
      return false;
    };
    expect(flag("el.style.padding = '8px';")).toBe(true);
    expect(flag("el.style.color = 'var(--sfdt-color-error-text)';")).toBe(true);
    expect(flag("el.style.borderRadius = '4px';")).toBe(true);
    // Per-instance values a stylesheet cannot carry stay allowed.
    expect(flag("el.style.display = 'none';")).toBe(false);
    expect(flag("fill.style.width = `${pct}%`;")).toBe(false);
    expect(flag("path.style.fill = token;")).toBe(false);
  });

  const handRolledButton = (css: string): boolean =>
    /padding:/.test(css) && /border-radius:/.test(css) && /cursor:\s*pointer/.test(css);

  it('migrated surfaces build buttons with the factory, not a cssText string', () => {
    const offenders: string[] = [];
    for (const file of BUTTON_MIGRATED) {
      const source = fs.readFileSync(path.join(EXT_ROOT, file), 'utf8');
      source.split('\n').forEach((line, i) => {
        // Whole-string test per line: these cssText assignments are single
        // long literals, and a multi-line join would let a split declaration
        // slip through in either direction.
        if (handRolledButton(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('the hand-rolled-button guard actually fires (not a vacuous pass)', () => {
    // The exact string that was in soql-runner before the migration.
    expect(handRolledButton(
      "runBtn.style.cssText = 'padding: 6px 14px; background: var(--sfdt-color-brand); " +
      "border: 0; border-radius: 4px; cursor: pointer; font-size: 13px;';",
    )).toBe(true);
    // …and does not fire on the things those files legitimately still style:
    // a menu row (no radius), a link-styled button (no padding/radius).
    expect(handRolledButton(
      "'padding: 8px 10px; cursor: pointer; border-bottom: 1px solid var(--sfdt-color-bg);'",
    )).toBe(false);
    expect(handRolledButton("'border: 0; background: none; padding: 0; cursor: pointer;'")).toBe(false);
  });

  it('the restatement guard actually fires on a restatement', () => {
    // Non-vacuity: this is exactly the shape entrypoints/options/main.ts had.
    const restated = `
  button {
    padding: 6px 14px;
    border-radius: 3px;
    background: var(--sfdt-color-surface);
  }`;
    expect(/(^|\n)\s*button\s*\{[^}]*\bborder-radius:[^}]*\bbackground:/.test(restated)).toBe(true);
    // …and not on a layout-only rule for the same element.
    const layoutOnly = '\n  button { padding: 6px 14px; }';
    expect(/(^|\n)\s*button\s*\{[^}]*\bborder-radius:[^}]*\bbackground:/.test(layoutOnly)).toBe(
      false,
    );
  });
});
