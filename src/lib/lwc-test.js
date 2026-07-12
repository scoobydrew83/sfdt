import path from 'path';
import fs from 'fs-extra';
import { glob } from 'glob';

/**
 * Detect whether the project has runnable LWC (Jest) unit tests: a Jest runner
 * must be wired up in package.json (an sfdx-lwc-jest dependency or a test:unit
 * script) AND at least one lwc __tests__ directory must exist under the given
 * package directories. Returns { detected, runner, reason } and never throws —
 * a missing/unreadable package.json is just "not detected".
 *
 * runner: 'script' (npm run test:unit) | 'jest' (the sfdx-lwc-jest binary) | null
 */
export async function detectLwcTests(projectRoot, packageDirectories = []) {
  let pkg;
  try {
    pkg = await fs.readJson(path.join(projectRoot, 'package.json'));
  } catch {
    return { detected: false, runner: null, reason: 'no readable package.json in the project root' };
  }

  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const hasJestDep = Boolean(deps['@salesforce/sfdx-lwc-jest'] || deps['sfdx-lwc-jest']);
  const hasScript = typeof pkg.scripts?.['test:unit'] === 'string';
  if (!hasJestDep && !hasScript) {
    return { detected: false, runner: null, reason: 'no sfdx-lwc-jest dependency or "test:unit" script in package.json' };
  }

  const roots = (packageDirectories?.length ? packageDirectories : ['force-app'])
    .map((p) => (typeof p === 'string' ? p : p?.path))
    .filter(Boolean);
  let hasTests = false;
  for (const root of roots) {
    const matches = await glob('**/lwc/*/__tests__/', {
      cwd: path.join(projectRoot, root),
      follow: false,
    }).catch(() => []);
    if (matches.length) {
      hasTests = true;
      break;
    }
  }
  if (!hasTests) {
    return { detected: false, runner: null, reason: 'no lwc __tests__ directories found under the package directories' };
  }

  return { detected: true, runner: hasScript ? 'script' : 'jest', reason: 'ok' };
}

/** Build the command + args to run the detected LWC test runner. */
export function buildLwcTestArgs(runner) {
  if (runner === 'script') return { command: 'npm', args: ['run', 'test:unit'] };
  return { command: 'npx', args: ['sfdx-lwc-jest'] };
}
