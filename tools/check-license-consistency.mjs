/**
 * License consistency check (tools/license-policy.json is the policy):
 *  1. every workspace package manifest declares the canonical license;
 *  2. every LICENSE file contains the canonical license text;
 *  3. no prose file under the policy roots contains a forbidden phrase
 *     (stale "MIT" claims), outside the explicit allowlist (historical
 *     changelogs and audit records).
 *
 * Exits 1 with a violation list on any mismatch.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs-extra';
import { glob } from 'glob';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const policy = await fs.readJson(path.join(ROOT, 'tools/license-policy.json'));
const violations = [];

for (const rel of policy.packages) {
  const pkg = await fs.readJson(path.join(ROOT, rel));
  if (pkg.license !== policy.canonical) {
    violations.push(`${rel}: license is ${JSON.stringify(pkg.license ?? null)}, expected "${policy.canonical}"`);
  }
}

for (const rel of policy.licenseFiles) {
  const text = await fs.readFile(path.join(ROOT, rel), 'utf-8');
  if (!text.includes(policy.canonicalLicenseText)) {
    violations.push(`${rel}: does not contain "${policy.canonicalLicenseText}"`);
  }
}

const proseFiles = new Set();
for (const root of policy.proseRoots) {
  const abs = path.join(ROOT, root);
  if (!(await fs.pathExists(abs))) continue;
  if ((await fs.stat(abs)).isFile()) {
    proseFiles.add(root);
  } else {
    for (const f of await glob('**/*.md', { cwd: abs, ignore: ['**/node_modules/**', '**/dist/**'] })) {
      proseFiles.add(path.join(root, f));
    }
  }
}

const allow = new Set(policy.allowlist);
for (const rel of proseFiles) {
  if (allow.has(rel)) continue;
  const text = await fs.readFile(path.join(ROOT, rel), 'utf-8');
  for (const phrase of policy.forbiddenPhrases) {
    if (text.includes(phrase)) {
      violations.push(`${rel}: contains forbidden phrase "${phrase}"`);
    }
  }
}

if (violations.length) {
  console.error('License consistency violations:');
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log(`License policy OK (${policy.packages.length} manifests, ${policy.licenseFiles.length} license files, ${proseFiles.size} prose files).`);
