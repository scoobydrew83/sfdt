// The shared answer to "does this line of source render a caught error?"
//
// Two guards ask it. `sf-error-panel-contract.test.ts` asks it about the code
// PATH (rules 2 and 3: a console pane handed an error, a stringified error
// reaching the shared renderer); `error-render-newlines.test.ts` asks it about
// the rendered RESULT (an element assigned an error must declare a white-space
// rule). They are different checks and they stay in different files, but they
// must not disagree about what an error IS — and for four rounds they did, in
// both directions:
//
//   - `error-render-newlines` accepted `message`/`msg`; rule 2 shipped without
//     them, and a `.sfdt-console` pane assigned from a `const message` was
//     invisible to every rule.
//   - rule 3's `ERRORISH` accepted `ex`/`caught`/`reason`; rule 2 did not, so
//     `catch (ex) { pane.textContent = String(ex); }` walked through.
//
// Patching one alternation to match the other is what produced that cycle. The
// fix is that there is now ONE definition, here, and it is mostly structural:
// an identifier bound by `catch` holds an error whatever it is spelled, and so
// does one bound to an expression that flattens one. The spelling list is the
// FALLBACK for the one binding this file cannot follow — a function parameter,
// which is bound by the caller (`showError(message)`, the funnel #308 was
// reported against).
//
// ── Why there is no `LITERAL_ONLY` here ─────────────────────────────────────
//
// Both guards used to carry this suppressor:
//
//     const LITERAL_ONLY = /=\s*['"`][^'"`]*['"`]\s*;?\s*$/;
//
// The intent was sound — fixed copy (`pane.textContent = 'Loading log…'`)
// cannot carry a thrown error. The execution was not: the character class
// excludes quotes but not `$` or `{`, so a template literal that INTERPOLATES
// an error read as fixed copy, and
//
//     preview.textContent = `Could not save: ${err instanceof Error ? err.message : String(err)}`;
//
// — the #308 defect, in a `.sfdt-console` pane, with no error class and no
// `role="alert"` — was suppressed on both guards at once.
//
// `dynamicParts()` below is the same intent expressed so it cannot fail that
// way. Instead of asking "is the whole right-hand side one literal?" it DELETES
// the static text and asks the question of what survives: a template literal's
// prose goes, its `${…}` holes stay. There is no spelling of a literal that can
// smuggle a value past it, because a value is exactly what it keeps.

import ts from 'typescript';

/** Every identifier token in a fragment of source. */
export function identifiersIn(expression: string): string[] {
  return [...expression.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)].map((m) => m[1]!);
}

// ── Reading one expression out of source ────────────────────────────────────

/**
 * A line that opens with one of these continues the expression above it.
 *
 * Prettier wraps a long right-hand side onto the next line and leaves the
 * operator at the END of the line above as often as at the start of the one
 * below, so `ENDS_OPEN` is the other half of the same question. Rule 2 used to
 * read `[^;\n]*` — a single line — and both of these Prettier-produced shapes
 * walked straight through it:
 *
 *     preview.textContent =
 *       'Could not save the naming pattern: ' +
 *       (err instanceof Error ? err.message : String(err));
 *
 *     preview.textContent = [
 *       'Could not save the naming pattern.',
 *       err instanceof Error ? err.message : String(err),
 *     ].join('\n');
 */
const CONTINUES_LINE = /^[?:.+&|,)\]}]/;
const ENDS_OPEN = /[+\-*/%,?:&|=([{.]\s*$/;

/**
 * Read one expression forward from `from`, respecting nesting and strings.
 *
 * Stops at the `)` that closes the call we are inside, or at the `;` of a bare
 * assignment. A depth-zero newline ends it too — but only when neither side of
 * the break is left open, because a wrapped assignment is ordinary formatting
 * and reading only to the first newline records an empty expression.
 */
export function readExpression(source: string, from: number): string {
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
      const so = source.slice(from, i);
      const nextLine = source.slice(i + 1).replace(/^[ \t\r\n]*/, '');
      if (so.trim() !== '' && !ENDS_OPEN.test(so) && !CONTINUES_LINE.test(nextLine)) {
        return so;
      }
    }
  }
  return source.slice(from);
}

// ── Static copy versus a runtime value ──────────────────────────────────────
const CACHE_BUDGET_CHARS = 4 * 1024 * 1024;

class MaskCache {
  private readonly entries = new Map<string, string>();
  private chars = 0;

  get(key: string): string | undefined {
    return this.entries.get(key);
  }

  set(key: string, value: string): void {
    if (this.chars + key.length + value.length > CACHE_BUDGET_CHARS) {
      this.entries.clear();
      this.chars = 0;
    }
    this.entries.set(key, value);
    this.chars += key.length + value.length;
  }
}

/**
 * The parts of a fragment of source that can carry a runtime value: everything
 * except the TEXT inside its string and template literals, its regex literals
 * and its COMMENTS, blanked out in place.
 *
 * A quoted string contributes nothing; a template literal contributes its
 * `${…}` holes and not a character of its prose. Nested templates fall out for
 * free, because each one is its own run of literal tokens.
 *
 * Length- and newline-preserving on purpose. That makes it safe to run over a
 * WHOLE FILE before scanning it, which is the second thing it is for: a regex
 * looking for `X = …` has no idea whether it is inside code or inside a string,
 * and `features/soql-runner.ts` embeds a Python code template containing
 *
 *     query = """
 *
 * — which a binding scan read as a real assignment, in a real file, and bound a
 * real identifier to whatever the following prose happened to mention. Masking
 * first removes that whole class of phantom match while keeping every offset
 * and line number exactly where it was.
 *
 * ── Why this asks TypeScript instead of scanning characters ─────────────────
 *
 * The first version of this function walked the source itself, and it shipped a
 * regression to `develop` in #327. Its template branch was
 *
 *     if (ch === '`') { i++; while (i < n && source[i] !== '`') { … } }
 *
 * — not newline-bounded, unlike the `'`/`"` branch above it. In real TypeScript
 * a template literal cannot be left unterminated, so an unmatched backtick can
 * only come from a COMMENT or a REGEX, and that scanner parsed neither. One
 * backtick in one comment therefore opened a mask that ran to the next backtick
 * anywhere in the file. Measured on `features/rest-explore.ts`: a backtick
 * appended to the header comment at line 38 blanked 7,588 characters through to
 * line 108 and took the file's only `.textContent =` with it, silently, with no
 * test failing — blinding rule 2, rule 3 and the whole newlines guard over
 * seventy lines of a live feature file. 93 of 125 scanned files carry backticks
 * inside comments (1,819 of them); every one is balanced today by convention
 * alone, and it takes one markdown fence or one `` don`t `` to go dark.
 *
 * Bounding the backtick scan by newline was not available: this codebase's real
 * template literals (the CSS sheet, the Python template in `soql-runner.ts`)
 * span lines, and stopping at the first newline puts the phantom-binding class
 * straight back. Handling comments needs a scanner that knows strings; handling
 * a backtick inside `` /[`]/ `` needs one that knows regex-versus-division. Any
 * of those hand-rolled is one more pattern that has to guess, and this guard's
 * whole history is patterns that guessed wrong in a way nobody could see.
 *
 * So it asks the compiler. `ts.createSourceFile()` is the language's own answer
 * to where a literal starts and stops — it is not an approximation of the
 * grammar, it IS the grammar, and it cannot be defeated by an odd backtick
 * because it never has to guess what one means. Comments come second, on the
 * already-blanked buffer, where a `//` or `/*` is unambiguous by construction:
 * every string interior is spaces and every regex is gone, so no `/` that
 * remains is inside a literal, and a `//` in JavaScript is never two divisions.
 *
 * `typescript` is already an extension devDependency (it is what `npx tsc
 * --noEmit` runs), this module is test-only, and nothing here reaches the
 * shipped bundle.
 */
export function dynamicParts(source: string): string {
  const cached = MASKED.get(source);
  if (cached !== undefined) return cached;
  const masked = maskStaticText(source);
  // The guards mask the same whole file several times over (once per rule, and
  // again for the binding scan). Bounded by BYTES, so neither a long run of
  // unique expression fragments nor a tree-wide property test that masks a
  // modified copy of every file can grow it without limit — see `MaskCache`.
  MASKED.set(source, masked);
  return masked;
}

const MASKED = new MaskCache();
/**
 * The three masking caches, bounded in BYTES and not only in entries.
 *
 * `MASKED.size < 8192` bounded the entry COUNT, which is the wrong quantity: a
 * whole scanned file is tens of kilobytes, so 8192 of them is hundreds of
 * megabytes per cache and there are three. The tree-wide backtick property
 * masks one modified copy of every file per comment — thousands of unique
 * buffers, none of which is ever asked for twice — and measured, that took the
 * worker to 1.1 GB of resident memory and made the parse itself slower than the
 * work it was avoiding. The reviewer of #329 named unbounded growth as the one
 * thing about this module they had not profiled; this is that, bounded.
 *
 * A budget rather than an LRU. Every real caller masks the same handful of
 * whole files over and over, so the cheap policy — clear when the budget is
 * exceeded and start again — keeps the hit rate that matters and cannot leak.
 */

/** The literal kinds whose TEXT is static copy, and the delimiters to keep. */
function literalInterior(kind: ts.SyntaxKind, start: number, end: number): [number, number] {
  switch (kind) {
    // `` `…${ `` and `` }…${ `` — two closing characters, not one.
    case ts.SyntaxKind.TemplateHead:
    case ts.SyntaxKind.TemplateMiddle:
      return [start + 1, end - 2];
    // A regex is not copy and not a value: blank it whole. This is also what
    // keeps a backtick inside a character class from ever being read as one.
    case ts.SyntaxKind.RegularExpressionLiteral:
      return [start, end];
    default:
      return [start + 1, end - 1];
  }
}

/**
 * Blank a range in place, keeping newlines.
 *
 * Every offset AND every line number is preserved, which is what lets both
 * guards compute `file:line` from a masked buffer and then look the element up
 * in the raw one.
 */
function blankInto(out: string[], from: number, to: number): void {
  for (let k = Math.max(from, 0); k < Math.min(to, out.length); k++) {
    if (out[k] !== '\n') out[k] = ' ';
  }
}

/**
 * Refuse to answer, loudly, rather than answer with silence.
 *
 * `blankLiterals()` asked `ts.createSourceFile()` for the literal spans and
 * never asked whether the parser had actually been able to READ the source.
 * Review demonstrated the consequence:
 *
 *     dynamicParts('/* never closed\npane.textContent = err.message;')
 *       →  '               \n                               '
 *
 * The whole buffer comes back blank, and a blank buffer is one every rule reads
 * as containing no code at all. That is not a wrong answer, it is NO answer,
 * delivered green — the same failure shape as `LITERAL_ONLY` and as #327's
 * backtick, and this guard has now shipped that shape three times.
 *
 * It is unreachable today, and the reason is an ORDERING accident rather than a
 * guarantee: `.github/workflows/extension.yml` runs `tsc --noEmit` before the
 * tests, and a failing step stops the job, so a non-parsing file cannot reach
 * the guard. Reorder the workflow, or run vitest by hand, and it can.
 *
 * What it refuses on is narrow on purpose. `dynamicParts()` is fed EXPRESSION
 * FRAGMENTS as well as whole files — `readExpression()` hands it things like
 * `(): boolean =>` and `> void`, and re-masking an already-masked fragment
 * turns a blanked regex into `replace( , ' ')`. Measured across the whole
 * extension suite: 385 masked inputs carry a parse diagnostic and every one of
 * them is such a fragment. So "any diagnostic" is the wrong trigger; it would
 * make the mask refuse to do its job.
 *
 * The trigger is the runaway itself, and the compiler reports it directly:
 * a literal the scanner marks `isUnterminated`, or a block comment whose
 * closing delimiter is never found. Those are the only two ways a mask can
 * blank past the thing it was asked to blank, because the spans it uses come
 * from the SCANNER — a stray brace makes the parser recover, it does not move a
 * quote. Measured across the same suite: zero occurrences, so this refuses
 * nothing the guards legitimately ask.
 */
function refuseRunaway(what: string, source: string, at: number): never {
  const line = source.slice(0, at).split('\n').length;
  throw new Error(
    `error-source-scan: refusing to mask source with an unterminated ${what} (line ${line}). ` +
      'Everything after it would be blanked, and a blanked region is one every rule reads as ' +
      'containing no code — so the scan would go silent over it and the suite would stay ' +
      'green. Fix the source, or the fragment being scanned; do not relax this check.\n' +
      `--- first 200 characters of what was handed to the mask ---\n${source.slice(0, 200)}`,
  );
}

/** The source with the TEXT of every literal emptied — the parser's answer. */
function blankLiterals(source: string): string {
  const cached = NO_LITERALS.get(source);
  if (cached !== undefined) return cached;
  const out = source.split('');
  const file = ts.createSourceFile(
    'scan.ts',
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  const visit = (node: ts.Node): void => {
    switch (node.kind) {
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      case ts.SyntaxKind.TemplateHead:
      case ts.SyntaxKind.TemplateMiddle:
      case ts.SyntaxKind.TemplateTail:
      case ts.SyntaxKind.RegularExpressionLiteral: {
        const start = node.getStart(file);
        // Fail closed: an unterminated literal runs to the end of the buffer
        // and takes every rule with it. See `refuseRunaway()`.
        if ((node as ts.LiteralLikeNode).isUnterminated === true) {
          refuseRunaway(ts.SyntaxKind[node.kind]!, source, start);
        }
        const [from, to] = literalInterior(node.kind, start, node.end);
        blankInto(out, from, to);
        break;
      }
      default:
        break;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  const emptied = out.join('');
  NO_LITERALS.set(source, emptied);
  return emptied;
}

const NO_LITERALS = new MaskCache();

/**
 * Where the comments are.
 *
 * Found on the literal-emptied buffer, where the question is decidable without
 * context: a `/` inside a string is now a space, a regex is gone entirely, and
 * a `//` in JavaScript is never two divisions. Reading comments off the RAW
 * source instead is what makes a scanner need to know regex-from-division, and
 * getting that wrong is how #327's masker could be opened by a backtick.
 */
function commentRanges(source: string): [number, number][] {
  const emptied = blankLiterals(source);
  const ranges: [number, number][] = [];
  let i = 0;
  while (i < emptied.length - 1) {
    if (emptied[i] === '/' && emptied[i + 1] === '/') {
      let end = i;
      while (end < emptied.length && emptied[end] !== '\n') end++;
      ranges.push([i, end]);
      i = end;
    } else if (emptied[i] === '/' && emptied[i + 1] === '*') {
      const close = emptied.indexOf('*/', i + 2);
      // The other runaway. `close === -1` used to mean "blank everything from
      // here to EOF", silently. See `refuseRunaway()`.
      if (close === -1) refuseRunaway('block comment', source, i);
      const end = close + 2;
      ranges.push([i, end]);
      i = end;
    } else {
      i++;
    }
  }
  return ranges;
}

function maskStaticText(source: string): string {
  const out = blankLiterals(source).split('');
  for (const [from, to] of commentRanges(source)) blankInto(out, from, to);
  return out.join('');
}

/**
 * The source with its COMMENTS emptied and everything else — string literals
 * included — left exactly where it was.
 *
 * For rule 1, which `dynamicParts()` cannot serve: that mask deletes the inside
 * of every string literal, and a class name is a string literal. Reading rule 1
 * through it makes `ui/panels.ts` stop tripping the rule it is excluded FOR.
 * Measured: rule 1 over the mask flips exactly one file, and it is that one.
 *
 * What rule 1 does need is the comment half, because it reads raw source today
 * and a commented-out hand-roll therefore reports as a live one. No such
 * comment is in the tree — this is a latent false positive, not a hole, and it
 * fires in the safe direction — but the machinery to remove it is already here,
 * and it costs nothing: measured over every scanned file, no rule-1 verdict
 * changes.
 */
export function withoutComments(source: string): string {
  const cached = NO_COMMENTS.get(source);
  if (cached !== undefined) return cached;
  const out = source.split('');
  for (const [from, to] of commentRanges(source)) blankInto(out, from, to);
  const stripped = out.join('');
  NO_COMMENTS.set(source, stripped);
  return stripped;
}

const NO_COMMENTS = new MaskCache();

// ── What an error is called ─────────────────────────────────────────────────

// The spelling fallback, as WORDS rather than as an alternation of whole
// identifiers. `\berr\b` never matched `errMsg`, `errMessage`, `sfError` or
// `errorText` — all names this codebase writes — so every compound was a hole
// that a longer alternation would only have papered over one spelling at a
// time. Splitting the identifier on its camelCase boundaries and asking whether
// any WORD is an error word closes the class instead of the instances.
//
// Deliberately absent: `reason`, `failure`, `problem`, `thrown`, `detail`,
// `text`, `bodyText`, `out`, and a bare `e`. They are ordinary English words
// this codebase uses for things that are not errors — `ui/apex-log-analyzer.ts`
// names a LOG TRUNCATION reason `reason` and interpolates it into a banner, and
// claiming that word by spelling flags correct code. None of them needs to be
// here: as a `catch` binding they are reached by the catch clause, and as
// `const detail = err instanceof Error ? …` by the binding scan. Structure
// covers exactly the names spelling cannot afford to claim, which is why the
// two halves are worth having separately.
//
// That last sentence was written as if it covered all of them, and for `reason`
// it did not. `PromiseRejectedResult.reason` is a property name the LANGUAGE
// mandates on a settled result — no catch clause reaches it, no declaration
// binds it, and so nothing here reached it either. It is reached structurally
// now, scoped to files that provably handle settled results; see
// `handlesSettledResults()`. `reason` stays off this list, because the
// apex-log-analyzer case above is exactly why it must.
const ERROR_WORDS: ReadonlySet<string> = new Set([
  'err',
  'errs',
  'error',
  'errors',
  'errmsg',
  'ex',
  'caught',
  'message',
  'msg',
]);

function wordsOf(identifier: string): string[] {
  return (
    identifier
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      // …and a DIGIT is a boundary too. Without this, `err2` is one word and is
      // not `err`, so a numbered local — the ordinary thing to write in a catch
      // sitting next to an outer `err` — was off the spelling list entirely.
      // Review hit it as a control case and had to re-derive why it came back
      // uncaught (#327, N3).
      .replace(/([A-Za-z])(\d)/g, '$1 $2')
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .map((w) => w.toLowerCase())
  );
}

/** Is this identifier spelled like it holds an error? */
export function isErrorName(identifier: string): boolean {
  return wordsOf(identifier).some((w) => ERROR_WORDS.has(w));
}

// A `.length` is a count, not a message: `${result.errors.length} flows could
// not be loaded` has no org text in it and no guidance line to preserve.
const COUNT_ACCESS = /\b[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*\.\s*length\b/g;

/** Does this expression name something spelled like an error (a count aside)? */
export function rendersAnErrorValue(expression: string): boolean {
  return identifiersIn(dynamicParts(expression).replace(COUNT_ACCESS, ' ')).some(isErrorName);
}

// ── Flattening an error into a string ───────────────────────────────────────

// The idioms that turn an error object into a string, each paired with the
// SUBJECT it has to be applied to.
//
// Pairing them is the point. An earlier form asked "does the expression contain
// an idiom, AND does it mention an error-ish name anywhere?" — two independent
// questions, which lets one idiom borrow another expression's subject:
// `const lines = [summary.message]` in `apex-anonymous.ts` reads as a flattened
// error, because `.message` is an idiom and `message` is an error word, even
// though `summary` is an Execute Anonymous RESULT and not a failure at all.
// Asking each idiom about its own subject cannot make that mistake.
const IDIOMS: { pattern: RegExp; subject: 'always' | 'group' }[] = [
  // `x instanceof Error ? …` — a flatten by construction, whatever x is called.
  { pattern: /\binstanceof\s+Error\s*\?/g, subject: 'always' },
  // `err.message`, `e?.message`, `(err as Error).message`. The OBJECT must be
  // an error: `response.error` and `summary.message` are payload fields that
  // never were an Error, so there is no structure to lose.
  { pattern: /([A-Za-z_$][\w$]*)\s*\)?\s*\??\s*\.\s*message\b/g, subject: 'group' },
  // `String(err)` — the argument must be one.
  { pattern: /\bString\s*\(\s*([^)]*)\)/g, subject: 'group' },
  // `err.toString()` — the receiver must be one.
  { pattern: /([A-Za-z_$][\w$]*)\s*\)?\s*\??\s*\.\s*toString\s*\(\s*\)/g, subject: 'group' },
];

// `${err}` — interpolating an Error calls toString() on it. A BARE identifier
// only, and an error-ish one: `${response.error}` is a bridge reply's string
// field, and `${root}` in `schema-browser.ts` is an sObject name.
const BARE_INTERPOLATION = /\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g;

/**
 * Does this expression flatten an error into a string?
 *
 * Every idiom needs an error for a subject. Without that the rule fires on
 * `String(jobId)` in apex-test-runner — a Salesforce record id being
 * normalised, interpolated into our own prose — and flagging that would mean
 * editing correct code to satisfy a check.
 *
 * The subject test runs over `dynamicParts()`, so prose that happens to contain
 * the word "errors" is never mistaken for one; the interpolation idiom is
 * matched against the raw expression, because the `${…}` syntax IS the idiom.
 */
export function flattensAnError(
  expression: string,
  names: ReadonlySet<string> = new Set(),
): boolean {
  const errorish = (id: string): boolean => isErrorName(id) || names.has(id);
  const dynamic = dynamicParts(expression);
  for (const { pattern, subject } of IDIOMS) {
    for (const m of dynamic.matchAll(pattern)) {
      if (subject === 'always') return true;
      if (identifiersIn(m[1] ?? '').some(errorish)) return true;
    }
  }
  for (const m of expression.matchAll(BARE_INTERPOLATION)) {
    if (errorish(m[1]!)) return true;
  }
  return false;
}

/**
 * The identifier a `catch` binds — in BOTH the spellings the language has.
 *
 * `try { … } catch (e) { … }` is the statement form. `.catch((e) => …)` is the
 * promise form, and they are the same binding to a reader and to the language:
 * `e` IS the thrown error in each. #327 shipped `\bcatch\s*\(\s*(\w+)` for
 * this, and `\s*` does not match `(` — so the statement form was seen and the
 * promise form was not, in the very mechanism that round advertised as having
 * replaced spelling with structure.
 *
 * The parenthesised promise form is not a stylistic option here. Prettier 3
 * defaults `arrowParens` to `"always"` and this repo's `.prettierrc` sets no
 * override, so a single arrow parameter is ALWAYS parenthesised — `.catch((e)
 * => …)` is the only shape `prettier --write` will ever emit, and the tree
 * already writes it (`lib/spa-router.ts`, `entrypoints/background.ts`). Both of
 * those happen to be spelled `err`, so the spelling fallback was covering them
 * and the gap did not show; renaming one is all it took.
 *
 * `async` and `function` heads are skipped rather than captured for the same
 * reason: `.catch(async (e) => …)` and `.catch(function (e) { … })` bind `e`,
 * not the keyword in front of it.
 *
 * Deliberately LOOSE in one direction, named here rather than patched: a bare
 * callback reference is read as if it were a parameter, so `.catch(handleError)`
 * binds `handleError`, `.catch(reject)` binds `reject` and `.catch(console.error)`
 * binds `console`. None of those is an identifier a `catch` binds. It is a
 * false-positive direction only — an extra name in `holdsError` makes a rule
 * fire, never go quiet — and it does not fire: measured over the tree, there
 * are ZERO `.catch(<identifier>)` sites, and the binding scan produces 11
 * distinct names across all 125 scanned files with nothing spurious among them
 * (no `this`, `doc`, `el`, `pane`). Tightening it means deciding between three
 * shapes —
 * `=>` for an arrow, `)` `{` for a statement clause, `:` for an annotated one —
 * which is one more pattern that has to guess, for a defect that has never
 * occurred. `binds a bare callback reference too, and that is a decision` in
 * `error-source-scan.test.ts` pins the behaviour so it cannot drift unnoticed.
 *
 * Deliberately NOT here: `.then(onOk, (e) => …)`. A rejection handler in
 * `.then`'s second argument is a real binding this misses, but finding it means
 * splitting an argument list on the comma that separates two arbitrary
 * expressions — a different and much less reliable question than reading
 * forward from the word `catch`. It is named in the PR body as open rather than
 * closed by a pattern that would have to guess.
 */
const CATCH_BINDING =
  /\bcatch\s*\(\s*(?:async\b\s*)?(?:function\b\s*\*?\s*(?:[A-Za-z_$][\w$]*\s*)?)?\(?\s*([A-Za-z_$][\w$]*)/g;

/**
 * A rejected settlement's `.reason` — the FOURTH way to hold a thrown error,
 * and the only one that is not a name anybody chose.
 *
 * `reason` is deliberately off `ERROR_WORDS`, and the justification written
 * there is that the absent words "as a `catch` binding are reached by the catch
 * clause". That is true of `problem`, `thrown` and a bare `e`. It is false of
 * this one: `PromiseRejectedResult.reason` is a property name the LANGUAGE
 * mandates on a settled result. No `catch` clause binds it, no author picked
 * it, and nothing in this module named it — so the thrown value arrived through
 * a door with no lock on it.
 *
 * It was not a live hole, by accident and not by design.
 * `features/org-health-checks.ts` happened to write
 *
 *     s.reason instanceof Error ? s.reason.message : String(s.reason)
 *
 * and `instanceof Error ?` has `subject: 'always'`, so the scan caught the site
 * on the IDIOM and never had to know what `reason` was. Simplify that one line
 * to `String(s.reason)` — an entirely ordinary edit, and the shape a reviewer
 * constructed — and the site went dark on every rule at once. Measured, both
 * before and after this: it did, and it no longer does.
 *
 * Scoped by EVIDENCE rather than added to the spelling list, because the
 * spelling list is right to refuse the word: `ui/apex-log-analyzer.ts` names a
 * log-TRUNCATION reason `reason` and interpolates it into a banner, which is
 * correct code that a spelling claim would flag. `reason` means the rejection
 * reason in a file that provably handles settled results, and means whatever
 * its author wants everywhere else.
 *
 * Two markers, either sufficient:
 *
 *   - `Promise.allSettled(` — the only thing in the language that produces
 *     settled results;
 *   - `X.status === 'rejected'` / `!== 'fulfilled'` — the narrowing TypeScript
 *     REQUIRES before `.reason` is reachable at all, so it is present wherever
 *     a reason is actually read, whoever created the promise.
 *
 * Measured over the 125 scanned files: exactly two carry either marker
 * (`features/org-health-checks.ts`, `features/soql-bulk-delete.ts`), and the
 * widening reports zero new sites. Inside `soql-bulk-delete.ts` it also claims
 * `planned.reason`, which is a domain rejection CODE and not a thrown error —
 * over-claiming, confined to the two files that handle settlements, in the
 * direction that produces a site to look at rather than a rule that goes quiet.
 */
const ALL_SETTLED = /\bPromise\s*\.\s*allSettled\s*\(/;
const SETTLED_NARROWING = /([A-Za-z_$][\w$]*)\s*\??\s*\.\s*status\s*(?:===|!==)\s*['"]/g;

function handlesSettledResults(code: string, source: string): boolean {
  if (ALL_SETTLED.test(code)) return true;
  // Matched on the MASKED buffer, so a mention inside a comment or a string is
  // not evidence — then read back out of the RAW one at the same offset, which
  // is what the mask's offset preservation is for. The literal's interior is
  // blanked in `code`, so the state name is only legible in `source`.
  for (const m of code.matchAll(SETTLED_NARROWING)) {
    const interior = m.index + m[0].length;
    const literal = source.slice(interior, interior + 9);
    if (literal.startsWith('rejected') || literal.startsWith('fulfilled')) return true;
  }
  return false;
}

export interface ErrorBindings {
  /** Holds an error in ANY form — the thrown object, or its text. */
  holdsError: Set<string>;
  /**
   * Holds an error that has ALREADY been flattened to a string. A strict
   * subset, and the distinction is load-bearing: rule 3 fires on a flattened
   * error reaching the renderer, and `catch (err) { renderSfError(err) }` is
   * the CORRECT call. Conflating the two sets would flag every correct site in
   * the codebase.
   */
  flattened: Set<string>;
}

/**
 * The identifiers in this file that hold an error, worked out from the code
 * rather than from a list of spellings.
 *
 *   - every `catch` binding, in both the statement form `catch (X)` and the
 *     promise form `.catch((X) => …)` — X IS the thrown error, whatever it is
 *     called, which is what closes `ex`, `caught`, `reason`, `problem`,
 *     `thrown` and a bare `e` in one stroke instead of five alternation
 *     entries. See `CATCH_BINDING` for why the second form is not optional;
 *   - `reason`, in a file that provably handles `Promise.allSettled` results —
 *     the one binding the LANGUAGE makes rather than the author. See
 *     `handlesSettledResults()`;
 *   - every `const`/`let`/`var X = <expression that flattens one>` — the
 *     ordinary refactor when the value is needed twice;
 *   - and aliases of either, to a fixed point, so `const detail = err.message;
 *     const shown = detail;` reaches `shown`.
 *
 * What it cannot reach is a value bound by a function PARAMETER, because the
 * binding happens at the call site. That is the hole `isErrorName()` covers by
 * spelling, and the two-hop in-file funnel —
 *
 *     const show = (m: string): void => { pane.textContent = m; };
 *     show(err instanceof Error ? err.message : String(err));
 *
 * — is what neither closes. Named here as a decision; closing it needs
 * parameter-level dataflow, which is a different kind of tool.
 */
export function errorBoundNames(source: string): ErrorBindings {
  const holdsError = new Set<string>();
  const flattened = new Set<string>();
  // Masked, so a `X = …` written inside a string literal is not read as a
  // binding. `features/soql-runner.ts` embeds Python containing `query = """`.
  const code = dynamicParts(source);
  for (const m of code.matchAll(CATCH_BINDING)) holdsError.add(m[1]!);
  // …and the binding the language makes rather than the author:
  // `PromiseRejectedResult.reason`. See `handlesSettledResults()` for why this
  // is scoped to files that provably handle settled results instead of going on
  // the spelling list, and for the tree-wide measurement behind that scoping.
  if (handlesSettledResults(code, source)) holdsError.add('reason');

  // Declarations, and later writes to the same name. The `+=` accumulator —
  //
  //     let out = 'Save failed. ';
  //     out += err instanceof Error ? err.message : String(err);
  //
  // — is the natural shape for a lead-in and would otherwise never be a
  // binding this scan saw, because the declaration alone flattens nothing. A
  // reassigned name therefore holds the UNION of everything ever written to it,
  // which is the conservative reading and the one rule 1 already takes.
  const declaration = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=/g;
  // `(?![=>])` keeps this off `==` and off `err => …`: an arrow parameter is
  // not an assignment, and reading the arrow BODY as its right-hand side bound
  // every `.catch(err => { … })` callback's parameter to whatever it mentioned.
  const reassignment = /(?<![.\w$])([A-Za-z_$][\w$]*)\s*\+?=(?![=>])/g;
  for (let pass = 0; pass < 4; pass++) {
    const before = holdsError.size + flattened.size;
    for (const pattern of [declaration, reassignment]) {
      for (const m of code.matchAll(pattern)) {
        const name = m[1]!;
        const rhs = readExpression(code, m.index! + m[0].length);
        const alias = rhs.trim();
        const isAlias = /^[A-Za-z_$][\w$]*$/.test(alias);
        if (flattensAnError(rhs, holdsError) || (isAlias && flattened.has(alias))) {
          holdsError.add(name);
          flattened.add(name);
        } else if (isAlias && holdsError.has(alias)) {
          holdsError.add(name);
        }
      }
    }
    if (holdsError.size + flattened.size === before) break;
  }
  return { holdsError, flattened };
}

/**
 * Does this expression hand over a caught error's text?
 *
 * The union of the three ways to know: it flattens one inline, it names a
 * binding this file has already tied to one, or — for the parameter case that
 * neither reaches — it is spelled like one. Assigning the raw error object to
 * `textContent` stringifies it just as surely as `String(err)` would, so this
 * asks about `holdsError`, not `flattened`.
 */
export function carriesAnError(expression: string, names: ReadonlySet<string>): boolean {
  if (flattensAnError(expression, names)) return true;
  const dynamic = dynamicParts(expression).replace(COUNT_ACCESS, ' ');
  return identifiersIn(dynamic).some((id) => names.has(id) || isErrorName(id));
}
