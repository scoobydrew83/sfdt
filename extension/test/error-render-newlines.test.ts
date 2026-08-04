import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SFDT_COMPONENT_CSS } from '../lib/ui-styles.js';

// Since lib/sf-error-guidance.ts, a Salesforce error's `.message` is
// multi-line: the org's own text, then the "what to do" line. HTML collapses a
// newline in `textContent` unless the element sets a `white-space` rule, so
// every surface that renders one carries an implicit contract — and an implicit
// contract enforced by nothing is how the data-import table shipped with the
// guidance running into the org's text.
//
// This is that enforcement, and it encodes the contract itself rather than a
// proxy for it: an element that is ASSIGNED an error message must declare a
// white-space rule. Keying off the error-panel *styling* instead was the
// obvious shortcut and it was wrong — it flagged a static destructive-changes
// banner that renders no message at all, which would have meant editing
// unrelated code to satisfy a check.
//
// Golden principle #12 — the check excludes the artifacts that define it: this
// file is not scanned.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SCANNED_DIRS = ['features', 'ui'];

// `foo.textContent = <expression referencing an error value>`.
//
// `message`/`msg` ARE included. An earlier draft left them out on the reasoning
// that a thrown error is always reached through `err`/`error`, and that was
// wrong: the org-error funnel for the SOQL runner, the REST explorer and the
// SOAP explorer is `function showError(message: string)`, so the assignment
// that actually renders the org's text is `errorPanel.textContent = message`.
// Excluding them meant the guard did not hold the very surface the reported bug
// appeared on. The LITERAL_ONLY filter below is what keeps static copy out, so
// widening here costs nothing.
const RENDERS_ERROR =
  /(\w+)\.textContent\s*=\s*([^;\n]*\b(?:err|error|errors|errorMsg|message|msg)\b[^;\n]*)/i;
const HAS_WHITE_SPACE = /white-space:\s*(?:pre|pre-line|pre-wrap)\b/;

// Literal, non-dynamic copy — "Could not copy to clipboard", "Navigation
// failed" — is single-line by construction. Only assignments that can carry a
// thrown message matter, and those always reference an identifier.
const LITERAL_ONLY = /=\s*['"`][^'"`]*['"`]\s*;?\s*$/;

// A COUNT of errors is a number, not a message: `${result.errors.length} flows
// could not be loaded` has no newline to preserve. Strip those references and
// see whether any error value is still being rendered.
const ERROR_COUNT = /\b(?:err|error|errors|errorMsg|message|msg)\b\s*\.\s*length/gi;
const ERROR_VALUE = /\b(?:err|error|errors|errorMsg|message|msg)\b/i;

function rendersAnErrorValue(expression: string): boolean {
  return ERROR_VALUE.test(expression.replace(ERROR_COUNT, ''));
}

// Sites the widened alternation matches that provably cannot receive a thrown
// error. Including `message`/`msg` is what buys coverage of the `showError`
// funnels, and this is the price: a generic dialog whose parameter happens to
// be called `message` is not locally distinguishable from an error funnel.
//
// An exemption is a REVIEWED decision, not a silent skip — that distinction is
// the whole lesson of ui/health-modal.ts. Each entry names the file, the
// identifier, and why it cannot carry a multiline error; and a test below
// asserts every entry still matches real source, so a stale exemption fails
// loudly instead of quietly widening the hole it was cut for.
const EXEMPT: { file: string; name: string; because: string }[] = [];

function isExempt(relFile: string, name: string): boolean {
  return EXEMPT.some((e) => e.file === relFile && e.name === name);
}

function sourceFiles(): string[] {
  const out: string[] = [];
  for (const dir of SCANNED_DIRS) {
    const abs = path.join(ROOT, dir);
    for (const name of readdirSync(abs)) {
      if (name.endsWith('.ts')) out.push(path.join(abs, name));
    }
  }
  return out;
}

// The cssText assigned to `name` anywhere in `source`. Assignments routinely
// wrap onto the next line, so read through to the terminating semicolon.
function cssTextFor(source: string, name: string): string | null {
  const pattern = new RegExp(`\\b${name}\\.style\\.cssText\\s*=\\s*([\\s\\S]*?);\\n`, 'g');
  let found: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(source)) !== null) found = (found ?? '') + m[1];
  return found;
}

// Individual properties can also be set directly (`el.style.whiteSpace = …`).
function setsWhiteSpaceDirectly(source: string, name: string): boolean {
  return new RegExp(`\\b${name}\\.style\\.whiteSpace\\s*=`).test(source);
}

// …and, since the design-system migration, by wearing a shared class instead of
// carrying any inline style at all. Reading the class names out of the sheet
// rather than listing them here is the point: a guard that vouches for
// `.sfdt-console` from a hardcoded list keeps vouching for it after someone
// deletes the `white-space` declaration from the rule.
const WHITE_SPACE_CLASSES: ReadonlySet<string> = (() => {
  const out = new Set<string>();
  for (const rule of SFDT_COMPONENT_CSS.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (!HAS_WHITE_SPACE.test(rule[2]!)) continue;
    for (const sel of rule[1]!.matchAll(/\.(sfdt-[\w-]+)/g)) out.add(sel[1]!);
  }
  return out;
})();

// …or by coming out of a shared panel builder. ui/panels.ts owns the class, so
// an element assigned from one is covered by construction — and the guard has
// to know that, or centralising the panel makes this check MORE likely to fire.
// Named builders only, not any call: `const p = renderThing()` says nothing.
const PANEL_BUILDERS = /\b(?:build)?(?:errorPanel|loadingPanel|emptyPanel|ErrorPanel|LoadingPanel|EmptyPanel)\s*\(/;

function fromPanelBuilder(source: string, name: string): boolean {
  const pattern = new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=\\s*[^;]*`, 'g');
  for (const m of source.matchAll(pattern)) {
    if (PANEL_BUILDERS.test(m[0])) return true;
  }
  return false;
}

function setsWhiteSpaceByClass(source: string, name: string): boolean {
  // EVERY argument, not just the first. `classList.add('a', 'b')` is the normal
  // shape once a file carries both an identity class and a component class, and
  // an earlier version of this matcher read only the leading string — so
  // ui/health-modal.ts, which puts its test selector first and '.sfdt-msg'
  // second, read as unstyled and the guard fired on a file that had just become
  // more correct. The blind spot was in the guard, not the feature.
  const pattern = new RegExp(
    `\\b${name}\\.(?:className\\s*=\\s*('[^']*')|classList\\.add\\(([^)]*)\\))`,
    'g',
  );
  for (const m of source.matchAll(pattern)) {
    const args = m[1] ?? m[2] ?? '';
    for (const quoted of args.matchAll(/'([^']*)'/g)) {
      for (const cls of quoted[1]!.trim().split(/\s+/)) {
        if (WHITE_SPACE_CLASSES.has(cls)) return true;
      }
    }
  }
  return false;
}

describe('a rendered Salesforce error keeps its newlines', () => {
  it('every element assigned an error message declares a white-space rule', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      const source = readFileSync(file, 'utf8');
      const lines = source.split('\n');

      lines.forEach((line, i) => {
        const match = RENDERS_ERROR.exec(line);
        if (!match) return;
        if (LITERAL_ONLY.test(line)) return;
        if (!rendersAnErrorValue(match[2]!)) return;

        const name = match[1]!;
        if (isExempt(path.relative(ROOT, file), name)) return;
        if (setsWhiteSpaceDirectly(source, name)) return;
        if (setsWhiteSpaceByClass(source, name)) return;
        if (fromPanelBuilder(source, name)) return;

        // An element with NO cssText is not exempt. An earlier draft skipped
        // those as "a judgement call we are not making", and that skip is
        // precisely what hid ui/health-modal.ts — it styled itself through
        // `msg.style.marginTop`, so there was no cssText to inspect and the
        // guard silently passed a live offender. Declining to judge is itself a
        // judgement, and it was the wrong one.
        const css = cssTextFor(source, name);
        if (css !== null && HAS_WHITE_SPACE.test(css)) return;

        offenders.push(`${path.relative(ROOT, file)}:${i + 1} (${name})`);
      });
    }

    expect(
      offenders,
      `elements that render a Salesforce error but would collapse its guidance line:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('holds the showError() funnels the org error actually flows through', () => {
    // These three are where a Salesforce error reaches the screen on the
    // surfaces the bug was reported against. They satisfy the rule today; the
    // point is that the guard now HOLDS them to it, so dropping the rule fails
    // here rather than shipping.
    //
    // HOW they satisfy it differs now, and that is the whole point of asserting
    // the union rather than the cssText: rest-explore takes its panel from
    // ui/panels.ts, the others still declare the rule locally. A test that
    // insisted on cssText would have made migrating them look like a
    // regression.
    for (const rel of [
      'features/soql-runner.ts',
      'features/rest-explore.ts',
      'features/soap-explore.ts',
    ]) {
      const source = readFileSync(path.join(ROOT, rel), 'utf8');
      expect(source, rel).toMatch(/errorPanel\.textContent\s*=\s*message/);
      const css = cssTextFor(source, 'errorPanel');
      const covered =
        (css !== null && HAS_WHITE_SPACE.test(css)) ||
        setsWhiteSpaceDirectly(source, 'errorPanel') ||
        setsWhiteSpaceByClass(source, 'errorPanel') ||
        fromPanelBuilder(source, 'errorPanel');
      expect(covered, rel).toBe(true);
    }
  });

  it('holds the health-check modal, however it declares the rule', () => {
    // The 16th surface, reached from flow-health-check with a Tooling error. It
    // was invisible while the guard skipped elements with no cssText, and this
    // case was then written to assert cssText SPECIFICALLY — which made the
    // modal's migration onto '.sfdt-msg' look like a regression. Same lesson as
    // the funnels above, learned twice: assert the union, not the mechanism.
    const source = readFileSync(path.join(ROOT, 'ui', 'health-modal.ts'), 'utf8');
    const css = cssTextFor(source, 'msg');
    const covered =
      (css !== null && HAS_WHITE_SPACE.test(css)) ||
      setsWhiteSpaceDirectly(source, 'msg') ||
      setsWhiteSpaceByClass(source, 'msg');
    expect(covered).toBe(true);
  });

  it('every exemption still matches real source', () => {
    // Stops the exemption list rotting into a hole. If the identifier or file
    // moves, the entry must be re-justified rather than silently persisting.
    for (const entry of EXEMPT) {
      const abs = path.join(ROOT, entry.file);
      const source = readFileSync(abs, 'utf8');
      expect(
        new RegExp(`\\b${entry.name}\\.textContent\\s*=`).test(source),
        `stale exemption: ${entry.file} no longer assigns ${entry.name}.textContent`,
      ).toBe(true);
      expect(entry.because.length, `${entry.file} exemption needs a reason`).toBeGreaterThan(40);
    }
  });

  it('the shared toast preserves them', () => {
    // Every showToast() caller depends on this one rule.
    const toast = readFileSync(path.join(ROOT, 'ui', 'toast.ts'), 'utf8');
    expect(toast).toMatch(HAS_WHITE_SPACE);
  });

  it('the guard actually detects a missing rule', () => {
    // A guard that cannot fail is decoration. This pins the detector itself.
    const source = [
      "const p = doc.createElement('div');",
      "p.style.cssText = 'padding: 8px;';",
      'p.textContent = err instanceof Error ? err.message : String(err);',
      '',
    ].join('\n');
    const css = cssTextFor(source, 'p');
    expect(css).not.toBeNull();
    expect(HAS_WHITE_SPACE.test(css!)).toBe(false);

    const fixed = source.replace("'padding: 8px;'", "'padding: 8px; white-space: pre-line;'");
    expect(HAS_WHITE_SPACE.test(cssTextFor(fixed, 'p')!)).toBe(true);
  });

  it('sees through the shared panel builders, but not through any call', () => {
    // Centralising the error panel must not make this guard fire on every file
    // that adopted it — and must not become a blanket pass for any assignment.
    expect(fromPanelBuilder("const p = errorPanel(msg, doc);\n", 'p')).toBe(true);
    expect(fromPanelBuilder("const p = loadingPanel();\n", 'p')).toBe(true);
    expect(fromPanelBuilder("const p = doc.createElement('div');\n", 'p')).toBe(false);
    expect(fromPanelBuilder("const p = renderSomething();\n", 'p')).toBe(false);
    // A builder assigned to a DIFFERENT name must not vouch for this one.
    expect(fromPanelBuilder("const q = errorPanel(msg);\n", 'p')).toBe(false);
  });

  it('accepts a shared class only while its rule actually declares the property', () => {
    // The class recognizer is derived from the sheet, so it must both find the
    // classes that qualify and reject the ones that do not — a set that
    // swallowed every `.sfdt-*` name would silently exempt the whole codebase.
    expect(WHITE_SPACE_CLASSES.has('sfdt-console')).toBe(true);
    expect(WHITE_SPACE_CLASSES.has('sfdt-card')).toBe(false);
    expect(WHITE_SPACE_CLASSES.has('sfdt-btn')).toBe(false);

    const src = "p.className = 'sfdt-console sfdt-error';\np.textContent = err.message;\n";
    expect(setsWhiteSpaceByClass(src, 'p')).toBe(true);
    expect(setsWhiteSpaceByClass("p.className = 'sfdt-card';\n", 'p')).toBe(false);
    // A class on a DIFFERENT element must not vouch for this one.
    expect(setsWhiteSpaceByClass("q.className = 'sfdt-console';\n", 'p')).toBe(false);
    // …and it must read PAST the first argument of a multi-class add, which is
    // where the identity class sits once a file is migrated.
    expect(setsWhiteSpaceByClass("p.classList.add('sfdt-my-thing', 'sfdt-msg');\n", 'p')).toBe(true);
    expect(setsWhiteSpaceByClass("p.classList.add('sfdt-my-thing', 'sfdt-card');\n", 'p')).toBe(
      false,
    );
  });

  it('ignores fixed single-line copy, which cannot wrap', () => {
    expect(LITERAL_ONLY.test("toast.textContent = 'Could not copy to clipboard';")).toBe(true);
    expect(LITERAL_ONLY.test('p.textContent = err.message;')).toBe(false);
  });

  it('distinguishes an error VALUE from an error COUNT', () => {
    // `${result.errors.length} flows could not be loaded` is a number and has
    // no guidance line to preserve; `${global.error}` is the org's message.
    expect(rendersAnErrorValue('`${result.errors.length} flows could not be loaded.`')).toBe(false);
    expect(rendersAnErrorValue('`Failed to load objects — ${global.error}`')).toBe(true);
    expect(rendersAnErrorValue('err instanceof Error ? err.message : String(err)')).toBe(true);
  });
});
