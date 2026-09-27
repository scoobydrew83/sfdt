/**
 * Workspace dependency consistency check. Two rules, each of which has broken
 * a release surface once:
 *
 *  1. Every workspace that declares @sfdt/flow-core uses the root package's
 *     range, and that range is satisfied by packages/flow-core's own version.
 *     On 0.x a caret range does not cross minors (^0.13.0 rejects 0.15.0), so
 *     a lagging range makes npm install a stale registry copy instead of
 *     linking the workspace — the GUI, VS Code, native host and web quietly
 *     ran older flow-core rules than the CLI and Chrome.
 *  2. vscode's @types/vscode floor is not newer than its engines.vscode floor.
 *     `vsce package` refuses to build otherwise.
 *
 * Exits 1 with a violation list on any mismatch. Never writes.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs-extra';
import semver from 'semver';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const violations = [];

const rootPkg = await fs.readJson(path.join(ROOT, 'package.json'));
const flowCoreVersion = (await fs.readJson(path.join(ROOT, 'packages/flow-core/package.json'))).version;
const rootRange = rootPkg.dependencies?.['@sfdt/flow-core'];

// Resolve the workspace globs from the root manifest ("packages/*" etc.).
const workspaceDirs = [];
for (const pattern of rootPkg.workspaces ?? []) {
  if (pattern.endsWith('/*')) {
    const base = pattern.slice(0, -2);
    for (const entry of await fs.readdir(path.join(ROOT, base))) workspaceDirs.push(path.join(base, entry));
  } else {
    workspaceDirs.push(pattern);
  }
}

// Rule 1 — one flow-core range, satisfied by the workspace version.
if (!rootRange) {
  violations.push('package.json: root does not declare @sfdt/flow-core');
} else if (!semver.satisfies(flowCoreVersion, rootRange)) {
  violations.push(`package.json: @sfdt/flow-core "${rootRange}" does not accept the workspace version ${flowCoreVersion}`);
}
for (const dir of workspaceDirs) {
  const manifest = path.join(ROOT, dir, 'package.json');
  if (!(await fs.pathExists(manifest))) continue;
  const pkg = await fs.readJson(manifest);
  for (const field of DEP_FIELDS) {
    const range = pkg[field]?.['@sfdt/flow-core'];
    if (range && range !== rootRange) {
      violations.push(`${dir}/package.json: ${field} @sfdt/flow-core "${range}" differs from the root's "${rootRange}"`);
    }
  }
}

// Rule 2 — @types/vscode may not outrun engines.vscode.
const vscodePkg = await fs.readJson(path.join(ROOT, 'vscode/package.json'));
const engine = vscodePkg.engines?.vscode;
const types = vscodePkg.devDependencies?.['@types/vscode'];
if (engine && types) {
  const engineMin = semver.minVersion(engine);
  const typesMin = semver.minVersion(types);
  if (!engineMin || !typesMin) {
    violations.push(`vscode/package.json: cannot parse engines.vscode "${engine}" or @types/vscode "${types}"`);
  } else if (semver.gt(typesMin, engineMin)) {
    violations.push(
      `vscode/package.json: @types/vscode "${types}" is newer than engines.vscode "${engine}" — vsce will refuse to package. ` +
        'Pin the typings to the engine floor, or raise engines.vscode deliberately.',
    );
  }
}

if (violations.length) {
  console.error('Workspace dependency violations:');
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log(
  `Workspace deps OK (@sfdt/flow-core "${rootRange}" → ${flowCoreVersion} everywhere; @types/vscode within engines).`,
);
