import path from 'path';
import os from 'os';
import fs from 'fs-extra';
import { resolveBaseRef, diffNameStatus, isSafeGitRef } from './git-utils.js';
import { parseDiffToMetadata, renderPackageXml, countMembers } from './metadata-mapper.js';
import { sanitizeApexSource } from './api-readiness.js';

/**
 * Smart-deploy planning: compute a changed-metadata delta from git, apply
 * overwrite-protection rules, and choose the minimal safe test level. Pure logic
 * (the actual `sf project deploy` execution lives in the deploy command), so it
 * is unit-testable by mocking git-utils. Reuses the same manifest engine as
 * `sfdt manifest` (metadata-mapper) so destructive changes are separated for free.
 */

export const DEFAULT_IMPACTING_TYPES = ['ApexClass', 'ApexTrigger', 'Flow'];

/** API version that introduced RunRelevantTests as a beta (Spring '26). */
export const RELEVANT_TESTS_BETA_API = 66;
/**
 * API version at which RunRelevantTests is treated as GA. Verified 2026-07:
 * still Beta as of Summer '26 (API 67, now GA as a platform) — the Summer '26
 * release notes carry no RunRelevantTests GA announcement, so the platform
 * release GA'ing does NOT mean this feature did. Spring '27 (API 68) is the
 * earliest release it could GA, so that remains the projected value — adjust
 * (likely down to 67) only once Salesforce publishes an actual GA note. GA
 * detection is what drops the non-prod gate: an opted-in project
 * (`deployment.smart.useRelevantTests`) whose `sourceApiVersion` is at or past
 * this version may use RunRelevantTests on production deploys too (below it,
 * prod always falls back to RunLocalTests).
 */
export const RELEVANT_TESTS_GA_API = 68;

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

/** `@IsTest` outside comments/strings — always test against sanitized source. */
const IS_TEST_RE = /@IsTest\b/i;
/** `@IsTest(...)` with the `d` flag so arg offsets can be sliced from the original source. */
const IS_TEST_ARGS_RE = /@IsTest\s*\(([^)]*)\)/dgi;

/**
 * Select test classes from `@IsTest` annotation metadata (Spring '26):
 *
 * - `@IsTest(testFor='ApexClass:Foo')` — the test declares which components it
 *   covers; it is selected when any declared target appears in the additive
 *   delta. Multi-target values (comma/space-separated) and bare class names
 *   (treated as `ApexClass:<name>`) are parsed defensively.
 * - `@IsTest(critical=true)` — Salesforce always runs critical tests under
 *   RunRelevantTests; mirroring that locally keeps validate parity, so every
 *   critical test class is always selected.
 *
 * Pure function: `deltaComponents` is an additive metadata map
 * (`{ type: [members] }`), `testClassSources` maps test class name → Apex
 * source. Returns a sorted, deduped list of test class names.
 *
 * Sources are sanitized (comments and string literals blanked via
 * `sanitizeApexSource`, which preserves offsets) before matching, so a
 * commented-out `@IsTest(critical=true)` in a non-test helper class can
 * never be selected and passed to `sf project deploy --tests` (the org
 * rejects non-test classes there, hard-failing the deploy). Annotation
 * *positions* are found in the sanitized text; the argument text is sliced
 * from the original source at the same offsets so `testFor='...'` string
 * values survive the sanitization.
 */
export function selectAnnotatedTests(deltaComponents, testClassSources) {
  const targets = new Set();
  for (const [type, members] of Object.entries(deltaComponents || {})) {
    for (const member of members || []) targets.add(`${type}:${member}`.toLowerCase());
  }
  const selected = new Set();
  for (const [className, source] of Object.entries(testClassSources || {})) {
    if (typeof source !== 'string') continue;
    const sanitized = sanitizeApexSource(source);
    if (!IS_TEST_RE.test(sanitized)) continue;
    for (const annotation of sanitized.matchAll(IS_TEST_ARGS_RE)) {
      const args = source.slice(...annotation.indices[1]);
      if (/\bcritical\s*=\s*true\b/i.test(args)) selected.add(className);
      for (const tf of args.matchAll(/testFor\s*=\s*(?:'([^']*)'|"([^"]*)")/gi)) {
        const value = tf[1] ?? tf[2] ?? '';
        for (const raw of value.split(/[,\s]+/)) {
          const token = raw.trim();
          if (!token) continue;
          const key = (token.includes(':') ? token : `ApexClass:${token}`).toLowerCase();
          if (targets.has(key)) selected.add(className);
        }
      }
    }
  }
  return [...selected].sort();
}

/**
 * Scan the project's package directories for Apex test classes (`.cls` files
 * containing `@IsTest` outside comments/strings) and return
 * `{ className: source }` for use with `selectAnnotatedTests` /
 * `checkTestForHints`. Best-effort: unreadable directories/files are skipped.
 */
export async function scanTestClassSources(projectRoot, config) {
  const roots =
    config.packageDirectories?.length > 0
      ? [...new Set(config.packageDirectories.map((p) => p.path))]
      : [config.defaultSourcePath || 'force-app/main/default'];
  const sources = {};
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip, selection degrades to the name heuristic
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.cls')) {
        try {
          const src = await fs.readFile(full, 'utf-8');
          if (IS_TEST_RE.test(sanitizeApexSource(src))) sources[path.basename(entry.name, '.cls')] = src;
        } catch {
          // unreadable file — skip
        }
      }
    }
  }
  for (const root of roots) {
    const abs = path.isAbsolute(root) ? root : path.join(projectRoot, root);
    if (await fs.pathExists(abs)) await walk(abs);
  }
  return sources;
}

/**
 * Quality check: flag Apex test classes carrying no RunRelevantTests hint —
 * neither `@IsTest(testFor='...')` (relevance mapping) nor
 * `@IsTest(critical=true)` (always run, so no mapping needed) on any of the
 * class's annotations. Hint-less tests are invisible to RunRelevantTests
 * selection and to smart-deploy's annotation-aware widening.
 *
 * Pure function over `{ className: source }` (see `scanTestClassSources`).
 * Returns the normalised check shape `{ id, title, status, summary,
 * findings }`; status is `ok` or `warn` (never `error` — an unhinted test is
 * advisory, not a failure).
 */
export function checkTestForHints(testClassSources) {
  const findings = [];
  let total = 0;
  for (const [className, source] of Object.entries(testClassSources || {})) {
    if (typeof source !== 'string') continue;
    const sanitized = sanitizeApexSource(source);
    if (!IS_TEST_RE.test(sanitized)) continue;
    total += 1;
    let hinted = false;
    for (const annotation of sanitized.matchAll(IS_TEST_ARGS_RE)) {
      const args = source.slice(...annotation.indices[1]);
      if (/\btestFor\s*=/i.test(args) || /\bcritical\s*=\s*true\b/i.test(args)) {
        hinted = true;
        break;
      }
    }
    if (!hinted) {
      findings.push({
        name: className,
        detail:
          "No @IsTest(testFor='...') or @IsTest(critical=true) hint — RunRelevantTests cannot map this test to the components it covers",
      });
    }
  }
  findings.sort((a, b) => a.name.localeCompare(b.name));
  const summary =
    total === 0
      ? 'No Apex test classes found'
      : findings.length === 0
        ? `All ${total} test class(es) declare testFor/critical hints`
        : `${findings.length} of ${total} test class(es) lack @IsTest(testFor='...') hints`;
  return {
    id: 'test-for-hints',
    title: 'Test classes without testFor hints',
    status: findings.length > 0 ? 'warn' : 'ok',
    summary,
    findings,
  };
}

/**
 * Convenience wrapper for command wiring (`sfdt quality`): scan the project's
 * package directories and run `checkTestForHints` over what was found.
 */
export async function runTestForHintsCheck(projectRoot, config) {
  return checkTestForHints(await scanTestClassSources(projectRoot, config));
}

/**
 * Choose the test level for a delta deploy.
 *
 * - Production (or downgrade disabled) → RunLocalTests, never skipped —
 *   except when `useRelevantTests` is opted in AND `relevantTestsGa` says the
 *   feature is GA (see `RELEVANT_TESTS_GA_API`), in which case Salesforce's
 *   own server-side selection (RunRelevantTests) is allowed on production.
 * - No impacting metadata changed → NoTestRun.
 * - Only Apex *test* classes changed → RunSpecifiedTests (those tests).
 * - Any other impacting change (non-test Apex, triggers, flows) → RunLocalTests,
 *   because we can't reliably map arbitrary changes to covering tests —
 *   or RunRelevantTests when `useRelevantTests` is opted in.
 */
export function selectTestLevel(
  additive,
  {
    impactingTypes = DEFAULT_IMPACTING_TYPES,
    downgradeTestsOnNonProd = true,
    isProd = false,
    useRelevantTests = false,
    relevantTestsGa = false,
  } = {},
) {
  if (isProd || !downgradeTestsOnNonProd) {
    if (useRelevantTests && relevantTestsGa) {
      return { testLevel: 'RunRelevantTests', tests: [], reason: 'relevant tests (GA)' };
    }
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
    return {
      testLevel: 'RunRelevantTests',
      tests: [],
      reason: relevantTestsGa ? 'relevant tests (GA)' : 'relevant tests (beta)',
    };
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
  // RunRelevantTests requires API 66+ (Spring '26 beta); below that, fall back
  // silently. GA detection is API-version based: at RELEVANT_TESTS_GA_API and
  // later the non-prod gate is dropped inside selectTestLevel.
  const apiNumber = parseFloat(apiVersion);
  const useRelevantTests = smart.useRelevantTests === true && apiNumber >= RELEVANT_TESTS_BETA_API;
  const relevantTestsGa = apiNumber >= RELEVANT_TESTS_GA_API;
  const selection = selectTestLevel(additive, {
    impactingTypes,
    downgradeTestsOnNonProd,
    isProd,
    useRelevantTests,
    relevantTestsGa,
  });
  const { testLevel, reason } = selection;
  let { tests } = selection;

  // testFor-aware selection (Spring '26 @IsTest annotations): when we already
  // committed to RunSpecifiedTests, widen the run with test classes that
  // declare coverage of a changed component (`testFor`) plus every
  // `critical=true` test (Salesforce always runs those — mirroring that keeps
  // validate parity). Best-effort: a scan failure falls back to the heuristic.
  if (testLevel === 'RunSpecifiedTests') {
    try {
      const testSources = await scanTestClassSources(projectRoot, config);
      const annotated = selectAnnotatedTests(additive, testSources);
      tests = [...new Set([...tests, ...annotated])];
    } catch {
      // keep the name-heuristic selection
    }
  }

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
