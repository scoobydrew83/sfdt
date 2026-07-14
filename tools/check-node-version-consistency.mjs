/**
 * Node version consistency check. Canonical source: package.json engines.node
 * (a ">=X.Y.Z" range). Verifies every place that states a Node version agrees:
 *
 *  - Dockerfile base image major
 *  - .github/workflows setup-node values
 *  - the CI generator default (src/commands/ci.js) and action.yml default
 *  - prose claims of unsupported majors ("Node 18", "Node 20" as
 *    a minimum/default) outside the allowlist
 *
 * Exits 1 with a violation list on any mismatch.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs-extra';
import { glob } from 'glob';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const violations = [];

const engines = (await fs.readJson(path.join(ROOT, 'package.json'))).engines?.node ?? '';
const m = engines.match(/>=\s*(\d+)\.(\d+)\.(\d+)/);
if (!m) {
  console.error(`package.json engines.node ("${engines}") is not a ">=X.Y.Z" range`);
  process.exit(1);
}
const requiredMajor = Number(m[1]);
const required = `${m[1]}.${m[2]}.${m[3]}`;

// Dockerfile base image
const dockerfile = await fs.readFile(path.join(ROOT, 'Dockerfile'), 'utf-8');
const from = dockerfile.match(/FROM\s+node:(\d+)/);
if (!from || Number(from[1]) < requiredMajor) {
  violations.push(`Dockerfile: base image "node:${from?.[1] ?? '?'}" is below required major ${requiredMajor}`);
}

// Workflows: every setup-node node-version literal
for (const wf of await glob('.github/workflows/*.yml', { cwd: ROOT })) {
  const text = await fs.readFile(path.join(ROOT, wf), 'utf-8');
  for (const match of text.matchAll(/node-version:\s*'?(\d+)/g)) {
    if (Number(match[1]) < requiredMajor) {
      violations.push(`${wf}: node-version ${match[1]} is below required major ${requiredMajor}`);
    }
  }
}

// CI generator default + action default
const ciJs = await fs.readFile(path.join(ROOT, 'src/commands/ci.js'), 'utf-8');
const ciDefault = ciJs.match(/options\.node\s*\|\|\s*'(\d+)'/);
if (!ciDefault || Number(ciDefault[1]) < requiredMajor) {
  violations.push(`src/commands/ci.js: nodeVersion default "${ciDefault?.[1] ?? '?'}" is below required major ${requiredMajor}`);
}
const actionYml = await fs.readFile(path.join(ROOT, 'action.yml'), 'utf-8');
if (!new RegExp(`node-version:[\\s\\S]{0,200}default:\\s*'(${requiredMajor}|\\d\\d)'`).test(actionYml)) {
  const d = actionYml.match(/node-version:[\s\S]{0,220}?default:\s*'(\d+)'/);
  if (!d || Number(d[1]) < requiredMajor) {
    violations.push(`action.yml: node-version default "${d?.[1] ?? '?'}" is below required major ${requiredMajor}`);
  }
}

// Prose claims of unsupported majors. Allowlist: historical records and
// point-in-time planning documents (never updated retroactively).
const ALLOWLIST = new Set(['CHANGELOG.md', 'docs/skills-audit-2026-07-12.md']);
const ALLOWLIST_PREFIXES = ['docs/superpowers/plans/'];
const PROSE_PATTERNS = [/Node(?:\.js)?\s+18\b/, /Node(?:\.js)?\s+20\b/, /node-version:\s*'?(?:18|20)\b/];
const proseFiles = ['README.md', 'RELEASING.md', 'ROADMAP.md', 'CONTRIBUTING.md',
  ...(await glob('docs/**/*.md', { cwd: ROOT })),
  'extension/README.md', 'vscode/README.md'];
for (const rel of proseFiles) {
  if (ALLOWLIST.has(rel) || ALLOWLIST_PREFIXES.some((p) => rel.startsWith(p))) continue;
  if (!(await fs.pathExists(path.join(ROOT, rel)))) continue;
  const text = await fs.readFile(path.join(ROOT, rel), 'utf-8');
  for (const re of PROSE_PATTERNS) {
    const hit = text.match(re);
    if (hit) violations.push(`${rel}: stale Node claim "${hit[0]}" (required: >=${required})`);
  }
}

if (violations.length) {
  console.error(`Node version consistency violations (required: >=${required}):`);
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log(`Node version policy OK (>=${required} everywhere).`);
