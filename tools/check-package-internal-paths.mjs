/**
 * Package-internal path resolution check. CLAUDE.md's "Package-Internal Path
 * Resolution — CRITICAL RULE" requires any path that references a file
 * INSIDE the sfdt package (scripts/, templates/, gui/dist, bin/) to be
 * resolved via import.meta.url, never from config._projectRoot or
 * process.cwd() — those point at the user's Salesforce project when sfdt is
 * globally installed, so a CWD-relative package-asset read throws ENOENT on
 * every machine but the author's.
 *
 * Flags any path.join(...) / path.resolve(...) call that mixes
 * config._projectRoot / projectRoot / process.cwd() with a string literal
 * that starts inside a package-internal directory (scripts/, src/templates/,
 * gui/dist, templates/).
 *
 * Remediation: resolve package assets from import.meta.url instead, e.g.
 *   const __dirname = path.dirname(fileURLToPath(import.meta.url));
 *   const SCRIPTS_DIR = path.resolve(__dirname, '..', '..', 'scripts');
 * See script-runner.js for the canonical pattern.
 *
 * Exits 1 with a violation list on any hit.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs-extra';
import { glob } from 'glob';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const violations = [];

// `projectRoot` unanchored, so this catches both `config._projectRoot` and the
// bare `projectRoot` local that CLAUDE.md also lists as WRONG. Requiring the
// leading underscore silently missed the bare form.
const CWD_LIKE = /(projectRoot|process\.cwd\(\))/;
const PACKAGE_INTERNAL_LITERAL = /['"](scripts\/|src\/templates\/|gui\/dist|templates\/)/;
const CALL_START = /path\.(?:join|resolve)\(/g;

// path.resolve(process.cwd(), ...) nests parens inside the args, so a plain
// [^()]* capture group can't see past `cwd(`. Scan for the matching close
// paren by depth instead of trying to express it in one regex.
function extractCalls(text) {
  const calls = [];
  let m;
  while ((m = CALL_START.exec(text))) {
    const start = m.index;
    let i = CALL_START.lastIndex;
    let depth = 1;
    while (i < text.length && depth > 0) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') depth--;
      i++;
    }
    calls.push({ start, text: text.slice(start, i) });
  }
  CALL_START.lastIndex = 0;
  return calls;
}

const files = [
  ...(await glob('src/**/*.js', { cwd: ROOT })),
  ...(await glob('bin/*.js', { cwd: ROOT })),
];

for (const rel of files) {
  const text = await fs.readFile(path.join(ROOT, rel), 'utf-8');
  for (const call of extractCalls(text)) {
    if (CWD_LIKE.test(call.text) && PACKAGE_INTERNAL_LITERAL.test(call.text)) {
      const line = text.slice(0, call.start).split('\n').length;
      violations.push(
        `${rel}:${line}: package-internal path resolved from _projectRoot/process.cwd() — ` +
        `use import.meta.url instead (see script-runner.js for the pattern). Offending call: ${call.text.trim()}`
      );
    }
  }
}

if (violations.length) {
  console.error('Package-internal path resolution violations:');
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log(`Package-internal path resolution OK (${files.length} files scanned).`);
