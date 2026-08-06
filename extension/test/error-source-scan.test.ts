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

  it('masking its own output is always accepted, and always a no-op', () => {
    // B1 of the round-6 review, stated as the PROPERTY it should always have
    // been. The first version of the fail-closed refusal shipped a REGRESSION
    // against `c7547e7`, and the PR body's defence of it — "this refuses
    // nothing the guards legitimately ask" — was a measurement of that day's
    // tree presented as a property of the trigger. It was not one.
    //
    // The mask MANUFACTURED the condition it refuses on. Blanking a string
    // literal's interior turned every character into a space while preserving
    // newlines (which the offset contract requires), and a backslash before a
    // line break is a LineContinuation — the only thing holding a quoted string
    // open across that break:
    //
    //     raw     const s = 'a\⏎ b';        parse diagnostics: 0
    //     masked  const s = '  ⏎  ';        an unterminated string, invented here
    //
    // The guards mask their own output constantly — `readExpression()` cuts
    // fragments out of the masked buffer and `flattensAnError()` masks them
    // again — so the second pass threw. Review measured it: one three-line
    // legal file dropped into `features/` took the three guard suites from
    // 52 passed to 6 failed / 54 passed. `blankLiteralInto()` is the fix.
    //
    // The property, over legal source: whatever the mask ACCEPTS it must accept
    // again, and the second answer must equal the first. That is what makes the
    // refusal a statement about the input rather than about the tree.
    const failures: string[] = [];
    const check = (label: string, source: string): void => {
      let once: string;
      try {
        once = dynamicParts(source);
      } catch (e) {
        failures.push(`${label}: refused its INPUT — ${(e as Error).message.split('\n')[0]}`);
        return;
      }
      if (once.length !== source.length) failures.push(`${label}: length drifted`);
      if (once.split('\n').length !== source.split('\n').length) {
        failures.push(`${label}: line count drifted`);
      }
      try {
        if (dynamicParts(once) !== once) failures.push(`${label}: not a no-op on its own output`);
      } catch (e) {
        failures.push(
          `${label}: refused its own OUTPUT — ${(e as Error).message.split('\n')[0]}\n  ` +
            `in:  ${JSON.stringify(source.slice(0, 90))}\n  out: ${JSON.stringify(once.slice(0, 90))}`,
        );
      }
    };

    // The corpus is checked LEGAL by the compiler first, so no member can
    // quietly become an illegal-input test and make this pass for the wrong
    // reason — which is the mistake the exemption bite check was fixing in #329.
    for (const [label, source] of LEGAL_BUT_HOSTILE) {
      const parsed = ts.createSourceFile(
        'corpus.ts',
        source,
        ts.ScriptTarget.Latest,
        false,
        ts.ScriptKind.TS,
      );
      const diagnostics = (parsed as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] })
        .parseDiagnostics;
      expect(
        (diagnostics ?? []).length,
        `corpus member "${label}" is not legal source, so it proves nothing`,
      ).toBe(0);
      check(label, source);
    }

    // …and over the real tree, including every file with a line continuation
    // spliced in — so the claim does not rest on today's tree happening not to
    // contain one, which is precisely how this was got wrong the first time.
    for (const { rel, source } of scannedSources()) {
      check(rel, source);
      check(`${rel} + continuation`, `const zc = 'a\\\n b';\n${source}`);
    }

    expect(failures, failures.join('\n')).toEqual([]);
  }, 60_000);

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
      // …and the mask's OWN output for a line continuation, which is the exact
      // fragment the first version of this refusal choked on. This list is the
      // category the round-6 PR body claimed to have accounted for, so the
      // member that broke it belongs in it.
      "const s = ' \\\n  ';\nconst t = 1;\n",
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
    // about 5s, spread across each file and stratified by comment kind, so it
    // reaches JSDoc and trailing comments as well as line comments — shapes the
    // header-comment-only version never touched. (Plain `/* … */` block
    // comments it does NOT reach, because the tree contains none; see below.)
    //
    // Comment positions come from the compiler, not from this module's own
    // `commentRanges()`, so the probe is not asking the mask to check itself.
    const blinded: string[] = [];
    const sampled: Record<string, number> = {};
    const missedKind: string[] = [];
    let probed = 0;
    for (const { rel, source } of scannedSources()) {
      const masked = dynamicParts(source);
      const present = new Set(commentKindsIn(source, masked));
      const inSample = new Set<string>();
      for (const { at, kind } of probePositions(source, masked)) {
        probed++;
        sampled[kind] = (sampled[kind] ?? 0) + 1;
        inSample.add(kind);
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
      for (const kind of present) {
        if (!inSample.has(kind)) {
          missedKind.push(`${rel}: contains ${kind} comments, none of them sampled`);
        }
      }
    }
    expect(probed).toBeGreaterThan(600);
    // The budget must not be spent entirely on whichever kind is commonest IN
    // THAT FILE. Round 6 shipped an unstratified spread and review caught the
    // claim this test made about it: the sample came out
    // `line=784 jsdoc=133 block=0`, while the comment here said block comments
    // were probed. Two separate things were wrong and only one was the sampler.
    //
    // The CLAIM. Measured over the tree: 4,522 line comments, 579 JSDoc, and
    // ZERO plain `/* … */` block comments. `block=0` was never a sampling
    // failure, it was a fact about the codebase — and `commentRanges()`'s `/*`
    // branch, which is a different code path from its `//` branch, is exercised
    // by the JSDoc ones. A plain block comment is covered directly by
    // `keeps the code that follows an unbalanced backtick`, since the tree
    // cannot cover it.
    //
    // The SAMPLER. An even spread over one pool can still miss a kind a file
    // does contain, and which kinds get probed should not be luck. The property
    // is therefore per-FILE, which is what stratifying actually buys: every
    // comment kind a file contains appears in that file's own sample.
    expect(missedKind, missedKind.join('\n')).toEqual([]);
    // …and the tree-wide composition is pinned, so `block` appearing later is a
    // visible change rather than a silent one.
    expect(Object.keys(sampled).sort()).toEqual(['jsdoc', 'line']);
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

    // The comparison is against the WHOLE state, closing quote included. A
    // prefix match — which is what shipped in round 6 and what review caught —
    // lets a domain state that merely starts with one of the two words scope
    // `reason` for a whole file. None in the tree; the word is free.
    expect(
      errorBoundNames("if (s.status === 'rejectedByAdmin') note(s.reason);").holdsError.has(
        'reason',
      ),
    ).toBe(false);
    expect(
      errorBoundNames("if (s.status === 'fulfilledAtStore') note(s.reason);").holdsError.has(
        'reason',
      ),
    ).toBe(false);
    // …and the quote style does not matter, only that the word is whole.
    expect(
      errorBoundNames('if (s.status === "rejected") note(s.reason);').holdsError.has('reason'),
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

  it('binds the name a `for-of` head declares, which has no `=` in it', () => {
    // The round-6 review's largest named gap, closed. The declaration scan is
    // `(const|let|var) NAME … =` and a for-of head has no `=`, so the element
    // name was one this scanner had never seen — 265 heads in the tree, and the
    // same value one line later through `const line = …` was caught. See
    // `FOR_OF_BINDING` for the two tiers and the tree-wide cost measurement.
    const inCatch = (body: string): ReturnType<typeof errorBoundNames> =>
      errorBoundNames(`try {\n  go();\n} catch (zq) {\n${body}\n}\n`);

    // Tier one, asked in a STRING position: the receiver of a `.split()`, whose
    // elements are strings by the language's own definition. Every element is a
    // piece of that text — `flattened`, and therefore `holdsError` too.
    const flat = inCatch("  for (const zline of String(zq).split('\\n')) note(zline);");
    expect(flat.holdsError.has('zline')).toBe(true);
    expect(flat.flattened.has('zline')).toBe(true);
    // …and the receiver question is `carriesAnError()`, not `flattensAnError()`,
    // so a string that HOLDS an error without an idiom on it still counts.
    expect(inCatch("  for (const zl of zq.stack.split('\\n')) note(zl);").flattened.has('zl')).toBe(
      true,
    );

    // Tier two, asked in a COLLECTION position: the last link that is not a
    // call. Every element is an error that has not been stringified yet, so
    // `flattened` stays a strict subset — `renderSfError(sub)` is the CORRECT
    // call and rule 3 must not flag it. This is the shape the round-6 review
    // first recorded as an unconfirmed `Promise.any` / AggregateError category
    // and its re-review identified as this finding wearing a costume.
    const held = inCatch('  for (const zsub of zq.errors) note(zsub);');
    expect(held.holdsError.has('zsub')).toBe(true);
    expect(held.flattened.has('zsub')).toBe(false);
    // Arguments never contribute and the method name is not the collection, so
    // a filtered collection of errors is still a collection of errors.
    const filtered = inCatch(
      "  for (const zsub of zq.errors.filter((err) => err.message !== '')) f(zsub);",
    );
    expect(filtered.holdsError.has('zsub')).toBe(true);
    expect(filtered.flattened.has('zsub')).toBe(false);
    // Both halves of "arguments never contribute", so that reading a call's
    // ARGUMENT text as if it were the collection cannot pass unnoticed. The
    // first has no error word anywhere in it and must still bind; the second is
    // stuffed with them and must still decline, because what is being iterated
    // is `fields`.
    expect(
      inCatch('  for (const zsub of zq.errors.filter(Boolean)) f(zsub);').holdsError.has('zsub'),
    ).toBe(true);
    expect(
      inCatch(
        "  for (const zf of zq.fields.filter((err) => err.message !== '')) f(zf);",
      ).holdsError.has('zf'),
    ).toBe(false);

    // ── the BLOCKING defect the first version of this shipped ────────────────
    //
    // Tier one used to ask `flattensAnError(iterable)` — a function written for
    // a SCALAR right-hand side, whose idioms match anywhere in the expression
    // and one of which (`instanceof Error ?`) needs no subject at all. Applied
    // to an ITERABLE it fired on how the collection was BUILT and answered about
    // its ELEMENTS, marking each one `flattened`. Rule 3 then flagged
    // `renderSfError(<a raw sub-error>)`: the exact call the two tiers exist to
    // protect, on legal, lint-clean, type-clean code that is green at
    // `84e6db8`. Every one of these must bind at most `holdsError`.
    for (const head of [
      'for (const zsub of zq instanceof Error ? [zq] : zq.errors)',
      "for (const zsub of zq.errors.filter((err) => err.message !== ''))",
      'for (const zsub of zq.errors.map((err) => err))',
      'for (const zsub of zq.message ? zq.errors : [])',
      "for (const zsub of zq.errors.filter((err) => err.message.split(',').length > 1))",
    ]) {
      expect(inCatch(`  ${head} f(zsub);`).flattened.has('zsub'), head).toBe(false);
    }
    // …including through a named intermediate, which is why an alias of a
    // `flattened` NAME no longer makes the elements flattened. The declaration
    // scan marks `zsubs` flattened because `instanceof Error ?` is in its
    // right-hand side; that is a statement about the array, not about what
    // iterating it yields.
    const viaConst = errorBoundNames(
      [
        'try {',
        '  go();',
        '} catch (zq) {',
        '  const zsubs = zq instanceof Error ? [zq] : zq.errors;',
        '  for (const zsub of zsubs) f(zsub);',
        '}',
        '',
      ].join('\n'),
    );
    expect(viaConst.flattened.has('zsub')).toBe(false);
    expect(viaConst.holdsError.has('zsub')).toBe(true);

    // ── B2: the split has to be the OUTERMOST operation ──────────────────────
    //
    // The SECOND blocking defect of this shape, and it shipped live on `develop`
    // at `9d9f0a6`. `splitReceiver()` returned the prefix before the first
    // depth-zero `.split(` without checking the split ENDED the chain, so
    // `X.split('\n').map(f)` was read as tier 1 and every element marked
    // `flattened` — while the elements are whatever `f` returns. Re-wrapping a
    // newline-delimited org failure into one panel per line is an ordinary UI
    // shape, and `renderSfError(sub)` is the CORRECT call for each element.
    //
    // This is the probe category the round-7 correct-code set had none of, which
    // is exactly why that set could not fail. It has one now.
    for (const head of [
      "for (const zsub of (zq.stack ?? '').split('\\n').map((zl) => new Error(zl)))",
      "for (const zsub of String(zq).split('\\n').map(toError))",
      "for (const zsub of zq.stack.split('\\n').flatMap(parseFrame))",
      "for (const zsub of String(zq).split('\\n').filter(Boolean).map(toError))",
    ]) {
      expect(inCatch(`  ${head} f(zsub);`).flattened.has('zsub'), head).toBe(false);
    }
    // …while the links that CANNOT change what an element is keep tier 1, which
    // is the difference between fixing the category and disabling it. `filter`,
    // `slice`, `reverse` and `sort` hand back elements the receiver already had.
    for (const head of [
      "for (const zt of String(zq).split('\\n').filter(Boolean))",
      "for (const zt of String(zq).split('\\n').slice(1))",
      "for (const zt of String(zq).split('\\n').reverse())",
      "for (const zt of String(zq).split('\\n').filter(Boolean).slice(0, 5))",
    ]) {
      expect(inCatch(`  ${head} note(zt);`).flattened.has('zt'), head).toBe(true);
    }
    // A TERNARY does not become a string position because one of its arms holds
    // a split. `splitReceiver()` returned `zparsed ? zqText` as the receiver —
    // not a string expression at all — so this went flat=false at `d0b395d` to
    // flat=true at `14dc83c`. It is the same defect wearing the other costume,
    // and it lands where the module already says a ternary lands: nowhere.
    const arm = inCatch("  for (const zx of zparsed ? zqText.split('\\n') : zq.errors) f(zx);");
    expect(arm.flattened.has('zx')).toBe(false);
    expect(arm.holdsError.has('zx')).toBe(false);

    // N-F, pinned rather than left as an untested behaviour: `.match()` is tier 1
    // on the same language guarantee as `.split()`, and narrowing the alternation
    // to `(?:split)` alone used to leave the whole suite green.
    expect(inCatch('  for (const zm of String(zq).match(zre)) note(zm);').flattened.has('zm')).toBe(
      true,
    );
    expect(
      inCatch('  for (const zm of String(zq).match(zre).map(toNode)) f(zm);').flattened.has('zm'),
    ).toBe(false);

    // Every binder the head can carry, including the two with no occurrence in
    // the tree — excluding them would be a spelling decision in a structural
    // scanner, which is the mistake this module exists to stop making.
    for (const head of [
      'for (const zb of String(zq).split(sep))',
      'for (let zb of String(zq).split(sep))',
      'for (var zb of String(zq).split(sep))',
      'for await (const zb of String(zq).split(sep))',
      'for(const zb of String(zq).split(sep))',
    ]) {
      expect(inCatch(`  ${head} note(zb);`).holdsError.has('zb'), head).toBe(true);
    }

    // Prettier wraps a long head, and `readExpression()` has to read across the
    // break — reading only to the first newline records an empty iterable, which
    // is how this could bind nothing while looking like it worked.
    expect(
      inCatch(
        "  for (const zw of String(zq)\n    .split('\\n')\n    .filter(Boolean)) note(zw);",
      ).holdsError.has('zw'),
    ).toBe(true);
    // The same head with a `.map()` on it binds nothing, and that is the B2 fix
    // costing something rather than being free. `trim` does return a string, but
    // NOTHING HERE CAN KNOW THAT — reading a callback's return type is exactly
    // the argument-dependent guess that produced both defects in this series. The
    // rule declines and the head goes unbound, which is the direction that fails
    // safe: a missed defect, not a flagged correct call.
    expect(
      inCatch(
        "  for (const zw of String(zq)\n    .split('\\n')\n    .map(trim)) note(zw);",
      ).holdsError.has('zw'),
    ).toBe(false);

    // An alias reaches through the head too, so the ordinary two-step refactor
    // is not a way out of the rule — as tier TWO, because a name bound to an
    // array says nothing about whether iterating it yields text. Rule 2 is what
    // this shape needs and rule 2 asks `holdsError`.
    const twoStep = errorBoundNames(
      [
        'try {',
        '  go();',
        '} catch (zq) {',
        "  const zlines = String(zq).split('\\n');",
        '  for (const zone of zlines) note(zone);',
        '}',
        '',
      ].join('\n'),
    );
    expect(twoStep.holdsError.has('zone')).toBe(true);
    // The under-claim that buys, named rather than left to be discovered: rule 3
    // does not see `renderSfError(zone)` here, where it would see it if the
    // split were written in the head. Closing it needs the declaration scan to
    // record WHICH names hold text rather than only that they hold an error,
    // which is a fourth set and a second structural change.
    expect(twoStep.flattened.has('zone')).toBe(false);

    // ── and the declines, which are the whole reason this measured free ──────
    //
    // The iterable has to be one of the two shapes. 265 heads in the tree and
    // not one of them is; these are the shapes they actually are.
    for (const head of [
      'for (const zx of rows)',
      'for (const zx of node.children)',
      'for (const zx of Object.entries(map))',
      'for (const zx of [1, 2, 3])',
      "for (const zx of 'abc'.split(''))",
    ]) {
      expect(errorBoundNames(`${head} note(zx);\n`).holdsError.has('zx'), head).toBe(false);
    }
    // A property of an error is not a collection of errors. `fields` is a real
    // Salesforce REST error field holding field API NAMES, and the round-7
    // review demonstrated it red on rule 2 before receiver-precision — the
    // reason tier 2 reads the last non-call link rather than any identifier
    // anywhere in the iterable.
    for (const head of [
      'for (const zx of zq.fields)',
      'for (const zx of Object.keys(zq))',
      'for (const zx of Object.values(zq))',
      'for (const zx of zq.fields.map(String))',
      'for (const zx of zq.response.rows)',
    ]) {
      expect(inCatch(`  ${head} note(zx);`).holdsError.has('zx'), head).toBe(false);
    }
    // …in a file that binds nothing at all, so the decline is the head's own
    // and not an accident of there being no `catch` above it.
    expect(errorBoundNames('for (const zx of zqPending) note(zx);\n').holdsError.has('zx')).toBe(
      false,
    );

    // The one direction that DOES claim without a binding is the spelling
    // fallback, applied to the iterable — `errors` is an error word, so its
    // elements are errors. Written down because it is the widening's over-claim
    // and it is inherited rather than new: `pane.textContent = errors[0]` is
    // already flagged by the same spelling, so declining the head would make the
    // scanner disagree with itself about the same value.
    expect(errorBoundNames('for (const zx of errors) note(zx);\n').holdsError.has('zx')).toBe(true);

    // Evidence has to be CODE. A head in a comment or inside a template literal
    // is not a head — the same property the mask buys every other pattern here.
    expect(
      inCatch('  // for (const zghost of String(zq)) note(zghost);').holdsError.has('zghost'),
    ).toBe(false);
    expect(
      inCatch('  const zsql = `\n  for (const zghost of String(zq))\n  `;').holdsError.has(
        'zghost',
      ),
    ).toBe(false);

    // A DESTRUCTURING head is deliberately not matched, and that is the same
    // decision rounds 4, 5 and 6 each took about `catch ({ message: zz })`.
    // 38 of them in the tree, none error-carrying; it is that category, not
    // this one, and it is not going in the same round.
    expect(
      inCatch(
        "  for (const [zfirst] of String(zq).split('\\n').entries()) note(zfirst);",
      ).holdsError.has('zfirst'),
    ).toBe(false);
    expect(
      inCatch('  for (const { message: zm } of zq.errors) note(zm);').holdsError.has('zm'),
    ).toBe(false);
  });

  it('a regex is blanked whole, and no backslash survives it', () => {
    // The consequence of the regex carve-out in `blankLiterals()`, pinned. The
    // carve-out itself is unreachable — a `RegularExpressionLiteral` cannot
    // contain a line terminator, so the continuation branch it avoids can never
    // be reached inside one — but a masker that leaves a backslash in CODE
    // position is exactly the failure round 6 shipped, and this is the part a
    // future edit to `literalInterior()` could break.
    const source = "const zr = /['\\/`]/g;\nconst zt = 1;\n";
    expect(dynamicParts(source)).toBe(`const zr = ${' '.repeat(9)};\nconst zt = 1;\n`);
    expect(dynamicParts(source).includes('\\')).toBe(false);
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

/**
 * Legal source the mask has to survive, gathered from every way found so far of
 * making a masker manufacture a token that was not in its input.
 *
 * Each member is asserted LEGAL against the compiler before it is used, so the
 * corpus cannot rot into a set of illegal inputs that pass by being refused.
 */
const LEGAL_BUT_HOSTILE: readonly [string, string][] = [
  ['line continuation, single quotes', "const s = 'a\\\n b';\nconst t = 1;\n"],
  ['line continuation, double quotes', 'const s = "a\\\n b";\nconst t = 1;\n'],
  ['line continuation, CRLF', "const s = 'a\\\r\n b';\nconst t = 1;\n"],
  ['two line continuations', "const s = 'a\\\n b\\\n c';\nconst t = 1;\n"],
  ['continuation then an ordinary escape', "const s = 'a\\\n b\\n c';\nconst t = 1;\n"],
  ['escaped backslash before a continuation', "const s = 'a\\\\\\\n b';\nconst t = 1;\n"],
  ['continuation in a template', 'const s = `a\\\n b`;\nconst t = 1;\n'],
  ['continuation inside a line comment', '// a\\\nconst t = 1;\n'],
  ['continuation carrying a quote', "const s = 'a\\\n it\\'s b';\nconst t = 1;\n"],
  ['a quote inside a template hole', 'const s = `a ${x ? "y" : \'z\'} b`;\n'],
  ['a template inside a template hole', 'const s = `a ${`inner ${y}`} b`;\n'],
  ['a regex holding a quote and a slash', "const r = /['\\/`]/g;\nconst t = 1;\n"],
  ['a block comment holding a quote', "/* it's fine */\nconst t = 1;\n"],
  ['a string holding a comment opener', "const s = '/* not a comment */';\nconst t = 1;\n"],
  ['a string holding a backtick', "const s = 'a ` b';\nconst t = 1;\n"],
  ['division that is not a regex', 'const r = a / b / c;\nconst t = 1;\n'],
];

/**
 * The comment kinds a file actually contains at a position the mask blanks.
 *
 * The same classification `probePositions()` buckets by, computed separately so
 * the coverage property below is not the sampler grading its own homework.
 */
function commentKindsIn(source: string, masked: string): string[] {
  const file = ts.createSourceFile(
    'kinds.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const found = new Set<string>();
  const note = (ranges: readonly ts.CommentRange[] | undefined): void => {
    for (const r of ranges ?? []) {
      if (masked[r.pos + 2] !== ' ') continue;
      found.add(
        r.kind === ts.SyntaxKind.SingleLineCommentTrivia
          ? 'line'
          : source.startsWith('/**', r.pos)
            ? 'jsdoc'
            : 'block',
      );
    }
  };
  note(ts.getLeadingCommentRanges(source, 0));
  const visit = (node: ts.Node): void => {
    note(ts.getLeadingCommentRanges(source, node.getFullStart()));
    note(ts.getTrailingCommentRanges(source, node.getEnd()));
    node.forEachChild(visit);
  };
  file.forEachChild(visit);
  return [...found];
}

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
function probePositions(source: string, masked: string): { at: number; kind: string }[] {
  const file = ts.createSourceFile(
    'probe.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const starts = new Map<number, ts.CommentKind>();
  const note = (ranges: readonly ts.CommentRange[] | undefined): void => {
    for (const r of ranges ?? []) starts.set(r.pos, r.kind);
  };
  note(ts.getLeadingCommentRanges(source, 0));
  const visit = (node: ts.Node): void => {
    note(ts.getLeadingCommentRanges(source, node.getFullStart()));
    note(ts.getTrailingCommentRanges(source, node.getEnd()));
    node.forEachChild(visit);
  };
  file.forEachChild(visit);

  // Bucketed BY KIND, because the budget is what decides what gets probed and
  // an unstratified spread spends it all on whichever kind is commonest. Round
  // 6 shipped exactly that mistake: the sample came out `line=784 jsdoc=133
  // block=0`, while the test's own comment claimed block comments were probed.
  // They were not — a tree written in `//` and `/** … */` has so few plain
  // block comments that an even spread never lands on one, and the `/*` branch
  // of `commentRanges()` is a different code path from the `//` branch.
  const buckets = new Map<string, number[]>();
  for (const [pos, kind] of [...starts].sort((a, b) => a[0] - b[0])) {
    const at = pos + 2;
    if (masked[at] !== ' ') continue;
    const bucket =
      kind === ts.SyntaxKind.SingleLineCommentTrivia
        ? 'line'
        : source.startsWith('/**', pos)
          ? 'jsdoc'
          : 'block';
    (buckets.get(bucket) ?? buckets.set(bucket, []).get(bucket)!).push(at);
  }

  // Evenly spaced WITHIN each kind — first and last always included — then
  // round-robin across kinds until the budget is spent, so every kind a file
  // contains is represented before any kind gets a second position.
  const spread = (xs: number[], n: number): number[] =>
    xs.length <= n
      ? xs
      : [
          ...new Set(
            Array.from({ length: n }, (_, i) => xs[Math.round((i * (xs.length - 1)) / (n - 1))]!),
          ),
        ];
  const queues = [...buckets.values()].map((xs) => spread(xs, PROBES_PER_FILE));
  const kinds = [...buckets.keys()];
  const picked: { at: number; kind: string }[] = [];
  for (let round = 0; picked.length < PROBES_PER_FILE; round++) {
    if (queues.every((q) => round >= q.length)) break;
    queues.forEach((q, i) => {
      if (round < q.length && picked.length < PROBES_PER_FILE) {
        picked.push({ at: q[round]!, kind: kinds[i]! });
      }
    });
  }
  return picked.sort((a, b) => a.at - b.at);
}
