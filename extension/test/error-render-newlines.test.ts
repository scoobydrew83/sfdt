import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SFDT_COMPONENT_CSS } from '../lib/ui-styles.js';
import {
  carriesAnError,
  dynamicParts,
  errorBoundNames,
  identifiersIn,
  readExpression,
  rendersAnErrorValue,
} from './error-source-scan.js';

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

// `foo.textContent = <expression>`, read as an EXPRESSION rather than as a
// line: a right-hand side long enough for Prettier to wrap it is still one
// assignment, and reading only to the first newline sees a fragment.
//
// Whether the expression carries an error is `carriesAnError()` in
// `./error-source-scan.ts` — the same call, with the same file's bindings, that
// rule 2 of `sf-error-panel-contract.test.ts` makes. It used to be a private
// alternation here and a second, DIFFERENT private alternation there, and every
// round of that guard's review found another spelling one of them accepted and
// the other did not. One definition is the fix for the generator; see the
// header of that module.
//
// It was `rendersAnErrorValue(expression)` until #327's N2 — the same module,
// but the SPELLING half of it only, with no `names` argument and no call to
// `errorBoundNames()`. That made the module header's "both guards share one
// definition" true of the plumbing and false of the question actually asked.
//
// `message`/`msg` are in it. An earlier draft left them out on the reasoning
// that a thrown error is always reached through `err`/`error`, and that was
// wrong: the org-error funnel for the SOQL runner, the REST explorer and the
// SOAP explorer is `function showError(message: string)`, so the assignment
// that actually renders the org's text is `errorPanel.textContent = message`.
// Excluding them meant the guard did not hold the very surface the reported bug
// appeared on.
const TEXT_CONTENT_ASSIGN = /(\w+)\.textContent\s*=\s*/g;
const HAS_WHITE_SPACE = /white-space:\s*(?:pre|pre-line|pre-wrap)\b/;

// ── What replaced LITERAL_ONLY, and why it had to go ────────────────────────
//
// Literal copy — "Could not copy to clipboard", "Navigation failed" — cannot
// carry a thrown message, and this guard has to know that or it fires on every
// static string containing the word "error". It used to know it like this:
//
//     const LITERAL_ONLY = /=\s*['"`][^'"`]*['"`]\s*;?\s*$/;
//
// The character class excludes quote characters but not `$` or `{`, so a
// TEMPLATE LITERAL that interpolates an error read as static copy. That is not
// a corner case; it is the ordinary way to render one, and it hid a live
// offender in this very scan for a full release round:
//
//     limitsContainer.textContent = `Failed to load limits: ${message}`;
//                                                 // features/event-monitor.ts
//
// `rendersAnErrorValue()` now asks the question of `dynamicParts()` — the
// expression with the text inside its string literals removed — so static prose
// is excluded by construction rather than by a pattern that has to guess where
// the literal ends. A template literal keeps its `${…}` holes and loses its
// prose, which is exactly the distinction the suppressor was reaching for and
// exactly the one it got wrong.
//
// Measured on this tree, the swap surfaces four sites and needs NO replacement
// suppressor for three of them:
//
//   features/field-creator.ts:398   `tdStatus.textContent = 'Error';`
//   features/data-import.ts:745     `` `… and ${rows.length - 1000} more rows
//                                      (errors will still download …)` ``
//     Both are static prose. `dynamicParts()` leaves the first with nothing at
//     all and the second with an arithmetic expression, so neither is flagged —
//     structurally, not by exemption. This is the false positive LITERAL_ONLY
//     was genuinely earning its keep on, and the reason the replacement is a
//     narrower QUESTION rather than nothing.
//
//   features/event-monitor.ts:250   `` `Failed to load limits: ${message}` ``
//   features/metadata-retrieve.ts:229 `` `${level.word}: ${msg.text}` ``
//     Both are real. The first is the #308 defect verbatim, into a hand-styled
//     div with no class and no role — fixed by routing through setSfError().
//     The second was called a false positive on review, and is not: `addLog`
//     is called with `` `Describe metadata failed: ${err.message}` `` at ten
//     sites, so `msg.text` really does carry a thrown error's text, and since
//     lib/sf-error-guidance.ts that text is multi-line. The log line now wears
//     `.sfdt-msg`, the class that exists for exactly this.

// Sites the guard matches that provably cannot receive a thrown error.
// Including `message`/`msg` is what buys coverage of the `showError` funnels,
// and this is the price: a generic dialog whose parameter happens to be called
// `message` is not locally distinguishable from an error funnel.
//
// An exemption is a REVIEWED decision, not a silent skip — that distinction is
// the whole lesson of ui/health-modal.ts. Each entry names the file, the
// identifier, and why it cannot carry a multiline error; and two tests below
// hold the list to principle #12 in BOTH directions — that every entry still
// matches real source, and that every entry would actually be flagged without
// it. The second is the one this guard was missing, and its absence is what
// this round is fixing: `LITERAL_ONLY` was an exemption of exactly this kind
// with no such proof, and on rule 2 of the sibling guard it turned out to
// suppress nothing at all while hiding a defect.
//
// `expression` narrows an entry to the one assignment it was written for: a
// (file, name) pair alone would also exempt a FUTURE `el.textContent =
// err.message` added to the same function, which is precisely the hole an
// exemption must not open.
interface Exemption {
  file: string;
  name: string;
  expression: string;
  because: string;
}

const EXEMPT: Exemption[] = [
  {
    file: 'ui/panels.ts',
    name: 'el',
    expression: 'message',
    because:
      "loadingPanel()'s `el.textContent = message` — a caller-supplied 'Loading …' line, never a " +
      'thrown error; the error builder in the same file emits its parts as separate nodes and ' +
      'assigns no textContent at all. This entry only became necessary when that builder stopped ' +
      "reusing the name `el`: until then loadingPanel passed on the error panel's class, which is " +
      'the same-name blind spot the guard warns about two comments up.',
  },
];

function isExempt(
  exempt: readonly Exemption[],
  relFile: string,
  name: string,
  expression: string,
): boolean {
  return exempt.some(
    (e) => e.file === relFile && e.name === name && expression.trim() === e.expression,
  );
}

const escapeForRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
const PANEL_BUILDERS =
  /\b(?:build)?(?:renderSfError|errorPanel|loadingPanel|emptyPanel|ErrorPanel|LoadingPanel|EmptyPanel)\s*\(/;

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

/**
 * Every site the guard would report, given a candidate exemption list.
 *
 * Parameterised on the list rather than closing over `EXEMPT` so that the bite
 * check below can run the REAL scan with one entry removed. That is the only
 * way to ask the question an exemption actually claims — "this site would be
 * reported without me" — and asking anything weaker is what let a decorative
 * entry through review; see the test itself.
 */
function offendingSites(exempt: readonly Exemption[]): string[] {
  return sourceFiles().flatMap((file) =>
    offendingSitesIn(path.relative(ROOT, file), readFileSync(file, 'utf8'), exempt),
  );
}

/**
 * The same scan, on one source string.
 *
 * Split out so the guard's own wiring is reachable from a test. A rule that can
 * only be exercised by whatever happens to be in the tree is a rule whose
 * changes cannot be mutation-proved — and every widening in this guard's
 * history has been argued for rather than demonstrated.
 */
function offendingSitesIn(rel: string, source: string, exempt: readonly Exemption[]): string[] {
  const offenders: string[] = [];

  // Masked, so an assignment inside a string literal or a comment is not
  // scanned; length- and newline-preserving, so line numbers stay true.
  const code = dynamicParts(source);
  // …and the file's error BINDINGS, so this guard asks the same question the
  // sweep does rather than only the spelling half of it (#327, N2). Its entry
  // point used to be `rendersAnErrorValue(expression)`, which takes no names
  // and never consults `errorBoundNames()` — so every structural gain of the
  // shared module (the catch scan, the binding scan, the alias fixed point)
  // reached rules 2 and 3 and stopped at this file's door, while the module
  // header claimed both guards shared one definition of what an error is.
  // Review measured the gap: a pane classed in another module, filled from
  // `catch (glitch) { pane.textContent = String(glitch) }`, was scoped out of
  // rule 2 for not being a `.sfdt-console` and invisible here for not being
  // an error SPELLING — caught by neither. Measured tree-wide, closing it
  // adds zero sites, so it is a claim made true rather than a widening.
  const { holdsError } = errorBoundNames(source);

  for (const match of code.matchAll(TEXT_CONTENT_ASSIGN)) {
    const expression = readExpression(code, match.index + match[0].length);
    if (!carriesAnError(expression, holdsError)) continue;

    const name = match[1]!;
    const line = code.slice(0, match.index).split('\n').length;
    if (isExempt(exempt, rel, name, expression)) continue;
    if (setsWhiteSpaceDirectly(source, name)) continue;
    if (setsWhiteSpaceByClass(source, name)) continue;
    if (fromPanelBuilder(source, name)) continue;

    // An element with NO cssText is not exempt. An earlier draft skipped
    // those as "a judgement call we are not making", and that skip is
    // precisely what hid ui/health-modal.ts — it styled itself through
    // `msg.style.marginTop`, so there was no cssText to inspect and the
    // guard silently passed a live offender. Declining to judge is itself a
    // judgement, and it was the wrong one.
    const css = cssTextFor(source, name);
    if (css !== null && HAS_WHITE_SPACE.test(css)) continue;

    offenders.push(`${rel}:${line} (${name})`);
  }
  return offenders;
}

describe('a rendered Salesforce error keeps its newlines', () => {
  it('every element assigned an error message declares a white-space rule', () => {
    const offenders = offendingSites(EXEMPT);

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
    // HOW they satisfy it has now changed twice, which is the whole point of
    // asserting the union rather than one mechanism. They first declared the
    // rule locally; rest-explore then took its panel from ui/panels.ts; all
    // three now route the message through `setSfError`, which emits the org's
    // text and the guidance as separate NODES so there is no newline left to
    // collapse. A test pinned to `errorPanel.textContent = message` would have
    // read the strongest of those three states as a regression.
    for (const rel of [
      'features/soql-runner.ts',
      'features/rest-explore.ts',
      'features/soap-explore.ts',
    ]) {
      const source = readFileSync(path.join(ROOT, rel), 'utf8');
      const fills = /setSfError\(errorPanel, message/.test(source);
      expect(source, `${rel}: the org error must still reach a shared panel`).toMatch(
        /errorPanel\.textContent\s*=\s*message|setSfError\(errorPanel, message/,
      );
      const css = cssTextFor(source, 'errorPanel');
      const covered =
        fills ||
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
        new RegExp(`\\b${entry.name}\\.textContent\\s*=\\s*${entry.expression}\\s*;`).test(source),
        `stale exemption: ${entry.file} no longer assigns ${entry.name}.textContent = ${entry.expression}`,
      ).toBe(true);
      expect(entry.because.length, `${entry.file} exemption needs a reason`).toBeGreaterThan(40);
    }
  });

  it('every exemption would actually be flagged without it', () => {
    // The other half of principle #12. An entry that the check would not have
    // flagged anyway buys no exemption and costs an assignment's worth of
    // coverage, permanently and invisibly — which is precisely what
    // `LITERAL_ONLY` turned out to be on the sibling guard's rule 2, where
    // short-circuiting it left the whole suite green.
    //
    // #327 added this test and it did NOT check that. It asserted two weaker
    // things — that the assignment still exists, and that
    // `rendersAnErrorValue(entry.expression)` is true — and neither is the
    // property an exemption claims. It never asked whether the site would be
    // REPORTED, so it never ran `setsWhiteSpaceDirectly`, `setsWhiteSpaceByClass`,
    // `fromPanelBuilder` or the `cssText` test. Any site whose expression was
    // error-ish and which was already covered by one of those four sailed
    // through: review added
    //
    //     { file: 'ui/toast.ts', name: 'toast', expression: 'message', … }
    //
    // and the suite stayed green, even though `ui/toast.ts:78` carries
    // `white-space: pre-line` in its `cssText` and is provably not an offender.
    // That is the same weaker-property mistake as the stale-exclusion test that
    // vouched for `lib/ui-styles.ts` for two rounds — made in the check written
    // to prevent it.
    //
    // The property, stated so it cannot be satisfied by anything less: run the
    // REAL offender scan with the entry removed and require the site to appear
    // in the report. The sibling `every exclusion would actually fail without
    // it` on `sf-error-panel-contract.test.ts` has always had this shape; this
    // is the same shape, on the same principle.
    for (const entry of EXEMPT) {
      const without = offendingSites(EXEMPT.filter((e) => e !== entry));
      const site = new RegExp(
        `^${escapeForRegExp(entry.file)}:\\d+ \\(${escapeForRegExp(entry.name)}\\)$`,
      );
      expect(
        without.filter((s) => site.test(s)),
        `${entry.file} (${entry.name} = ${entry.expression}) is exempted from a check that ` +
          'would not report it anyway — that is a hole, not an exemption. Delete the entry.\n' +
          `Sites reported with the entry removed:\n${without.join('\n') || '(none)'}`,
      ).not.toEqual([]);
    }
  });

  it('knows an error by its BINDING here too, not only by its spelling', () => {
    // #327's N2. This guard's entry point asked `rendersAnErrorValue()`, which
    // consults the spelling list and nothing else, so the structural half of
    // the shared module never reached it. `glitch` is on no list — it is an
    // error because a `catch` bound it — and the pane is classed in another
    // module, so rule 2 of the sibling guard scopes it out for not being a
    // `.sfdt-console`. Review measured this exact shape as caught by neither.
    const source = [
      "const pane = doc.createElement('div');",
      'try {',
      '  refresh();',
      '} catch (glitch) {',
      '  pane.textContent = String(glitch);',
      '}',
      '',
    ].join('\n');
    expect(offendingSitesIn('features/probe.ts', source, [])).toEqual([
      'features/probe.ts:5 (pane)',
    ]);
    // …and the spelling question on its own still says no, which is why the
    // guard had to stop asking only that one.
    expect(rendersAnErrorValue('String(glitch)')).toBe(false);

    // The other half: declaring the rule still exempts it, however it is
    // declared. A widening that could not be satisfied would be a widening that
    // forces an exemption, which is the trade this guard refuses to make.
    const styled = source.replace(
      "const pane = doc.createElement('div');",
      "const pane = doc.createElement('div');\npane.className = 'sfdt-console';",
    );
    expect(offendingSitesIn('features/probe.ts', styled, [])).toEqual([]);
  });

  it('knows the name a for-of head binds, which has no `=` in it', () => {
    // The round-6 review's largest named gap reaches this guard too, because it
    // asks `errorBoundNames()` the same question rules 2 and 3 do. A pane filled
    // one line at a time out of a flattened error is the shape that most needs
    // the white-space rule — the whole point of the rule is a multi-line org
    // message — and the head that produces it bound nothing until now.
    const source = [
      "const pane = doc.createElement('div');",
      'try {',
      '  refresh();',
      '} catch (zq) {',
      "  for (const zline of String(zq).split('\\n')) {",
      '    pane.textContent = zline;',
      '  }',
      '}',
      '',
    ].join('\n');
    expect(offendingSitesIn('features/probe.ts', source, [])).toEqual([
      'features/probe.ts:6 (pane)',
    ]);
    // The spelling question on its own still says no — `zline` is on no list —
    // so this is the structural half and not a widened alternation.
    expect(rendersAnErrorValue('zline')).toBe(false);

    // Declaring the rule still exempts it. A widening that could not be
    // satisfied would be a widening that forces an exemption.
    expect(
      offendingSitesIn(
        'features/probe.ts',
        source.replace(
          "const pane = doc.createElement('div');",
          "const pane = doc.createElement('div');\npane.className = 'sfdt-console';",
        ),
        [],
      ),
    ).toEqual([]);

    // …and the other side. A for-of over an ordinary collection binds nothing,
    // which is what all 265 heads in the tree are.
    expect(
      offendingSitesIn(
        'features/probe.ts',
        [
          "const pane = doc.createElement('div');",
          'for (const zrow of zqRows) {',
          '  pane.textContent = zrow;',
          '}',
          '',
        ].join('\n'),
        [],
      ),
    ).toEqual([]);
  });

  it('the struct-field funnel is open, and that is a MEASURED decision', () => {
    // The shape below is the #308 defect that shipped inside this guard's own
    // SCANNED_DIRS and rendered wrong on screen for four rounds:
    //
    //   lib/salesforce-api.ts:657     throw soapError(`${headline}\n${advice}`)
    //   features/org-health-checks.ts run() → summary: `Could not run: ${reason}`
    //   features/org-health-checks.ts renderCheckRow() → span.textContent = check.summary
    //   lib/ui-styles.ts:243          .sfdt-muted declares font and colour, no white-space
    //
    // The rendering is fixed (both halves — the live rows and the CLI snapshot
    // rows in features/org-health.ts) and pinned by rendered-DOM tests in
    // test/org-health-checks.test.ts and test/org-health.test.ts. What is NOT
    // fixed is this guard's ability to see the shape, and that is a decision
    // with a measurement behind it rather than an argument.
    //
    // The value crosses a function boundary as a FIELD of a struct: written as
    // an object-literal property in one function, read back as `check.summary`
    // in another, through a parameter the caller binds. Teaching the binding
    // scan to read an object-literal property as a declaration is the obvious
    // widening, so it was built and measured tree-wide rather than reasoned
    // about. With `/[{,]\s*([A-Za-z_$][\w$]*)\s*:/` added to the declaration
    // loop in errorBoundNames():
    //
    //   - binding names tree-wide go from 11 to 30, gaining `id`, `title`,
    //     `status`, `ok`, `fields`, `manifest`, `onActivate`, `sfdtKind`, `T`;
    //   - rule 3's offender set goes from [] to SEVEN, every one of them
    //     correct code — including `setSfError(errorPanel, message, { doc })`,
    //     which is the call the whole contract exists to require;
    //   - this guard gains the site below, and gains `titleEl.textContent =
    //     check.title` three lines above it, which is a TITLE.
    //
    // So the widening does reach the defect, and it reaches it by claiming
    // every named property in the tree. It also only reaches HALF of it: the
    // CLI-snapshot copy in features/org-health.ts builds its summary in
    // shapeChecks() from a bridge payload, so nothing in that file flattens an
    // error and the same rendering stays invisible either way. A within-file
    // property heuristic cannot close a funnel whose other end is a JSON
    // document from another process.
    //
    // Left open, deliberately, with the shape pinned so the next round finds a
    // documented boundary and this measurement instead of a surprise.
    const source = [
      'function build() {',
      '  try {',
      '    go();',
      '  } catch (err) {',
      '    return { summary: `Could not run: ${err instanceof Error ? err.message : String(err)}` };',
      '  }',
      '}',
      'function render(check: { summary: string }) {',
      "  const summaryEl = doc.createElement('span');",
      "  summaryEl.className = 'sfdt-quiet';",
      '  summaryEl.textContent = check.summary;',
      '}',
      '',
    ].join('\n');
    expect(offendingSitesIn('features/probe.ts', source, [])).toEqual([]);
    // …and the reason is precisely that the field is not a binding this file
    // can follow: the same assignment from a name the scan DOES follow is seen.
    const bound = source.replace('check.summary', 'err');
    expect(offendingSitesIn('features/probe.ts', bound, [])).toEqual([
      'features/probe.ts:11 (summaryEl)',
    ]);
  });

  it('the exemption bite check rejects a decorative entry', () => {
    // Pins the test above against the exact entry that walked past its #327
    // version. `ui/toast.ts:80` really does assign `toast.textContent = message`
    // and `message` really is an error-ish spelling — both of the things that
    // version asserted are TRUE here — but `ui/toast.ts:78` sets
    // `white-space: pre-line` in its `cssText`, so the guard would never report
    // the site and the exemption buys nothing.
    const decorative: Exemption = {
      file: 'ui/toast.ts',
      name: 'toast',
      expression: 'message',
      because:
        'decorative entry, kept here as a FIXTURE for the bite check above — it is not in ' +
        'EXEMPT and must never be, because the guard does not report this site.',
    };
    // The two properties the old check asserted both hold …
    const toast = readFileSync(path.join(ROOT, decorative.file), 'utf8');
    const code = dynamicParts(toast);
    expect(
      [...code.matchAll(TEXT_CONTENT_ASSIGN)].some(
        (m) =>
          m[1] === decorative.name &&
          readExpression(code, m.index + m[0].length).trim() === decorative.expression,
      ),
    ).toBe(true);
    expect(rendersAnErrorValue(decorative.expression)).toBe(true);
    // … and the site is still never reported, which is the property that counts.
    const site = new RegExp(
      `^${escapeForRegExp(decorative.file)}:\\d+ \\(${escapeForRegExp(decorative.name)}\\)$`,
    );
    expect(offendingSites([]).filter((s) => site.test(s))).toEqual([]);
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
    expect(fromPanelBuilder('const p = errorPanel(msg, doc);\n', 'p')).toBe(true);
    expect(fromPanelBuilder('const p = renderSfError(err, { doc });\n', 'p')).toBe(true);
    expect(fromPanelBuilder('const p = loadingPanel();\n', 'p')).toBe(true);
    expect(fromPanelBuilder("const p = doc.createElement('div');\n", 'p')).toBe(false);
    expect(fromPanelBuilder('const p = renderSomething();\n', 'p')).toBe(false);
    // A builder assigned to a DIFFERENT name must not vouch for this one.
    expect(fromPanelBuilder('const q = errorPanel(msg);\n', 'p')).toBe(false);
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
    expect(setsWhiteSpaceByClass("p.classList.add('sfdt-my-thing', 'sfdt-msg');\n", 'p')).toBe(
      true,
    );
    expect(setsWhiteSpaceByClass("p.classList.add('sfdt-my-thing', 'sfdt-card');\n", 'p')).toBe(
      false,
    );
  });

  it('ignores fixed copy, and is not fooled by an interpolating template', () => {
    // The regression this replaced. `LITERAL_ONLY`'s character class excluded
    // quote characters but not `$` or `{`, so every one of the interpolated
    // spellings below read as "fixed copy" and was suppressed — in this guard
    // and in rule 2 of `sf-error-panel-contract.test.ts` at the same time. It
    // is not a corner case: interpolation is the ordinary way to render an
    // error with a lead-in, and it hid `features/event-monitor.ts:250` for a
    // full round.
    const suppressed = /=\s*['"`][^'"`]*['"`]\s*;?\s*$/;

    for (const copy of [
      "toast.textContent = 'Could not copy to clipboard';",
      'status.textContent = "Navigation failed";',
      'pane.textContent = `Loading log…`;',
    ]) {
      expect(rendersAnErrorValue(copy.split('=').slice(1).join('=')), copy).toBe(false);
    }

    for (const live of [
      'p.textContent = err.message;',
      'p.textContent = `Could not save: ${err instanceof Error ? err.message : String(err)}`;',
      'p.textContent = `${err}`;',
      'p.textContent = `${String(err)} — settings not saved`;',
      'p.textContent = `Failed to load limits: ${message}`;',
    ]) {
      expect(rendersAnErrorValue(live.split('=').slice(1).join('=')), live).toBe(true);
    }

    // …and the four interpolated ones are exactly what the old suppressor
    // called fixed copy. This is the assertion that keeps it from coming back.
    for (const live of [
      'p.textContent = `Could not save: ${err instanceof Error ? err.message : String(err)}`;',
      'p.textContent = `${err}`;',
      'p.textContent = `${String(err)} — settings not saved`;',
      'p.textContent = `Failed to load limits: ${message}`;',
    ]) {
      expect(suppressed.test(live), `${live} — the shape LITERAL_ONLY got wrong`).toBe(true);
    }
  });

  it('drops the prose inside a string but keeps what it interpolates', () => {
    // `dynamicParts()` is what makes the check above structural rather than a
    // pattern that has to guess where a literal ends.
    // Length- and newline-preserving, so it can be run over a whole file
    // without moving a single offset — assert on what SURVIVES, not on shape.
    expect(identifiersIn(dynamicParts("'nothing here'"))).toEqual([]);
    expect(identifiersIn(dynamicParts('`plain words only`'))).toEqual([]);
    expect(dynamicParts("'abcd'")).toHaveLength(6);
    expect(dynamicParts('`a ${err.message} b`')).toContain('err.message');
    // A `X = …` written inside a string literal is not a binding — the Python
    // code template in features/soql-runner.ts contains `query = """`.
    expect(identifiersIn(dynamicParts('const py = `\\nquery = """\\n`;'))).toEqual(['const', 'py']);
    // Prose that merely CONTAINS an error word is not a value — this is
    // features/data-import.ts:745, which the old suppressor also let through
    // only because the line happened to end in a backtick.
    expect(
      rendersAnErrorValue(
        '`... and ${rows.length - 1000} more rows (errors will still download completely) ...`',
      ),
    ).toBe(false);
    // …and a literal that IS an error word, which is features/field-creator.ts:398.
    expect(rendersAnErrorValue("'Error'")).toBe(false);
  });

  it('distinguishes an error VALUE from an error COUNT', () => {
    // `${result.errors.length} flows could not be loaded` is a number and has
    // no guidance line to preserve; `${global.error}` is the org's message.
    expect(rendersAnErrorValue('`${result.errors.length} flows could not be loaded.`')).toBe(false);
    expect(rendersAnErrorValue('`Failed to load objects — ${global.error}`')).toBe(true);
    expect(rendersAnErrorValue('err instanceof Error ? err.message : String(err)')).toBe(true);
  });
});
