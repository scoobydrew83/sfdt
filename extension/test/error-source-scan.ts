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

/**
 * The parts of a fragment of source that can carry a runtime value: everything
 * except the TEXT inside its string literals, blanked out in place.
 *
 * A quoted string contributes nothing; a template literal contributes its
 * `${…}` holes and not a character of its prose. Nested templates recurse, so
 * prose one level down goes too.
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
 */
export function dynamicParts(source: string): string {
  const out = source.split('');
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i]!;
    if (ch === "'" || ch === '"') {
      const start = ++i;
      while (i < n && source[i] !== ch && source[i] !== '\n') {
        if (source[i] === '\\') i++;
        i++;
      }
      blank(start, i);
      i++;
      continue;
    }
    if (ch === '`') {
      i++;
      while (i < n && source[i] !== '`') {
        if (source[i] === '\\') {
          blank(i, i + 2); // the escape too: `\n` must not leave an `n` behind
          i += 2;
          continue;
        }
        if (source[i] === '$' && source[i + 1] === '{') {
          i += 2;
          const hole = i;
          let depth = 1;
          while (i < n) {
            const c = source[i]!;
            if (c === '{') depth++;
            else if (c === '}') {
              depth--;
              if (depth === 0) break;
            } else if (c === "'" || c === '"' || c === '`') {
              const q = c;
              i++;
              while (i < n && source[i] !== q) {
                if (source[i] === '\\') i++;
                i++;
              }
            }
            i++;
          }
          // The hole is code: keep it, but mask ITS literals too, so prose one
          // template deeper is dropped as well.
          const inner = dynamicParts(source.slice(hole, i));
          for (let k = 0; k < inner.length; k++) out[hole + k] = inner[k]!;
          i++; // past the closing `}`
          continue;
        }
        blank(i, i + 1);
        i++;
      }
      i++;
      continue;
    }
    i++;
  }
  return out.join('');
}

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
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
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
 *   - every `catch (X)` binding — X IS the thrown error, whatever it is called,
 *     which is what closes `ex`, `caught`, `reason`, `problem`, `thrown` and a
 *     bare `e` in one stroke instead of five alternation entries;
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
  for (const m of code.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) holdsError.add(m[1]!);

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
