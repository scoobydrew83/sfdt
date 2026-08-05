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
// The check excludes the artifacts that define it: the helper's own
// implementation and the stylesheet that declares the classes, each listed by
// name WITH the reason it cannot be a violation, plus a test that fails a stale
// exclusion. `test/` is not scanned at all — a test asserting on the rendered
// class pair is describing the contract, not violating it, and this file is the
// proof.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SFDT_COMPONENT_CSS } from '../lib/ui-styles.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// Every directory that ships DOM-building code.
const SCANNED_DIRS = ['features', 'ui', 'entrypoints', 'lib'];

// The artifacts that DEFINE the rules, each with the reason it cannot be a
// violation. Anything not on this list that trips a rule is one.
const DEFINING_ARTIFACTS: { file: string; because: string }[] = [
  {
    file: 'ui/panels.ts',
    because: 'the implementation — this is the one place allowed to build the block',
  },
  {
    file: 'lib/ui-styles.ts',
    because:
      'the stylesheet that declares `.sfdt-console.sfdt-error`, and the comment at ' +
      '`.sfdt-callout` that tells a caller which of the two to reach for',
  },
];

const CONSOLE_CLASS = 'sfdt-console';
const ERROR_CLASS = 'sfdt-error';

// ── Reading class applications out of source ────────────────────────────────

/**
 * Read one expression forward from `from`, respecting nesting and strings.
 *
 * Stops at the `)` that closes the call we are inside, or at the `;` of a bare
 * assignment. A depth-zero newline ends it too — but only when the NEXT line
 * does not open with a continuation token, because
 *
 *     statusPill.className =
 *       row.ok ? 'sfdt-pill sfdt-success' : 'sfdt-pill sfdt-error';
 *
 * is how a class assignment is formatted the moment it gets long, and reading
 * only as far as the first newline would see an empty expression and record no
 * classes at all. That is a blind spot the tree already contains (in
 * `debug-log-viewer.ts`), harmless there only because the classes happen to be
 * pill variants.
 */
const CONTINUES_LINE = /^[?:.+&|,)\]}]/;

function readExpression(source: string, from: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < source.length; i++) {
    const ch = source[i]!;
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) return source.slice(from, i); // the call's own closer
      depth--;
    } else if (depth === 0 && ch === ';') {
      return source.slice(from, i);
    } else if (depth === 0 && ch === '\n') {
      const rest = source.slice(i + 1);
      const nextLine = rest.replace(/^[ \t\r\n]*/, '');
      if (source.slice(from, i).trim() !== '' && !CONTINUES_LINE.test(nextLine)) {
        return source.slice(from, i);
      }
    }
  }
  return source.slice(from);
}

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
 * `const X = 'sfdt-console'` / `const X = ['sfdt-console', 'sfdt-error']`.
 *
 * Without this, hoisting the class names into a constant — the tidiest-looking
 * way to write a hand-roll, and what `ui/panels.ts` itself does — hides it.
 */
function constClassTokens(source: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of source.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=/g)) {
    const tokens = sfdtTokens(readExpression(source, m.index! + m[0].length));
    if (tokens.length > 0) out.set(m[1]!, tokens);
  }
  return out;
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

// Rule 2's matcher. The identifier alternation mirrors
// `error-render-newlines.test.ts` so the two guards agree about what "renders
// an error" means; the extra condition here is that the target is a CONSOLE — a
// pane, not a status line or a table cell, both of which legitimately show an
// error string inline.
const RENDERS_ERROR_VALUE =
  /\b([A-Za-z_$][\w$]*)\s*\.\s*textContent\s*=\s*([^;\n]*\b(?:err|error|errorMsg)\b[^;\n]*)/g;
const ERROR_COUNT = /\b(?:err|error|errors|errorMsg)\b\s*\.\s*length/gi;

/** Rule 2: console panes handed a caught error's text directly. */
export function rendersErrorIntoConsole(source: string): string[] {
  const consoles = new Set(
    [...classesByElement(source)]
      .filter(([, classes]) => classes.has(CONSOLE_CLASS))
      .map(([name]) => name),
  );
  const out: string[] = [];
  for (const m of source.matchAll(RENDERS_ERROR_VALUE)) {
    const [, name, expression] = m;
    if (!consoles.has(name!)) continue;
    // A COUNT of errors is a number, not a message.
    if (!/\b(?:err|error|errorMsg)\b/i.test(expression!.replace(ERROR_COUNT, ''))) continue;
    out.push(name!);
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

// `err.message` / `error.message`, and the `instanceof Error ? … : String(…)`
// idiom that is its longhand. `response.error` is NOT this — a bridge reply's
// error field is a string that never was an Error object, so there is no
// structure to lose.
const STRINGIFIED_ERROR = /\binstanceof\s+Error\s*\?|\b(?:err|error|e)\s*\.\s*message\b/;

/** Rule 3: calls to an error sink that pass an already-flattened error. */
export function passesStringifiedError(source: string): string[] {
  const out: string[] = [];
  for (const sink of errorSinks(source)) {
    const call = new RegExp(`\\b${sink}\\s*\\(`, 'g');
    for (const m of source.matchAll(call)) {
      const args = readExpression(source, m.index! + m[0].length);
      if (STRINGIFIED_ERROR.test(args)) out.push(`${sink}(${args.trim().slice(0, 60)})`);
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
    ];
    for (const src of good) {
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
    expect(errorSinks(readFileSync(path.join(ROOT, 'features/flow-health-check.ts'), 'utf8'))).not.toContain(
      'showError',
    );
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
    ]) {
      const source = readFileSync(path.join(ROOT, rel), 'utf8');
      expect(source, `${rel} must render org errors through ui/panels.ts`).toMatch(
        /import \{[^}]*(?:renderSfError|setSfError)[^}]*\} from '\.\.\/ui\/panels\.js'/s,
      );
    }
  });

  it('every defining artifact still exists and still defines something', () => {
    // Stops the exclusion list rotting into a hole: an entry that no longer
    // names the pair is an exclusion nobody needs, and one whose file has moved
    // silently widens the scan's blind spot.
    for (const entry of DEFINING_ARTIFACTS) {
      const source = readFileSync(path.join(ROOT, entry.file), 'utf8');
      expect(
        source.includes(CONSOLE_CLASS) && source.includes(ERROR_CLASS),
        `stale exclusion: ${entry.file} no longer names the error-panel classes`,
      ).toBe(true);
      expect(entry.because.length, `${entry.file} exclusion needs a reason`).toBeGreaterThan(30);
    }
  });

  it('the helper itself would trip rule 1 — which is why it is excluded', () => {
    // Proof that the exclusion is load-bearing rather than decorative: without
    // it, the one legitimate implementation is the first thing flagged. It also
    // pins the const-resolution path, since panels.ts applies the pair through
    // `SF_ERROR_CLASSES` and never as two literals.
    expect(buildsSfErrorPanel(readFileSync(path.join(ROOT, 'ui/panels.ts'), 'utf8'))).toBe(true);
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
