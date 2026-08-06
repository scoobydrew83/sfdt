// The properties of the shared scanner, asserted over the real tree.
//
// `test/error-source-scan.ts` is the one definition of "does this line of
// source render a caught error?", and both guards —
// `sf-error-panel-contract.test.ts` (rules 1-3) and
// `error-render-newlines.test.ts` — read the tree through its `dynamicParts()`
// mask before they scan a single character. That makes the mask a single point
// of failure for every rule at once, and #327 proved it: a masker bug did not
// produce a wrong ANSWER, it produced no answer at all, over seventy lines of a
// live feature file, with the whole suite green.
//
// The cases each guard needs live with that guard. What lives here is the class
// of property a case cannot reach — the ones that have to hold for every file
// in the tree, because the failure mode is silence and the only way to see
// silence is to measure it everywhere.
//
// Golden principle #12: `test/` is not scanned by either guard, so this file is
// not an artifact of the checks it exercises.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ts from 'typescript';
import {
  carriesAnError,
  dynamicParts,
  errorBoundNames,
  identifiersIn,
} from './error-source-scan.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// The union of what the two guards scan: `error-render-newlines` takes
// `features` + `ui`, the sweep takes those plus `entrypoints` + `lib`.
const SCANNED_DIRS = ['features', 'ui', 'entrypoints', 'lib'];

function scannedSources(): { rel: string; source: string }[] {
  const out: { rel: string; source: string }[] = [];
  const walk = (abs: string): void => {
    for (const name of readdirSync(abs)) {
      const full = path.join(abs, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.ts') && !full.endsWith('.d.ts')) {
        out.push({ rel: path.relative(ROOT, full), source: readFileSync(full, 'utf8') });
      }
    }
  };
  for (const dir of SCANNED_DIRS) walk(path.join(ROOT, dir));
  return out;
}

describe('the mask every rule reads the tree through', () => {
  it('scans a tree worth scanning', () => {
    // A tree-wide assertion that silently matched nothing stays green forever.
    expect(scannedSources().length).toBeGreaterThan(100);
  });

  it('preserves every offset and every line number, in every file', () => {
    // Both guards report `file:line` computed from the MASKED buffer and then
    // look the element up in the RAW one. Drift here does not fail anything —
    // it just points the report at the wrong line and reads the wrong source.
    const drifted: string[] = [];
    for (const { rel, source } of scannedSources()) {
      const masked = dynamicParts(source);
      if (masked.length !== source.length) drifted.push(`${rel}: length`);
      if (masked.split('\n').length !== source.split('\n').length) drifted.push(`${rel}: lines`);
    }
    expect(drifted).toEqual([]);
  });

  it('is idempotent, in every file', () => {
    // Masking output that is already masked must be a no-op. A mask that keeps
    // finding new things to blank is a mask that has not settled on what code
    // is, which is the shape of a runaway.
    const unstable: string[] = [];
    for (const { rel, source } of scannedSources()) {
      const once = dynamicParts(source);
      if (dynamicParts(once) !== once) unstable.push(rel);
    }
    expect(unstable).toEqual([]);
  });

  it('parses every file it masks, with no diagnostics at all', () => {
    // The mask trusts `ts.createSourceFile()` for where every literal starts
    // and stops. If the parser cannot read a file, the spans it reports are not
    // the file's spans — and the guards would go on scanning it as if they
    // were. Nothing anywhere asserted that the tree actually parses; the reason
    // it does is that `.github/workflows/extension.yml` runs `tsc --noEmit`
    // before `npm run test:extension` and a failed step stops the job. That is
    // an ORDERING accident, not a guarantee, and it is invisible from here.
    //
    // So the suite states it itself. Cheap — one parse per file — and it turns
    // "the mask read something it did not understand" from silence into a name.
    const unreadable: string[] = [];
    for (const { rel, source } of scannedSources()) {
      const file = ts.createSourceFile(
        rel,
        source,
        ts.ScriptTarget.Latest,
        false,
        ts.ScriptKind.TS,
      );
      const diagnostics = (file as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] })
        .parseDiagnostics;
      for (const d of diagnostics ?? []) {
        unreadable.push(`${rel}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
      }
    }
    expect(unreadable).toEqual([]);
  });

  it('refuses to answer rather than blanking a file it could not read', () => {
    // The fail-OPEN the #329 review demonstrated: `blankLiterals()` never
    // consulted the parser's own verdict, so an unterminated comment blanked
    // the whole buffer and every rule read the result as containing no code —
    // green, silent, and wrong. Same failure SHAPE as `LITERAL_ONLY` and as
    // #327's backtick, which is three for three.
    //
    // What it refuses on is narrow and mechanical: a literal the scanner marks
    // `isUnterminated`, or a block comment whose close is never found. Those
    // are the only two ways the mask can blank past its target, because the
    // spans it uses come from the SCANNER — a stray brace makes the PARSER
    // recover, it does not move a quote.
    expect(() => dynamicParts('/* never closed\npane.textContent = err.message;')).toThrow(
      /unterminated block comment/,
    );
    expect(() => dynamicParts("const s = 'never closed\npane.textContent = err.message;")).toThrow(
      /unterminated/,
    );
    expect(() => dynamicParts('const s = `never closed;')).toThrow(/unterminated/);
    expect(() => dynamicParts('const r = /never-closed\npane.textContent = err.message;')).toThrow(
      /unterminated/,
    );
    // …and the demonstration itself: before this, that first input came back as
    // nothing but spaces and newlines, and nothing anywhere noticed.
    let masked = '';
    try {
      masked = dynamicParts('/* never closed\npane.textContent = err.message;');
    } catch {
      masked = '(refused)';
    }
    expect(masked).toBe('(refused)');
  });

  it('still answers for the FRAGMENTS the guards legitimately hand it', () => {
    // The reason the trigger is the runaway and not "any parse diagnostic".
    // `dynamicParts()` is fed expression fragments as well as whole files —
    // `readExpression()` produces them by cutting an expression out of the
    // middle of a statement, and re-masking an already-masked fragment turns a
    // blanked regex into `replace( , ' ')`. Measured across the whole extension
    // suite: 385 masked inputs carry a parse diagnostic and every one is such a
    // fragment; zero carry an unterminated literal or comment. Refusing on any
    // diagnostic would make the mask refuse to do its job.
    for (const fragment of [
      '(): boolean =>',
      '> void',
      "raw.replace( , ' ')",
      'errorPanel, message, { doc }',
      ' unknown>(key: string): Promise<T | null> {',
    ]) {
      expect(() => dynamicParts(fragment), fragment).not.toThrow();
    }
  });

  it('cannot be blinded by one stray backtick, in any file in the tree', () => {
    // This is B1 of the #327 review as a PROPERTY, and it is the assertion that
    // could not have been satisfied by the masker that shipped.
    //
    // That masker read every backtick as a template delimiter and did not bound
    // the scan at a newline, so a backtick that opens no template — a markdown
    // fence in a comment, a `` don`t ``, a `` /[`]/ `` — started a mask running
    // to the next backtick anywhere in the file. Measured on
    // `features/rest-explore.ts`: one backtick appended to the header comment
    // at line 38 blanked 7,588 characters through to line 108 and took the
    // file's only `.textContent =` with it. 93 of the files below carry
    // backticks inside comments, 1,819 in total, balanced today by convention
    // and by nothing else.
    //
    // The property: adding a backtick at a position the mask ALREADY treats as
    // static text must not change what the mask considers code — anywhere in
    // the file. Identifiers rather than raw output, because the injection
    // shifts every offset after it by one; a comment contributes no identifier
    // either way, so the two lists must be equal.
    // ── How many positions, and why not all of them ─────────────────────────
    //
    // As shipped in #329 this probed ONE offset per file. `firstCommentBody()`
    // returned on its first hit, so every probe landed in the header comment,
    // near the top, in a line comment — 125 positions out of 4,899 usable ones
    // (5,101 comments, less the few the mask does not blank), all of the
    // same shape and all in the same place. The #329 review probed every
    // comment offset the compiler reports and found nothing, so the narrow
    // version was not hiding anything on the day; it was hiding the ability to
    // notice.
    //
    // Every comment in every file was built and MEASURED here rather than
    // guessed at: 4,899 probes, 0 failures, and **+40s of wall clock on a 45s
    // suite** — the extension run goes to 85s, because each probe re-masks a
    // whole file and a whole-file mask is ~4.8 ms of parse. That is not a price
    // this property is worth, so it is not the price paid.
    //
    // What is paid instead is a fixed budget per file, spread EVENLY over that
    // file's comments — first, last, and evenly spaced between. That is chosen,
    // not arbitrary: the failure being guarded against is a blind that runs
    // from a backtick to the next one "anywhere in the file", so WHERE in the
    // file the probe lands is the axis that matters, and the old test could
    // only ever land at the top. Eight positions per file is 917 probes for
    // about 5s, and it probes block comments, JSDoc and trailing comments —
    // three shapes the header-comment-only version never reached.
    //
    // Comment positions come from the compiler, not from this module's own
    // `commentRanges()`, so the probe is not asking the mask to check itself.
    const blinded: string[] = [];
    let probed = 0;
    for (const { rel, source } of scannedSources()) {
      const masked = dynamicParts(source);
      for (const at of probePositions(source, masked)) {
        probed++;
        const strayed = `${source.slice(0, at)}\`${source.slice(at)}`;
        const after = dynamicParts(strayed);
        // Compared as buffers around the injection point rather than as
        // identifier lists: the injection shifts every offset after it by one,
        // and this says the mask's verdict is byte-identical on both sides of
        // it. Stronger than the identifier comparison and much cheaper, which
        // is what pays for the extra positions.
        if (
          after.slice(0, at) !== masked.slice(0, at) ||
          after.slice(at + 1) !== masked.slice(at)
        ) {
          blinded.push(`${rel}@${at}`);
        }
      }
    }
    expect(probed).toBeGreaterThan(600);
    expect(
      blinded,
      'one backtick inside a comment changed what these files look like to every rule:\n' +
        blinded.join('\n'),
    ).toEqual([]);
    // ~1,000 whole-file masks at ~4.8 ms each. Named explicitly rather than
    // left to the 5 s default, so the budget above is visible at the call site.
  }, 60_000);

  it('drops a comment rather than reading it as code', () => {
    // The mechanism behind the property above, stated directly. #327's masker
    // parsed no comments at all, which is why a backtick in one could be read
    // as a template delimiter in the first place.
    expect(identifiersIn(dynamicParts('// pane.textContent = err.message;'))).toEqual([]);
    expect(identifiersIn(dynamicParts('/* pane.textContent = err.message; */'))).toEqual([]);
    // …and a comment must not take the code around it with it.
    expect(dynamicParts('const a = 1; // note\nconst b = 2;')).toContain('const b = 2;');
    expect(dynamicParts('/* note */ const b = 2;')).toContain('const b = 2;');
  });

  it('keeps the code that follows an unbalanced backtick', () => {
    // The three places a backtick can appear without opening a template. Each
    // of these left everything after it blanked before this fix.
    for (const [label, prefix] of [
      ['line comment', '// a ` here\n'],
      ['block comment', '/* a ` here */\n'],
      ['regex character class', "const clean = raw.replace(/[`]/g, '');\n"],
      ['three backticks in a comment', '// wrap it in ```json\n'],
    ] as const) {
      const masked = dynamicParts(`${prefix}pane.textContent = err.message;`);
      expect(masked, label).toContain('pane.textContent = err.message;');
    }
  });

  it('still tells a template literal from a division', () => {
    // The other half of the regex question: a `/` that is division must not be
    // read as the start of a literal and blank the rest of the expression.
    expect(dynamicParts('const ratio = done / total / 2;')).toBe('const ratio = done / total / 2;');
    expect(dynamicParts('const half = width / 2; // px')).toContain('const half = width / 2;');
  });

  it('still keeps what a template interpolates and drops its prose', () => {
    // The behaviour the mask existed for in the first place, re-pinned against
    // the reimplementation. Prose goes, `${…}` holes stay, nested templates
    // recurse, and an escape leaves no letter behind.
    expect(identifiersIn(dynamicParts("'nothing here'"))).toEqual([]);
    expect(identifiersIn(dynamicParts('`plain words only`'))).toEqual([]);
    expect(dynamicParts("'abcd'")).toHaveLength(6);
    expect(dynamicParts('`a ${err.message} b`')).toContain('err.message');
    expect(identifiersIn(dynamicParts('`outer ${`inner ${x} prose`} tail`'))).toEqual(['x']);
    expect(identifiersIn(dynamicParts('`escaped \\n and \\` done`'))).toEqual([]);
    // A `X = …` written inside a string literal is not a binding — the Python
    // code template in features/soql-runner.ts contains `query = """`.
    expect(identifiersIn(dynamicParts('const py = `\nquery = """\n`;'))).toEqual(['const', 'py']);
  });

  it("knows a rejected settlement's reason, which no catch clause binds", () => {
    // #329's NB1. `reason` is off the spelling list on purpose, and the module
    // justified that with "as a `catch` binding they are reached by the catch
    // clause". True of `problem` and `thrown`; false of this one, because
    // `PromiseRejectedResult.reason` is a property name the LANGUAGE mandates.
    // Nothing bound it and nothing spelled it, so it was a fourth way to hold a
    // thrown error with no door on it.
    const settled = [
      'const [r] = await Promise.allSettled([go()]);',
      "if (r.status === 'rejected') pane.textContent = String(r.reason);",
      '',
    ].join('\n');
    expect(errorBoundNames(settled).holdsError.has('reason')).toBe(true);
    expect(carriesAnError('String(r.reason)', errorBoundNames(settled).holdsError)).toBe(true);

    // Either marker on its own is enough. `allSettled` is the only thing that
    // makes settled results; the `.status` narrowing is what TypeScript
    // REQUIRES before `.reason` is reachable, so it is present wherever a
    // reason is read whoever created the promise.
    expect(
      errorBoundNames('const rs = await Promise.allSettled(jobs);').holdsError.has('reason'),
    ).toBe(true);
    expect(
      errorBoundNames("if (s.status !== 'fulfilled') note(s.reason);").holdsError.has('reason'),
    ).toBe(true);
  });

  it('leaves the word `reason` alone in a file that settles nothing', () => {
    // The other half, and the reason it is not simply on the spelling list.
    // `ui/apex-log-analyzer.ts` names a log-TRUNCATION reason `reason` and
    // interpolates it into a banner. Claiming that word everywhere would flag
    // correct code, which is the trade this scanner refuses to make.
    const truncation = [
      "const reason = 'log truncated at 2 MB';",
      'banner.textContent = `Partial log — ${reason}`;',
      '',
    ].join('\n');
    expect(errorBoundNames(truncation).holdsError.has('reason')).toBe(false);
    expect(
      carriesAnError('`Partial log — ${reason}`', errorBoundNames(truncation).holdsError),
    ).toBe(false);

    // …and the evidence has to be CODE. A settled result mentioned in prose or
    // inside a string is not a settled result — this is why the markers are
    // matched on the masked buffer and the state name read back out of the raw
    // one at the same offset.
    const mentioned = [
      "// we could Promise.allSettled(these) and read r.status === 'rejected'",
      "const sql = `SELECT x WHERE s.status === 'rejected'`;",
      "const reason = 'log truncated';",
      '',
    ].join('\n');
    expect(errorBoundNames(mentioned).holdsError.has('reason')).toBe(false);
  });

  it('binds a bare callback reference too, and that is a decision', () => {
    // #329's NB4. `CATCH_BINDING` reads the identifier after `catch (`, and a
    // bare callback reference sits in exactly that position — so
    // `.catch(handleError)` is read as if `handleError` were the parameter.
    // None of these is an identifier a `catch` binds.
    //
    // It is a false-positive direction only: an extra name in `holdsError`
    // makes a rule fire, never go quiet. And it does not fire — measured over
    // the tree, there are zero `.catch(<identifier>)` sites, and the scan
    // produces 11 distinct binding names across all 125 scanned files with
    // nothing spurious among them. Tightening it means choosing between `=>`,
    // `)` `{` and `:` to tell three shapes apart, which is one more pattern
    // that has to guess, for a defect that has never occurred.
    //
    // Pinned rather than fixed, so the over-claim is a decision on the record
    // instead of a surprise for whoever measures next.
    expect([...errorBoundNames('go().catch(handleError);').holdsError]).toEqual(['handleError']);
    expect([...errorBoundNames('go().catch(reject);').holdsError]).toEqual(['reject']);
    expect([...errorBoundNames('go().catch(console.error);').holdsError]).toEqual(['console']);
    // The shapes it is actually FOR, unchanged.
    expect([...errorBoundNames('try { go(); } catch (zz) {}').holdsError]).toEqual(['zz']);
    expect([...errorBoundNames('go().catch((zz) => report(zz));').holdsError]).toEqual(['zz']);
  });

  it('binds no phantom name from a comment or a template', () => {
    // What the mask buys the binding scan, asserted on the scan itself rather
    // than on the mask: prose that happens to spell an assignment is not one.
    expect([...errorBoundNames('// catch (ghost) { }').holdsError]).toEqual([]);
    expect([...errorBoundNames('const sql = `\ncatch (ghost) {\n`;').holdsError]).toEqual([]);
    // …while the real thing one line down is still found.
    expect([
      ...errorBoundNames('// catch (ghost) { }\ntry { go(); } catch (real) { }').holdsError,
    ]).toEqual(['real']);
  });
});

/** How many comment positions per file the backtick property injects at. */
const PROBES_PER_FILE = 8;

/**
 * Where to inject, asked of the COMPILER rather than of the mask.
 *
 * Every comment TypeScript itself attaches to a node — leading and trailing,
 * line and block — offset two characters in, past the `//` or `/*` so the
 * injection lands in the comment BODY and cannot turn the opener into a regex.
 * (`ts.createScanner` looks like the simpler tool and is the wrong one: without
 * the parser driving it, it re-enters a template literal after the first
 * `${…}` hole and reports the CSS comments inside `ui/workspace-host.ts`'s
 * stylesheet as real comments. Injecting a backtick into a template literal
 * terminates it early, which is a probe bug that looks exactly like a mask bug.
 * The comment-range API cannot make that mistake, because it is asked about
 * node trivia and a template's interior contains no nodes.)
 *
 * Then filtered to positions the mask ALREADY blanks. That is what keeps the
 * property non-circular: the mask decides what is static, and the property is
 * that adding a backtick to something it has itself called static changes
 * nothing it calls code.
 *
 * Finally thinned to `PROBES_PER_FILE`, evenly spaced so the first and last
 * comment of every file are always among them — see the budget note in the
 * test for why the full set is measured but not paid for.
 */
function probePositions(source: string, masked: string): number[] {
  const file = ts.createSourceFile(
    'probe.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const starts = new Set<number>();
  for (const r of ts.getLeadingCommentRanges(source, 0) ?? []) starts.add(r.pos);
  const visit = (node: ts.Node): void => {
    for (const r of ts.getLeadingCommentRanges(source, node.getFullStart()) ?? [])
      starts.add(r.pos);
    for (const r of ts.getTrailingCommentRanges(source, node.getEnd()) ?? []) starts.add(r.pos);
    node.forEachChild(visit);
  };
  file.forEachChild(visit);

  const usable = [...starts]
    .sort((a, b) => a - b)
    .map((pos) => pos + 2)
    .filter((at) => masked[at] === ' ');
  if (usable.length <= PROBES_PER_FILE) return usable;

  const picked: number[] = [];
  for (let i = 0; i < PROBES_PER_FILE; i++) {
    picked.push(usable[Math.round((i * (usable.length - 1)) / (PROBES_PER_FILE - 1))]!);
  }
  return [...new Set(picked)];
}
