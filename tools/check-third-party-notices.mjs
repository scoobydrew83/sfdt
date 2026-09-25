/**
 * Third-party notices sync check. Canonical source: THIRD_PARTY_NOTICES.md at
 * the repo root. The published flow-core package and the extension build each
 * ship their own copy; both must match the root byte-for-byte.
 *
 * Exits 1 naming each copy that differs or is missing. Never writes.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs-extra';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CANONICAL = 'THIRD_PARTY_NOTICES.md';
const COPIES = ['packages/flow-core/THIRD_PARTY_NOTICES.md', 'extension/public/THIRD_PARTY_NOTICES.md'];

const source = await fs.readFile(path.join(ROOT, CANONICAL), 'utf-8');
const violations = [];
for (const copy of COPIES) {
  const file = path.join(ROOT, copy);
  if (!(await fs.pathExists(file))) violations.push(`${copy}: missing`);
  else if ((await fs.readFile(file, 'utf-8')) !== source) violations.push(`${copy}: differs from ${CANONICAL}`);
}

if (violations.length) {
  console.error(`Third-party notices out of sync (copy ${CANONICAL} over them):`);
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log(`Third-party notices: ${COPIES.length} copies match ${CANONICAL}`);
