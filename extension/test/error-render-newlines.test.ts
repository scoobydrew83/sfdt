import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

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
// The alternation is deliberately just the error nouns. `message`/`msg` were in
// an earlier draft and only produced noise: a thrown error is always reached
// through `err`/`error` (`err.message`, `${global.error}`), while a bare
// `opts.message` is a dialog prompt, not an org error.
const RENDERS_ERROR = /(\w+)\.textContent\s*=\s*([^;\n]*\b(?:err|error|errors|errorMsg)\b[^;\n]*)/i;
const HAS_WHITE_SPACE = /white-space:\s*(?:pre|pre-line|pre-wrap)\b/;

// Literal, non-dynamic copy — "Could not copy to clipboard", "Navigation
// failed" — is single-line by construction. Only assignments that can carry a
// thrown message matter, and those always reference an identifier.
const LITERAL_ONLY = /=\s*['"`][^'"`]*['"`]\s*;?\s*$/;

// A COUNT of errors is a number, not a message: `${result.errors.length} flows
// could not be loaded` has no newline to preserve. Strip those references and
// see whether any error value is still being rendered.
const ERROR_COUNT = /\b(?:err|error|errors|errorMsg)\b\s*\.\s*length/gi;
const ERROR_VALUE = /\b(?:err|error|errors|errorMsg)\b/i;

function rendersAnErrorValue(expression: string): boolean {
  return ERROR_VALUE.test(expression.replace(ERROR_COUNT, ''));
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
        if (setsWhiteSpaceDirectly(source, name)) return;

        const css = cssTextFor(source, name);
        // No cssText at all means the element inherits; that is a judgement
        // call we are not making here, so only flag ones that DO style
        // themselves and omit the rule.
        if (css === null) return;
        if (HAS_WHITE_SPACE.test(css)) return;

        offenders.push(`${path.relative(ROOT, file)}:${i + 1} (${name})`);
      });
    }

    expect(
      offenders,
      `elements that render a Salesforce error but would collapse its guidance line:\n${offenders.join('\n')}`,
    ).toEqual([]);
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
