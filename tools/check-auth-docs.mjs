/**
 * Auth documentation check — fails on prose that teaches unsafe secret
 * handling:
 *
 *  - retrieving the sfdx auth URL by scraping `sf org display --verbose`
 *    (the deliberate command is `sf org auth show-sfdx-auth-url`); the one
 *    allowlisted mention is the old-CLI (< 2.136) compatibility note in the
 *    CI template secrets doc;
 *  - inline webhook URLs or tokens that look real (not placeholders).
 *
 * Exits 1 with a violation list on any hit.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs-extra';
import { glob } from 'glob';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const violations = [];

const PATTERNS = [
  {
    re: /org display --verbose/g,
    reason: 'auth URLs should be retrieved with `sf org auth show-sfdx-auth-url`, not scraped from org display output',
    // The CI secrets-doc partial keeps one scoped mention as an old-CLI
    // (< 2.136) fallback; CHANGELOG is historical.
    allow: new Set(['src/lib/ci-templates.js', 'CHANGELOG.md']),
  },
  {
    // Anchor to the URL scheme so the host can't be prefixed (evilhooks.slack.com…).
    re: /https?:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]{6,}/g,
    reason: 'inline Slack webhook URL — reference the env var NAME instead',
    allow: new Set(),
  },
  {
    re: /xox[bpars]-[0-9A-Za-z-]{10,}/g,
    reason: 'inline Slack token',
    allow: new Set(),
  },
];

const files = [
  'README.md', 'RELEASING.md', 'CONTRIBUTING.md',
  ...(await glob('docs/**/*.md', { cwd: ROOT })),
  ...(await glob('scripts/ci/**/*.yml', { cwd: ROOT })),
  'src/lib/ci-templates.js',
  'extension/README.md', 'vscode/README.md',
];

for (const rel of files) {
  if (!(await fs.pathExists(path.join(ROOT, rel)))) continue;
  const text = await fs.readFile(path.join(ROOT, rel), 'utf-8');
  for (const { re, reason, allow } of PATTERNS) {
    if (allow.has(rel)) continue;
    if (re.test(text)) violations.push(`${rel}: ${reason}`);
    re.lastIndex = 0;
  }
}

if (violations.length) {
  console.error('Auth documentation violations:');
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log(`Auth docs OK (${files.length} files scanned).`);
