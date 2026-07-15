/**
 * Packaging guard (execution-plan item P0-7).
 *
 * Fails the package step when `extension/package.json`'s version does not equal
 * the version in the freshly built manifest (`.output/chrome-mv3/manifest.json`).
 * This is the "stale build artifact" guard from the competitive-analysis §5.7
 * anti-patterns: without it a stale `.output/` (source at 0.6.0, manifest still
 * 0.5.0) could be zipped and shipped.
 *
 * Core (`checkVersionMatch`) throws on mismatch or a missing/invalid file so it
 * is unit-testable; the CLI wrapper at the bottom turns a throw into a non-zero
 * exit. Package-internal paths are resolved from `import.meta.url`, never the
 * cwd, so it works regardless of where `node` is invoked from.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const scriptDir = dirname(fileURLToPath(import.meta.url));

/** `extension/package.json` — the source of truth for the version. */
export const PKG_PATH = resolve(scriptDir, '..', 'package.json');
/** The built MV3 manifest WXT emits into `.output/`. */
export const MANIFEST_PATH = resolve(scriptDir, '..', '.output', 'chrome-mv3', 'manifest.json');

function readVersion(filePath: string, label: string): string {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    throw new Error(`${label} not found at ${filePath} (build the extension before packaging).`);
  }
  let json: { version?: unknown };
  try {
    json = JSON.parse(raw) as { version?: unknown };
  } catch (err) {
    throw new Error(`${label} at ${filePath} is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof json.version !== 'string' || json.version.length === 0) {
    throw new Error(`${label} at ${filePath} has no "version" string.`);
  }
  return json.version;
}

export interface CheckOptions {
  pkgPath?: string;
  manifestPath?: string;
}

/**
 * Throws if the built manifest version differs from package.json, or if either
 * file is missing/unreadable. Returns the agreed version on success.
 */
export function checkVersionMatch(opts: CheckOptions = {}): { version: string } {
  const pkgPath = opts.pkgPath ?? PKG_PATH;
  const manifestPath = opts.manifestPath ?? MANIFEST_PATH;

  const pkgVersion = readVersion(pkgPath, 'package.json');
  const manifestVersion = readVersion(manifestPath, 'built manifest');

  if (pkgVersion !== manifestVersion) {
    throw new Error(
      `Version mismatch: extension/package.json is ${pkgVersion} but the built manifest ` +
        `(${manifestPath}) is ${manifestVersion}. Rebuild the extension before packaging so ` +
        `the zip cannot ship a stale version.`,
    );
  }
  return { version: pkgVersion };
}

// --- Thin CLI wrapper ------------------------------------------------------
// Only runs the guard when executed directly (node scripts/check-version-match.ts),
// never when imported by the test.
const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    const { version } = checkVersionMatch();
    console.log(`✓ version match: package.json and built manifest are both ${version}`);
  } catch (err) {
    console.error(`✗ ${(err as Error).message}`);
    process.exit(1);
  }
}
