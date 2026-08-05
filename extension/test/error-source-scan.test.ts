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
import { dynamicParts, errorBoundNames, identifiersIn } from './error-source-scan.js';

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
    const blinded: string[] = [];
    let probed = 0;
    for (const { rel, source } of scannedSources()) {
      const at = firstCommentBody(source);
      if (at === null) continue;
      probed++;
      const strayed = `${source.slice(0, at)}\`${source.slice(at)}`;
      if (
        identifiersIn(dynamicParts(strayed)).join(' ') !==
        identifiersIn(dynamicParts(source)).join(' ')
      ) {
        blinded.push(rel);
      }
    }
    expect(probed).toBeGreaterThan(100);
    expect(
      blinded,
      'one backtick inside a comment changed what these files look like to every rule:\n' +
        blinded.join('\n'),
    ).toEqual([]);
  });

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
 * The offset just inside the first line comment of a file, or `null`.
 *
 * Chosen from the RAW source (a line whose first non-space characters are
 * `//`), then required to be a position the mask already blanks — so the
 * injection lands on text the scanner has itself declared static. That is what
 * makes the assertion above non-circular: the mask decides what is static, and
 * the property is that adding a backtick to something it already called static
 * changes nothing it calls code.
 */
function firstCommentBody(source: string): number | null {
  const masked = dynamicParts(source);
  let offset = 0;
  for (const line of source.split('\n')) {
    const indent = line.length - line.trimStart().length;
    const at = offset + indent;
    if (line.trimStart().startsWith('//') && !line.includes('`') && masked[at] === ' ') {
      return at + 2;
    }
    offset += line.length + 1;
  }
  return null;
}
