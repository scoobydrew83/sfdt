import path from 'path';
import os from 'os';
import fs from 'fs-extra';
import { resolveBaseRef, diffNameStatus, isSafeGitRef } from './git-utils.js';
import { parseDiffToMetadata, renderPackageXml, countMembers } from './metadata-mapper.js';

/**
 * Smart-deploy planning: compute a changed-metadata delta from git, apply
 * overwrite-protection rules, and choose the minimal safe test level. Pure logic
 * (the actual `sf project deploy` execution lives in the deploy command), so it
 * is unit-testable by mocking git-utils. Reuses the same manifest engine as
 * `sfdt manifest` (metadata-mapper) so destructive changes are separated for free.
 */

export const DEFAULT_IMPACTING_TYPES = ['ApexClass', 'ApexTrigger', 'Flow'];

function diffPathsForConfig(config) {
  const sourcePath = config.defaultSourcePath || 'force-app/main/default';
  const packages = config.packageDirectories || [];
  return packages.length > 0
    ? [...new Set(packages.map((p) => p.path.split('/')[0] + '/'))]
    : [sourcePath.split('/')[0] + '/'];
}

/**
 * Compute the additive/destructive metadata delta between two git refs.
 */
export async function computeDelta({ base, head = 'HEAD', projectRoot, config }) {
  if (!isSafeGitRef(base) || !isSafeGitRef(head)) {
    throw new Error('Invalid git ref — refs must not start with "-" or contain shell metacharacters');
  }
  const sourcePath = config.defaultSourcePath || 'force-app/main/default';
  const baseRef = await resolveBaseRef(base, head, projectRoot);
  const diffResult = await diffNameStatus(baseRef, head, diffPathsForConfig(config), projectRoot);
  if (diffResult.exitCode !== 0) {
    throw new Error(`git diff failed: ${diffResult.stderr || 'unknown error'}`);
  }
  const { additive, destructive, unknown } = parseDiffToMetadata(diffResult.stdout, { sourcePath });
  return {
    baseRef,
    additive,
    destructive,
    unknown,
    addCount: countMembers(additive),
    delCount: countMembers(destructive),
  };
}

/**
 * Parse a package-no-overwrite.xml into a `{ type: Set<member> }` map. A '*'
 * member means "protect every member of this type".
 */
export function parseNoOverwrite(xml) {
  const map = {};
  if (!xml) return map;
  const typeBlocks = xml.match(/<types>[\s\S]*?<\/types>/g) || [];
  for (const block of typeBlocks) {
    const name = (block.match(/<name>([^<]+)<\/name>/) || [])[1];
    if (!name) continue;
    const members = [...block.matchAll(/<members>([^<]+)<\/members>/g)].map((m) => m[1].trim());
    map[name.trim()] = new Set(members);
  }
  return map;
}

/**
 * Remove overwrite-protected members from an additive metadata map.
 * @returns {{ additive: Record<string,string[]>, removed: string[] }}
 */
export function applyOverwriteRules(additive, noOverwriteMap) {
  const filtered = {};
  const removed = [];
  for (const [type, members] of Object.entries(additive)) {
    const block = noOverwriteMap[type];
    const wildcard = block && block.has('*');
    const kept = [];
    for (const m of members) {
      if (block && (wildcard || block.has(m))) removed.push(`${type}:${m}`);
      else kept.push(m);
    }
    if (kept.length) filtered[type] = kept;
  }
  return { additive: filtered, removed };
}

function isTestClassName(name) {
  return /(^test|test$)/i.test(name);
}

/**
 * Choose the test level for a delta deploy.
 *
 * - Production (or downgrade disabled) → RunLocalTests, never skipped.
 * - No impacting metadata changed → NoTestRun.
 * - Only Apex *test* classes changed → RunSpecifiedTests (those tests).
 * - Any other impacting change (non-test Apex, triggers, flows) → RunLocalTests,
 *   because we can't reliably map arbitrary changes to covering tests —
 *   or RunRelevantTests (Spring '26 beta) when `useRelevantTests` is opted in.
 */
export function selectTestLevel(
  additive,
  {
    impactingTypes = DEFAULT_IMPACTING_TYPES,
    downgradeTestsOnNonProd = true,
    isProd = false,
    useRelevantTests = false,
  } = {},
) {
  if (isProd || !downgradeTestsOnNonProd) {
    return { testLevel: 'RunLocalTests', tests: [], reason: isProd ? 'production deploy' : 'test downgrade disabled' };
  }
  const impacted = Object.keys(additive).filter((t) => impactingTypes.includes(t));
  if (impacted.length === 0) {
    return { testLevel: 'NoTestRun', tests: [], reason: 'no impacting metadata changed' };
  }
  const apex = additive.ApexClass || [];
  const onlyApexImpacted = impacted.length === 1 && impacted[0] === 'ApexClass';
  const testClasses = apex.filter(isTestClassName);
  const nonTestApex = apex.filter((n) => !isTestClassName(n));
  if (onlyApexImpacted && nonTestApex.length === 0 && testClasses.length > 0) {
    return { testLevel: 'RunSpecifiedTests', tests: testClasses, reason: 'only Apex test classes changed' };
  }
  if (useRelevantTests) {
    return { testLevel: 'RunRelevantTests', tests: [], reason: 'relevant tests (beta)' };
  }
  return { testLevel: 'RunLocalTests', tests: [], reason: `impacting types changed: ${impacted.join(', ')}` };
}

/**
 * Plan a smart deploy: delta → overwrite filter → temp manifests → test level.
 * Writes package.xml (and destructiveChanges.xml when needed) into a temp dir
 * the caller is responsible for removing.
 */
export async function prepareSmartDeploy({
  base,
  head = 'HEAD',
  projectRoot,
  config,
  isProd = false,
  noOverwriteManifest,
  tmpDir,
} = {}) {
  const smart = config.deployment?.smart || {};
  const apiVersion = config.sourceApiVersion || '63.0';
  const delta = await computeDelta({ base, head, projectRoot, config });

  let additive = delta.additive;
  let removed = [];
  const noOverwritePath = noOverwriteManifest ?? smart.noOverwriteManifest;
  if (noOverwritePath) {
    const abs = path.isAbsolute(noOverwritePath) ? noOverwritePath : path.join(projectRoot, noOverwritePath);
    if (await fs.pathExists(abs)) {
      const xml = await fs.readFile(abs, 'utf-8');
      ({ additive, removed } = applyOverwriteRules(additive, parseNoOverwrite(xml)));
    }
  }

  const addCount = countMembers(additive);
  const delCount = delta.delCount;

  const ownsDir = !tmpDir;
  const dir = tmpDir || (await fs.mkdtemp(path.join(os.tmpdir(), 'sfdt-smart-')));
  const manifestPath = path.join(dir, 'package.xml');
  let destructivePath = null;
  try {
    await fs.writeFile(manifestPath, renderPackageXml(additive, apiVersion));
    if (delCount > 0) {
      destructivePath = path.join(dir, 'destructiveChanges.xml');
      await fs.writeFile(destructivePath, renderPackageXml(delta.destructive, apiVersion));
    }
  } catch (err) {
    // Don't leak the temp dir we just created if a write fails — the caller's
    // cleanup only runs once this function returns a `prep` with `tmpDir`.
    if (ownsDir) await fs.remove(dir).catch(() => {});
    throw err;
  }

  const impactingTypes = smart.impactingTypes || DEFAULT_IMPACTING_TYPES;
  const downgradeTestsOnNonProd = smart.downgradeTestsOnNonProd !== false;
  // RunRelevantTests requires API 66+ (Spring '26 beta); below that, fall back silently.
  const useRelevantTests = smart.useRelevantTests === true && parseFloat(apiVersion) >= 66;
  const { testLevel, tests, reason } = selectTestLevel(additive, {
    impactingTypes,
    downgradeTestsOnNonProd,
    isProd,
    useRelevantTests,
  });

  return {
    tmpDir: dir,
    manifestPath,
    destructivePath,
    additive,
    destructive: delta.destructive,
    removed,
    addCount,
    delCount,
    testLevel,
    tests,
    testReason: reason,
    baseRef: delta.baseRef,
    unknown: delta.unknown,
  };
}
