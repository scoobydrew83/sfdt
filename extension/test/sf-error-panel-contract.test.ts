// One code path renders a Salesforce error. This is the check that keeps it one.
//
// PR #308 fixed sixteen surfaces, ONE AT A TIME, that were mis-rendering an org
// error — collapsing our guidance line into the org's own text, and in several
// cases discarding the org's error entirely. Every one of those sixteen was a
// separate hand-roll of the same few lines:
//
//     const panel = doc.createElement('div');
//     panel.classList.add('sfdt-console', 'sfdt-error');
//     panel.textContent = err instanceof Error ? err.message : String(err);
//
// Fixing them individually left the cause untouched: nothing stopped the
// seventeenth. The two behavioural guards that came out of #308 —
// `error-render-newlines.test.ts` and `sf-error-guidance.test.ts` — pin what a
// correct panel LOOKS like, but a brand-new hand-roll that happens to satisfy
// both still passes them. This one pins the code PATH.
//
// Three rules. The first two are about the two shapes the hand-rolls had; the
// third exists because the fix for the first two created a NEW way to get it
// wrong that the type system cannot catch:
//
//   1. `.sfdt-console` + `.sfdt-error` on the same element is the Salesforce
//      error block, and only `ui/panels.ts` may build it.
//   2. An element wearing `.sfdt-console` may not be handed a caught error's
//      text directly. That is the shape with no error styling AT ALL, where a
//      failure is visually indistinguishable from a log body — rule 1 cannot
//      see it, because it never applies the classes. `features/apex-anonymous.ts`
//      shipped exactly that in its openLogBtn handler, and both #308 guards
//      missed it because the pane's `.sfdt-console` satisfied the white-space
//      rule they check.
//   3. Nothing may hand a STRINGIFIED error to the shared renderer. The org's
//      text and our guidance travel as structure on the error's `.userFacing`;
//      `err.message` at the call site flattens them back into one blob and the
//      renderer can no longer tell the halves apart. The renderer takes
//      `unknown` because a caller legitimately passes its own prose too — and
//      `unknown` accepts a string, so a wrong call site compiles clean and
//      fails silently. There is no type that separates "our sentence" from "an
//      error someone already stringified", so the check is here instead.
//
//      Rule 3 is a BACKSTOP, not a proof, and the difference matters enough to
//      write down. It reads the call site and the local bindings feeding it, so
//      it catches the flattening idioms written inline or one `const` earlier.
//      It cannot see a helper in another module that returns a string, a
//      flattened value passed through a function parameter, or an idiom nobody
//      has thought of. Claiming it "closes the `unknown` hole" would be false;
//      it closes the ordinary slip.
//
// Rule 1 is deliberately NOT a rule about `.sfdt-error` alone: that class is
// also the red variant of `.sfdt-pill`, which several features legitimately
// apply to a status chip. The PAIR is what identifies the panel.
//
// ── Why rule 1 reasons per ELEMENT and not per statement ────────────────────
//
// The first version of this file matched a single class application and asked
// whether it named both classes. That caught the canonical one-liner and
// nothing else: a hand-roll that adds the two classes in two statements —
//
//     pane.classList.add('sfdt-console');
//     pane.classList.add('sfdt-error');
//
// — was invisible, and that is the shape an author writing a reused pane
// produces FIRST, not an exotic bypass. So the scan now accumulates every class
// each element identifier receives, across every application form in the
// codebase, and asks the question once per element.
//
// ── Golden principle #12 ────────────────────────────────────────────────────
//
// The check excludes the artifact that defines it — `ui/panels.ts`, the one
// place allowed to build the block — listed by name WITH the reason it cannot
// be a violation, and with a test proving it WOULD trip a rule without the
// exclusion. That proof is the whole discipline: an exclusion for a file that
// trips nothing is not an exclusion, it is a hole, and this list carried one
// (`lib/ui-styles.ts`) for two rounds on the strength of merely naming the
// classes. `test/` is not scanned at all — a test asserting on the rendered
// class pair is describing the contract, not violating it, and this file is the
// proof.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SFDT_COMPONENT_CSS } from '../lib/ui-styles.js';
import {
  carriesAnError,
  dynamicParts,
  errorBoundNames,
  flattensAnError,
  identifiersIn,
  readExpression,
} from './error-source-scan.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// Every directory that ships DOM-building code.
const SCANNED_DIRS = ['features', 'ui', 'entrypoints', 'lib'];

// The artifacts that DEFINE the rules, each with the reason it cannot be a
// violation. Anything not on this list that trips a rule is one.
//
// An exclusion is only principle #12 if the file would OTHERWISE FAIL. A file
// that trips nothing and is excluded anyway is not an exclusion — it is a hole,
// permanently outside all three scans in exchange for nothing. This list held
// exactly one of those: `lib/ui-styles.ts` was excluded as "the stylesheet that
// declares the classes", but the class names live there inside a CSS template
// string, and no rule reads CSS. It tripped rule1=false, rule2=[], rule3=[],
// so removing it from the list costs nothing and puts the file back in the
// scan. `every exclusion would actually fail without it` below now proves that
// property for every entry, so the next one cannot be added on vibes.
const DEFINING_ARTIFACTS: { file: string; because: string }[] = [
  {
    file: 'ui/panels.ts',
    because: 'the implementation — this is the one place allowed to build the block',
  },
];

const CONSOLE_CLASS = 'sfdt-console';
const ERROR_CLASS = 'sfdt-error';

// ── Reading class applications out of source ────────────────────────────────

// `readExpression()` — the string- and nesting-aware reader that lets a class
// application be read past the newline Prettier wraps it onto — now lives in
// `./error-source-scan.ts`, shared with `error-render-newlines.test.ts`. The
// blind spot it was written for is real and still in the tree:
// `debug-log-viewer.ts` formats its `statusPill.className =` over two lines,
// and a reader that stopped at the first newline recorded no classes at all.

/**
 * The `.sfdt-*` names an expression mentions.
 *
 * Scanning the whole expression rather than parsing out its string literals is
 * deliberate: it costs nothing in precision (this only ever runs on the
 * right-hand side of a class application, where an `sfdt-` token is a class by
 * definition) and it survives, for free, every form the first version of this
 * file was blind to — template-literal interpolation, ternaries, `+=`
 * concatenation, an inline array, and a spread.
 */
function sfdtTokens(expression: string): string[] {
  return [...expression.matchAll(/\bsfdt-[\w-]+/g)].map((m) => m[0]);
}

/**
 * `const X = 'sfdt-console'` / `const X = ['sfdt-console', 'sfdt-error']`, and
 * the `let`/`var` forms.
 *
 * Without this, hoisting the class names into a variable — the tidiest-looking
 * way to write a hand-roll, and what `ui/panels.ts` itself does — hides it.
 *
 * `let`/`var` are included because the accumulator shape is the natural one for
 * a conditional panel and would otherwise walk straight through:
 *
 *     let cls = 'sfdt-console';
 *     if (failed) cls += ' sfdt-error';
 *     pane.className = cls;
 *
 * (`error-render-newlines.test.ts` happens to catch that today, but only
 * because its class recognizer needs a quoted literal on the element itself —
 * one refactor from not catching it.)
 *
 * A reassigned variable therefore accumulates the UNION of everything ever
 * assigned to it, which is the conservative reading and the one that matches
 * how these guards treat element identifiers.
 */
function constClassTokens(source: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const declaration = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=/g;
  for (const m of source.matchAll(declaration)) {
    const tokens = sfdtTokens(readExpression(source, m.index! + m[0].length));
    if (tokens.length > 0) push(out, m[1]!, tokens);
  }
  // …and later writes to the same name: `cls += ' sfdt-error'`, `cls = other`.
  // The lookbehind keeps this off property writes (`p.className = …`), and the
  // `out.has` filter means only names already known to hold a class are read —
  // so over-matching an ordinary assignment costs nothing.
  const reassignment = /(?<![.\w$])([A-Za-z_$][\w$]*)\s*\+?=(?!=)/g;
  for (const m of source.matchAll(reassignment)) {
    if (!out.has(m[1]!)) continue;
    const tokens = sfdtTokens(readExpression(source, m.index! + m[0].length));
    if (tokens.length > 0) push(out, m[1]!, tokens);
  }
  return out;
}

function push(map: Map<string, string[]>, key: string, tokens: string[]): void {
  map.set(key, [...(map.get(key) ?? []), ...tokens]);
}

// Every way the codebase puts a class on an element. `classList.remove` is
// absent on purpose — it takes one off.
const APPLICATION =
  /\b([A-Za-z_$][\w$]*)\s*\.\s*(?:className\s*\+?=|classList\s*\.\s*(?:add|toggle|replace)\s*\(|setAttribute\s*\(\s*['"]class['"]\s*,)/g;

// `Object.assign(el, { className: … })` — the one form that names the element
// before the word `className` rather than after it.
const OBJECT_ASSIGN = /\bObject\.assign\(\s*([A-Za-z_$][\w$]*)\s*,/g;

/**
 * Every class each element identifier accumulates anywhere in the file.
 *
 * Two limits worth naming here rather than discovering later:
 *
 * - **Identifiers, not elements.** The same name used for two different
 *   elements in one file merges into one entry. The tree has no such case
 *   today; if one appears, the failure is a prompt to rename or to route
 *   through the helper, not a reason to loosen the rule.
 *   `error-render-newlines.test.ts` has always had the same file-scoped-name
 *   model.
 * - **Left open, consciously:** an element reached other than through a plain
 *   identifier (`panels[i].className`, `(cond ? a : b).className`), an alias
 *   (`const a = el`, then splitting the two classes between `a` and `el`), and
 *   a class name computed at runtime (`'sfdt-' + kind`). Each is a deliberate
 *   evasion rather than ordinary authoring. This guard is not trying to defeat
 *   an adversary — it is trying to survive the next person writing a panel in a
 *   hurry, which is who wrote the sixteen.
 */
export function classesByElement(source: string): Map<string, Set<string>> {
  const consts = constClassTokens(source);
  const out = new Map<string, Set<string>>();

  const record = (name: string, expression: string): void => {
    const tokens = sfdtTokens(expression);
    // …plus any constant the expression names, spread or not.
    for (const id of expression.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) {
      const resolved = consts.get(id[1]!);
      if (resolved) tokens.push(...resolved);
    }
    if (tokens.length === 0) return;
    const set = out.get(name) ?? new Set<string>();
    for (const t of tokens) set.add(t);
    out.set(name, set);
  };

  for (const m of source.matchAll(APPLICATION)) {
    record(m[1]!, readExpression(source, m.index! + m[0].length));
  }
  for (const m of source.matchAll(OBJECT_ASSIGN)) {
    record(m[1]!, readExpression(source, m.index! + m[0].length));
  }
  return out;
}

/** Rule 1: does any single element end up wearing both panel classes? */
export function buildsSfErrorPanel(source: string): boolean {
  for (const classes of classesByElement(source).values()) {
    if (classes.has(CONSOLE_CLASS) && classes.has(ERROR_CLASS)) return true;
  }
  return false;
}

// Rule 2's matcher: the assignment, read as an EXPRESSION, and the question of
// whether that expression carries an error asked by `carriesAnError()` in
// `./error-source-scan.ts` — the same definition `error-render-newlines.test.ts`
// uses, in one place, because the two guards disagreeing about what an error is
// called is what produced three of the four holes this rule has now shipped.
//
// Two of those holes were in the code this replaces, and both were structural
// rather than a missing name:
//
//   - `[^;\n]*` read ONE LINE. Rule 1 has been expression-scoped since it was
//     rewritten; rule 2 was not, so the two shapes Prettier produces from a
//     long assignment — a trailing `+` and an array `.join()` — walked through.
//   - a `LITERAL_ONLY` suppressor excluded quote characters from its character
//     class but not `$` or `{`, so an interpolating template literal read as
//     fixed copy and `pane.textContent = \`Could not save: ${err.message}\``
//     was suppressed outright. It was measured against the whole tree and
//     suppressed NOTHING: with it short-circuited the suite stayed at 111 files
//     / 2000 tests. An exclusion that excludes no false positive is not an
//     exclusion, it is a hole — principle #12, one level up from the file list —
//     so it is deleted rather than narrowed. `dynamicParts()` covers the intent
//     it was reaching for, and cannot be fooled by a template literal.
const TEXT_CONTENT_ASSIGN = /\b([A-Za-z_$][\w$]*)\s*\.\s*textContent\s*=\s*/g;

/** Rule 2: console panes handed a caught error's text directly. */
export function rendersErrorIntoConsole(source: string): string[] {
  const consoles = new Set(
    [...classesByElement(source)]
      .filter(([, classes]) => classes.has(CONSOLE_CLASS))
      .map(([name]) => name),
  );
  const { holdsError } = errorBoundNames(source);
  // Scanned over the masked source: an assignment written inside a string
  // literal is not an assignment. See `dynamicParts()`.
  const code = dynamicParts(source);
  const out: string[] = [];
  for (const m of code.matchAll(TEXT_CONTENT_ASSIGN)) {
    const name = m[1]!;
    if (!consoles.has(name)) continue;
    if (!carriesAnError(readExpression(code, m.index! + m[0].length), holdsError)) continue;
    out.push(name);
  }
  return out;
}

// ── Rule 3: stringified errors reaching the renderer ────────────────────────

const SHARED_RENDERERS = ['renderSfError', 'setSfError'] as const;

/**
 * The functions in this file that a stringified error must not reach: the two
 * shared renderers, plus the local funnels that forward to them.
 *
 * A funnel is identified as "declared with an `unknown` parameter, in a file
 * that imports a shared renderer". That is an approximation of "forwards its
 * argument to the renderer" — but a deliberate one, and it is the exact set
 * this PR widened. Reading each function body to prove the forwarding would
 * buy precision the tree cannot currently use, and the approximation only ever
 * over-includes, which shows up as a failure to look at rather than a hole.
 *
 * It also scopes the rule correctly: `features/flow-health-check.ts` calls a
 * `showError(message: string)` on the health MODAL, which is a different
 * surface with a different contract (`.sfdt-msg`, migrated in #308). Typed
 * `string`, so it is not a sink here — deliberately out of scope rather than
 * overlooked.
 */
export function errorSinks(source: string): string[] {
  const sinks = new Set<string>();
  const importsRenderer = SHARED_RENDERERS.some((n) =>
    new RegExp(`import \\{[^}]*\\b${n}\\b[^}]*\\} from '.*ui/panels\\.js'`, 's').test(source),
  );
  for (const n of SHARED_RENDERERS) if (source.includes(`${n}(`)) sinks.add(n);
  if (importsRenderer) {
    const declaration =
      /(?:function\s+([A-Za-z_$][\w$]*)\s*\(|const\s+([A-Za-z_$][\w$]*)\s*=\s*\()([^)]*)\)/g;
    for (const m of source.matchAll(declaration)) {
      if (/:\s*unknown\b/.test(m[3]!)) sinks.add((m[1] ?? m[2])!);
    }
  }
  return [...sinks];
}

/**
 * Rule 3: calls to an error sink that pass an already-flattened error.
 *
 * `flattensAnError()` and the binding scan are the SAME ones rule 2 uses, from
 * `./error-source-scan.ts`. Round 3 shipped them as two separate definitions in
 * this one file that disagreed — rule 3's accepted `ex`/`caught`/`reason` and
 * rule 2's did not — and a reviewer walked `catch (ex) { pane.textContent =
 * String(ex); }` between them. Sharing the definition is the fix that closes
 * the generator rather than the instance.
 *
 * Scope, stated so it is not mistaken for more than it is: this catches the
 * flattening written INSIDE the call, or bound to a name this file can follow
 * (a `catch` clause, a `const`/`let`/`var`, an alias of either). It cannot see
 * a helper in another module that returns a string, or a value bound by a
 * function PARAMETER. It is a backstop for the ordinary slip, not a proof.
 *
 * The intermediate-const case IS covered, because that is the ordinary refactor
 * when the expression is needed twice:
 *
 *     const msg = err instanceof Error ? err.message : String(err);
 *     renderSfError(msg);            // ← caught
 */
export function passesStringifiedError(source: string): string[] {
  const { holdsError, flattened } = errorBoundNames(source);
  const code = dynamicParts(source);
  const out: string[] = [];
  for (const sink of errorSinks(source)) {
    const call = new RegExp(`\\b${sink}\\s*\\(`, 'g');
    for (const m of code.matchAll(call)) {
      const args = readExpression(code, m.index! + m[0].length);
      // `flattened`, not `holdsError`: passing the raw error IS the correct
      // call, and only a name already tied to its TEXT is the violation.
      const viaName = identifiersIn(dynamicParts(args)).some((id) => flattened.has(id));
      if (flattensAnError(args, holdsError) || viaName) {
        out.push(`${sink}(${args.trim().slice(0, 60)})`);
      }
    }
  }
  return out;
}

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (abs: string): void => {
    for (const name of readdirSync(abs)) {
      const full = path.join(abs, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.ts') && !full.endsWith('.d.ts')) out.push(full);
    }
  };
  for (const dir of SCANNED_DIRS) walk(path.join(ROOT, dir));
  return out;
}

const isDefining = (rel: string): boolean => DEFINING_ARTIFACTS.some((a) => a.file === rel);

function scannedSources(): { rel: string; source: string }[] {
  return sourceFiles()
    .map((abs) => path.relative(ROOT, abs))
    .filter((rel) => !isDefining(rel))
    .map((rel) => ({ rel, source: readFileSync(path.join(ROOT, rel), 'utf8') }));
}

describe('only ui/panels.ts builds the Salesforce error panel', () => {
  it('no feature, entrypoint or lib module hand-rolls the error block', () => {
    const offenders = scannedSources()
      .filter(({ source }) => buildsSfErrorPanel(source))
      .map(({ rel }) => rel);

    expect(
      offenders,
      'these build the Salesforce error panel themselves instead of calling ' +
        `renderSfError()/setSfError() from ui/panels.ts:\n${offenders.join('\n')}\n\n` +
        'If the text is OUR prose rather than an org error, `.sfdt-callout` is the right ' +
        'target — see the comment at `.sfdt-callout` in lib/ui-styles.ts.',
    ).toEqual([]);
  });

  it('no console pane is handed a caught error directly', () => {
    const offenders = scannedSources().flatMap(({ rel, source }) =>
      rendersErrorIntoConsole(source).map((n) => `${rel} (${n})`),
    );

    expect(
      offenders,
      'these assign an error message straight onto a `.sfdt-console` element, so the ' +
        `failure carries no error styling and no role="alert":\n${offenders.join('\n')}\n\n` +
        'Use setSfError(pane, err, { doc }) — and clearSfError(pane) on the success path.',
    ).toEqual([]);
  });

  it('nothing hands the renderer an already-stringified error', () => {
    const offenders = scannedSources().flatMap(({ rel, source }) =>
      passesStringifiedError(source).map((c) => `${rel}: ${c}`),
    );

    expect(
      offenders,
      'these flatten the error before the renderer sees it, so the org’s text and our ' +
        `guidance arrive as one undifferentiated blob:\n${offenders.join('\n')}\n\n` +
        'Pass the error itself. If you want to add a line of your own, that is the ' +
        '`guidance` option — not string concatenation.',
    ).toEqual([]);
  });

  it('rule 3 catches the shape `unknown` cannot', () => {
    // The whole reason this rule exists: every one of these compiles, because
    // the parameter is `unknown` and `unknown` accepts a string.
    const sink = "import { setSfError, renderSfError } from '../ui/panels.js';\n";
    const bad = [
      'renderSfError(err instanceof Error ? err.message : String(err), { doc });',
      'setSfError(pane, err.message, { doc });',
      'function showError(message: unknown) { setSfError(p, message); }\nshowError(err.message);',
      'function showError(message: unknown) { setSfError(p, message); }\nshowError(e instanceof Error ? e.message : String(e));',
      // The other flattening idioms — each one a way to reach a string.
      'renderSfError(String(err), { doc });',
      'renderSfError(err.toString(), { doc });',
      'renderSfError(`${err}`, { doc });',
      'renderSfError((err as Error).message, { doc });',
      'renderSfError(err?.message, { doc });',
      'renderSfError(caught.message, { doc });',
      'renderSfError(ex.message, { doc });',
      // `reason` is not an error SPELLING: ui/apex-log-analyzer.ts names a log
      // TRUNCATION reason that, and claiming the word flags correct code. This
      // is the structural half instead — bound by a catch clause, it is an
      // error whatever it is called.
      'try {\n  go();\n} catch (reason) {\n  renderSfError(reason.message, { doc });\n}',
      // …and the intermediate const, which is the ORDINARY refactor when the
      // expression is needed twice, not an evasion.
      'const msg = err instanceof Error ? err.message : String(err);\nrenderSfError(msg, { doc });',
      'const text = String(error);\nsetSfError(pane, text, { doc });',
    ];
    for (const src of bad) {
      expect(passesStringifiedError(sink + src), src).not.toEqual([]);
    }

    const good = [
      'renderSfError(err, { doc });',
      'setSfError(pane, err, { doc });',
      "renderSfError(err, { doc, guidance: 'Reload the tab and retry.' });",
      "function showError(message: unknown) { setSfError(p, message); }\nshowError('Enter a query to run.');",
      // A bridge reply's `error` is a string that never was an Error object —
      // there is no structure to lose, so this is not the banned shape.
      'function renderError(message: unknown) { renderSfError(message); }\nrenderError(`Bridge: ${response.error}`);',
      // `String(x)` on something that is not an error at all. apex-test-runner
      // normalises a Salesforce record id this way and interpolates it into our
      // own prose; flagging it would mean editing correct code.
      'const parentJobId = String(jobId);\nrenderError(r, s, `Unexpected test run id: ${parentJobId}`);',
    ];
    for (const src of good) {
      expect(passesStringifiedError(sink + src), src).toEqual([]);
    }
  });

  it('rule 3 is a backstop, and these are the holes it does not close', () => {
    // Documented rather than fixed, so the next reader knows the boundary is a
    // decision. Each needs cross-module or dataflow analysis a regex guard
    // cannot do; none is reachable by an ordinary slip, and the audit that
    // motivated rule 3 found zero violations to begin with.
    const sink = "import { renderSfError } from '../ui/panels.js';\n";
    const open = [
      // A helper in another module that returns a string.
      'renderSfError(formatFailure(err), { doc });',
      // Flattened behind a function parameter rather than a local binding.
      'function report(text: string) { renderSfError(text); }\nreport(err.message);',
    ];
    for (const src of open) {
      expect(passesStringifiedError(sink + src), src).toEqual([]);
    }
  });

  it('rule 3 finds the funnels this PR widened, and not the health modal', () => {
    // The sink set is the load-bearing half — a rule that watches the wrong
    // functions is decoration.
    for (const [rel, expected] of [
      ['features/soql-runner.ts', 'showError'],
      ['features/soap-explore.ts', 'showError'],
      ['features/rest-explore.ts', 'showError'],
      ['features/bridge-tools.ts', 'renderError'],
      ['features/apex-test-runner.ts', 'renderError'],
      ['features/ai-assistant.ts', 'renderResultError'],
    ] as const) {
      const sinks = errorSinks(readFileSync(path.join(ROOT, rel), 'utf8'));
      expect(sinks, `${rel} must treat ${expected} as an error sink`).toContain(expected);
    }
    // The health modal's showError takes a `string` and renders a different
    // surface. Out of scope by design, not by oversight.
    expect(
      errorSinks(readFileSync(path.join(ROOT, 'features/flow-health-check.ts'), 'utf8')),
    ).not.toContain('showError');
  });

  it('scans the files it claims to', () => {
    // A file-scan assertion that silently matched nothing stays green forever.
    const scanned = new Set(sourceFiles().map((abs) => path.relative(ROOT, abs)));
    for (const rel of [
      'features/soql-runner.ts',
      'features/apex-anonymous.ts',
      'features/org-limits.ts',
      'entrypoints/content.ts',
    ]) {
      expect(scanned.has(rel), `${rel} must be in the scan`).toBe(true);
    }
    expect(scanned.size).toBeGreaterThan(60);
  });

  it('detects the canonical hand-roll', () => {
    expect(buildsSfErrorPanel("panel.classList.add('sfdt-console', 'sfdt-error');")).toBe(true);
    expect(buildsSfErrorPanel("logPane.className = 'sfdt-console sfdt-error';")).toBe(true);
    expect(buildsSfErrorPanel('results.appendChild(renderSfError(err, { doc }));')).toBe(false);
  });

  it('detects a hand-roll SPLIT ACROSS STATEMENTS', () => {
    // The bypass the first version of this file was blind to, and the reason it
    // now accumulates per element. This is the shape an author writing a reused
    // pane produces first — it is not an exotic evasion.
    const split = [
      "const pane = doc.createElement('div');",
      "pane.classList.add('sfdt-console');",
      "if (failed) pane.classList.add('sfdt-error');",
      'pane.textContent = err.message;',
    ].join('\n');
    expect(buildsSfErrorPanel(split)).toBe(true);
  });

  it('survives every class-application form the codebase uses', () => {
    const forms: [string, string][] = [
      ['setAttribute', "p.setAttribute('class', 'sfdt-console sfdt-error');"],
      ['className +=', "p.className = 'sfdt-console';\np.className += ' sfdt-error';"],
      ['template interpolation', "p.className = `sfdt-console ${bad ? 'sfdt-error' : ''}`;"],
      [
        'const array + spread',
        "const C = ['sfdt-console', 'sfdt-error'] as const;\np.classList.add(...C);",
      ],
      [
        'const identifiers',
        "const A = 'sfdt-console';\nconst B = 'sfdt-error';\np.classList.add(A);\np.classList.add(B);",
      ],
      [
        'classList.toggle',
        "p.classList.add('sfdt-console');\np.classList.toggle('sfdt-error', bad);",
      ],
      ['Object.assign', "Object.assign(p, { className: 'sfdt-console sfdt-error' });"],
      [
        'wrapped assignment',
        "p.className =\n  bad\n    ? 'sfdt-console sfdt-error'\n    : 'sfdt-console';",
      ],
      [
        'let accumulator',
        "let cls = 'sfdt-console';\nif (failed) cls += ' sfdt-error';\np.className = cls;",
      ],
      [
        'var accumulator',
        "var cls = 'sfdt-console';\ncls = cls + ' sfdt-error';\np.setAttribute('class', cls);",
      ],
    ];
    for (const [name, src] of forms) {
      expect(buildsSfErrorPanel(src), `${name} must be caught`).toBe(true);
    }
  });

  it('does not flag the class pair spread across two different elements', () => {
    // `.sfdt-error` is also the red `.sfdt-pill`. A file with an output console
    // and a failure chip names both classes and hand-rolls nothing — flagging
    // it would mean editing correct code to satisfy a check.
    const legitimate = [
      "logPane.className = 'sfdt-console';",
      "pill.className = row.ok ? 'sfdt-pill sfdt-success' : 'sfdt-pill sfdt-error';",
    ].join('\n');
    expect(buildsSfErrorPanel(legitimate)).toBe(false);
    // …and removing a class is not applying one.
    expect(
      buildsSfErrorPanel("p.classList.add('sfdt-console');\np.classList.remove('sfdt-error');"),
    ).toBe(false);
  });

  it('rule 2 detects an error rendered into a bare console pane', () => {
    // features/apex-anonymous.ts:660 before C-FIX-4: a live Tooling failure as
    // plain text in a `.sfdt-console`, no error class, no role. Rule 1 cannot
    // see it — it never applies the classes.
    const bare = [
      "logPane.className = 'sfdt-console';",
      'logPane.textContent = err instanceof Error ? err.message : String(err);',
    ].join('\n');
    expect(rendersErrorIntoConsole(bare)).toEqual(['logPane']);

    // …and the same defect spelled `message`, which is how the three
    // showError() funnels name it. The first version of this rule omitted
    // `message` from its alternation and was blind to exactly this, in a
    // `.sfdt-console` pane, with no error class and no role — reproducing the
    // omission `error-render-newlines.test.ts` had already documented and
    // fixed. Every spelling that file accepts is pinned here.
    for (const ident of ['message', 'msg', 'err', 'error', 'errorMsg', 'errors']) {
      const src = ["logPane.className = 'sfdt-console';", `logPane.textContent = ${ident};`].join(
        '\n',
      );
      expect(rendersErrorIntoConsole(src), ident).toEqual(['logPane']);
    }
    // Case-insensitively, since the source alternation carries /i. (A word
    // boundary still applies: `errMessage` is one identifier and is NOT `err`,
    // which is the source guard's behaviour too.)
    expect(
      rendersErrorIntoConsole("p.className = 'sfdt-console';\np.textContent = ErrorMsg;"),
    ).toEqual(['p']);
    expect(
      rendersErrorIntoConsole("p.className = 'sfdt-console';\np.textContent = renderedOutput;"),
    ).toEqual([]);

    // Fixed copy is not an error, however the pane is classed.
    expect(
      rendersErrorIntoConsole(
        "logPane.className = 'sfdt-console';\nlogPane.textContent = 'Loading log…';",
      ),
    ).toEqual([]);

    // The migrated shape.
    expect(
      rendersErrorIntoConsole(
        "logPane.className = 'sfdt-console';\nsetSfError(logPane, err, { doc });",
      ),
    ).toEqual([]);
    // A status line or a table cell is not a console; showing an error string
    // inline there is correct and must not be flagged.
    expect(
      rendersErrorIntoConsole("s.className = 'sfdt-muted';\ns.textContent = err.message;"),
    ).toEqual([]);
    // A COUNT is a number, not a message.
    expect(
      rendersErrorIntoConsole(
        "p.className = 'sfdt-console';\np.textContent = `${r.errors.length} failed`;",
      ),
    ).toEqual([]);
  });

  it('rule 2 sees an error INTERPOLATED into a template literal', () => {
    // The round-3 regression, pinned. A `LITERAL_ONLY` suppressor whose
    // character class excluded quotes but not `$` or `{` classified every one
    // of these as fixed copy and skipped them, so the #308 defect — a live org
    // error in a `.sfdt-console` pane, no `.sfdt-error`, no `role="alert"` —
    // left the suite at 111 files / 2000 tests. Round 2's rule 2, which had no
    // suppressor, caught it; the fix for a missing alternation entry was paid
    // for with a wider hole than it closed. Interpolation is the ORDINARY way
    // to render an error with a lead-in, not an evasion.
    const pane = "preview.className = 'sfdt-console';\n";
    for (const assignment of [
      'preview.textContent = `Could not save: ${err instanceof Error ? err.message : String(err)}`;',
      'preview.textContent = `${err}`;',
      'preview.textContent = `${String(err)} — settings not saved`;',
      'const message = err instanceof Error ? err.message : String(err);\npreview.textContent = `${message}`;',
      'preview.textContent = `Failed to load limits: ${message}`;',
    ]) {
      expect(rendersErrorIntoConsole(pane + assignment), assignment).toEqual(['preview']);
    }
  });

  it('rule 2 reads the whole expression, not the first line', () => {
    // Rule 1 has been expression-scoped since it was rewritten; rule 2 was
    // still `[^;\n]*`, so both shapes Prettier produces from a long assignment
    // walked through. Both of these are literally what `prettier --write`
    // emits from an over-long one-liner.
    const pane = "preview.className = 'sfdt-console';\n";
    const wrapped = [
      "preview.textContent =\n  'Could not save the naming pattern for this object type: ' +\n  (err instanceof Error ? err.message : String(err));",
      "preview.textContent = [\n  'Could not save the naming pattern.',\n  err instanceof Error ? err.message : String(err),\n].join('\\n');",
    ];
    for (const assignment of wrapped) {
      expect(rendersErrorIntoConsole(pane + assignment), assignment).toEqual(['preview']);
    }
  });

  it('rule 2 knows an error by its binding, not only by its spelling', () => {
    // The alternation was a NAME ALLOWLIST, and a name allowlist grows one
    // reviewer-found spelling at a time: round 2 was missing `message`, round 3
    // was missing `ex`/`caught`/`reason` — which rule 3 in this same file
    // accepted — and neither ever had the compounds this codebase writes.
    // `errorBoundNames()` derives the answer instead: a `catch` clause binds an
    // error whatever it is called, and so does an assignment that flattens one.
    const pane = "preview.className = 'sfdt-console';\n";

    // A catch binding, whatever it is spelled.
    for (const name of ['e', 'ex', 'caught', 'reason', 'problem', 'thrown', 'oops']) {
      const src = `${pane}try {\n  save();\n} catch (${name}) {\n  preview.textContent = String(${name});\n}`;
      expect(rendersErrorIntoConsole(src), `catch (${name})`).toEqual(['preview']);
    }

    // An intermediate binding whose name is off any plausible list — the
    // ordinary refactor when the value is needed twice.
    for (const name of ['detail', 'failure', 'text', 'bodyText', 'out']) {
      const src = `${pane}const ${name} = err instanceof Error ? err.message : String(err);\npreview.textContent = ${name};`;
      expect(rendersErrorIntoConsole(src), `const ${name} = …`).toEqual(['preview']);
    }

    // …and its alias, one more hop out.
    expect(
      rendersErrorIntoConsole(
        `${pane}const detail = err.message;\nconst shown = detail;\npreview.textContent = shown;`,
      ),
    ).toEqual(['preview']);

    // A `let` accumulator, which is the natural shape for a lead-in.
    expect(
      rendersErrorIntoConsole(
        `${pane}let out = 'Save failed. ';\nout += err instanceof Error ? err.message : String(err);\npreview.textContent = out;`,
      ),
    ).toEqual(['preview']);

    // Compounds. `\\berr\\b` never matched any of these, so every one was a
    // hole a longer alternation would have closed one spelling at a time.
    for (const name of ['errMsg', 'errMessage', 'sfError', 'errorText', 'errorDetail']) {
      const src = `${pane}preview.textContent = ${name};`;
      expect(rendersErrorIntoConsole(src), name).toEqual(['preview']);
    }
  });

  it('rule 2 still declines the shapes that are not errors', () => {
    // The other side of the widening. Each of these is correct code, and a
    // guard that flagged it would mean editing correct code to satisfy a check.
    const pane = "p.className = 'sfdt-console';\n";
    for (const assignment of [
      "p.textContent = 'Loading log…';", // fixed copy
      'p.textContent = `Run finished in ${elapsed}ms`;', // a duration
      'p.textContent = `${r.errors.length} failed`;', // a COUNT, not a message
      'p.textContent = renderedOutput;', // not an error name
      'p.textContent = `... and ${rows.length - 1000} more rows (errors will still download) ...`;',
      'const parentJobId = String(jobId);\np.textContent = `Run id ${parentJobId}`;',
    ]) {
      expect(rendersErrorIntoConsole(pane + assignment), assignment).toEqual([]);
    }
  });

  it('rule 2 and rule 3 agree about what an error is called', () => {
    // The disagreement was the generator. Rule 3's `ERRORISH` accepted
    // `ex`/`caught`/`reason`; rule 2's alternation did not, so the same catch
    // variable was an error to one rule and not to the other in the SAME file.
    // Both now consult `./error-source-scan.ts`, and this is the assertion that
    // keeps them from drifting apart again.
    const sink = "import { renderSfError } from '../ui/panels.js';\n";
    const pane = "p.className = 'sfdt-console';\n";
    for (const name of ['err', 'error', 'ex', 'caught', 'reason', 'problem', 'thrown', 'e']) {
      const rule2 = rendersErrorIntoConsole(
        `${pane}try {\n  go();\n} catch (${name}) {\n  p.textContent = String(${name});\n}`,
      );
      const rule3 = passesStringifiedError(
        `${sink}try {\n  go();\n} catch (${name}) {\n  renderSfError(String(${name}), { doc });\n}`,
      );
      expect(rule2.length > 0, `rule 2 must know catch (${name})`).toBe(true);
      expect(rule3.length > 0, `rule 3 must know catch (${name})`).toBe(true);
    }
  });

  it('the two-hop in-file funnel is open, and that is a decision', () => {
    // Closing it needs parameter-level dataflow: the value is bound at the CALL
    // site, which neither the catch scan nor the binding scan can follow. Named
    // here so round 5 finds a documented boundary rather than a surprise.
    const pane = "preview.className = 'sfdt-console';\n";
    expect(
      rendersErrorIntoConsole(
        `${pane}const show = (m: string): void => {\n  preview.textContent = m;\n};\nshow(err instanceof Error ? err.message : String(err));`,
      ),
    ).toEqual([]);
  });

  it('every migrated surface reaches the helper by import', () => {
    // The negative rules above are satisfiable by rendering no error at all.
    // This is the positive half: the surfaces that DO show an org error must be
    // importing the shared builder.
    for (const rel of [
      'features/soql-runner.ts',
      'features/soap-explore.ts',
      'features/rest-explore.ts',
      'features/apex-anonymous.ts',
      'features/apex-test-runner.ts',
      'features/debug-log-viewer.ts',
      'features/trace-flags.ts',
      'features/dependency-explorer.ts',
      'features/ai-assistant.ts',
      'features/field-impact.ts',
      'features/flow-quality.ts',
      'features/flow-trigger-explorer-enhancer.ts',
      'features/bridge-tools.ts',
      'features/code-coverage.ts',
      'features/org-limits.ts',
      'features/schema-browser.ts',
      // Added in C-FIX-4 round 4: the Platform-Event limits pane rendered a
      // caught failure as bare text in a hand-styled div.
      'features/event-monitor.ts',
    ]) {
      const source = readFileSync(path.join(ROOT, rel), 'utf8');
      expect(source, `${rel} must render org errors through ui/panels.ts`).toMatch(
        /import \{[^}]*(?:renderSfError|setSfError)[^}]*\} from '\.\.\/ui\/panels\.js'/s,
      );
    }
  });

  it('every exclusion would actually fail without it', () => {
    // The property that separates a principle-#12 exclusion from a hole: the
    // file must TRIP A RULE. An entry that trips nothing buys no exemption and
    // costs a file's worth of coverage, permanently and invisibly.
    //
    // The earlier version of this test asserted only that the file still NAMED
    // the two classes, which a stylesheet does by definition — so it happily
    // vouched for `lib/ui-styles.ts`, which trips nothing. Checking the property
    // the exclusion actually claims closes the whole class, not that instance.
    for (const entry of DEFINING_ARTIFACTS) {
      const source = readFileSync(path.join(ROOT, entry.file), 'utf8');
      const trips = [
        buildsSfErrorPanel(source) ? 'rule 1' : null,
        rendersErrorIntoConsole(source).length > 0 ? 'rule 2' : null,
        passesStringifiedError(source).length > 0 ? 'rule 3' : null,
      ].filter(Boolean);
      expect(
        trips,
        `${entry.file} is excluded but trips no rule — that is a hole, not an exclusion. ` +
          'Delete the entry.',
      ).not.toEqual([]);
      expect(entry.because.length, `${entry.file} exclusion needs a reason`).toBeGreaterThan(30);
    }
  });

  it('the helper trips rule 1 through its own constant', () => {
    // Names the specific rule `ui/panels.ts` trips, so the generic proof above
    // cannot start passing for the wrong reason. Also pins the const-resolution
    // path: panels.ts applies the pair through `SF_ERROR_CLASSES` and never as
    // two literals, so a guard that did not resolve constants would read the
    // one legitimate implementation as clean.
    expect(buildsSfErrorPanel(readFileSync(path.join(ROOT, 'ui/panels.ts'), 'utf8'))).toBe(true);
  });

  it('the stylesheet is scanned like everything else', () => {
    // It was excluded for two rounds on the strength of naming the classes. It
    // declares them in CSS, which no rule reads, so it never needed exempting.
    const rel = 'lib/ui-styles.ts';
    expect(DEFINING_ARTIFACTS.map((a) => a.file)).not.toContain(rel);
    expect(scannedSources().map((s) => s.rel)).toContain(rel);
  });
});

describe('the rendered parts are styled by the shared sheet', () => {
  // The helper emits `<span>`s, which are inline by default. Without the block
  // rule the org's text and the guidance sit on one line — the exact defect,
  // reintroduced from the other end.
  it('both parts are laid out as blocks', () => {
    for (const cls of ['sfdt-sf-error-text', 'sfdt-sf-error-note']) {
      const rule = new RegExp(`\\.${cls}\\s*\\{([^}]*)\\}`).exec(SFDT_COMPONENT_CSS);
      expect(rule, `${cls} must be declared in lib/ui-styles.ts`).not.toBeNull();
      expect(rule![1], `${cls} must be a block`).toMatch(/display:\s*block/);
    }
  });

  it('the org text keeps the newlines it arrived with', () => {
    // Not about the boundary BETWEEN the parts — the block rule above handles
    // that, and an earlier version of this assertion tested only that boundary,
    // which under block layout it could never fail. This is about newlines
    // INSIDE the org's own message: an Apex compile error and a stack trace are
    // multi-line within a single record and render in ONE node, so that node
    // still needs the white-space rule.
    const rule = /\.sfdt-sf-error-text\s*\{([^}]*)\}/.exec(SFDT_COMPONENT_CSS)![1]!;
    expect(rule).toMatch(/white-space:\s*pre-wrap/);
  });

  it('the note is body text, not more error text', () => {
    // Our advice in the same alarm colour as the org's message reads as more of
    // the failure. Both are theme tokens, so this is right in light and dark.
    const rule = /\.sfdt-sf-error-note\s*\{([^}]*)\}/.exec(SFDT_COMPONENT_CSS)![1]!;
    expect(rule).toContain('var(--sfdt-color-text)');
    expect(rule).not.toContain('#');
  });
});
