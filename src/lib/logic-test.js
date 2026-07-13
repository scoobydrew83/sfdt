/**
 * Builder for `sf logic run test` — Salesforce's Spring '26 unified test runner
 * that executes Apex classes and Flow tests in a single request (Flow tests are
 * named `FlowTesting.<name>`). Requires the org "View All Data" system
 * permission. Kept as a pure, unit-testable function; the `test` command wires
 * it to execa.
 *
 * @see https://developer.salesforce.com/docs/platform/salesforce-cli-reference/guide/cli_reference_logic_run_test.html
 */

/** Valid `--test-level` values for `sf logic run test`. */
export const LOGIC_TEST_LEVELS = ['RunLocalTests', 'RunAllTestsInOrg', 'RunSpecifiedTests'];
/** Valid `--test-category` values. */
export const LOGIC_TEST_CATEGORIES = ['Apex', 'Flow'];

/**
 * Build the argv (after `sf`) for a unified logic test run.
 *
 * @param {object} opts - parsed command options (`testLevel`, `tests`,
 *   `category`, `codeCoverage`, `wait`).
 * @param {string} org - resolved target-org alias (required).
 * @returns {string[]} argv to pass to `execa('sf', argv)`.
 * @throws {Error} when no org is resolved, or a test level / category is invalid.
 */
export function buildLogicTestArgs(opts = {}, org) {
  if (!org) {
    throw new Error(
      'No org specified for logic tests — pass --org <alias> or set defaultOrg in .sfdt/config.json',
    );
  }
  if (opts.testLevel && !LOGIC_TEST_LEVELS.includes(opts.testLevel)) {
    throw new Error(`Invalid --test-level "${opts.testLevel}". Valid: ${LOGIC_TEST_LEVELS.join(', ')}`);
  }
  if (opts.category && !LOGIC_TEST_CATEGORIES.includes(opts.category)) {
    throw new Error(`Invalid --category "${opts.category}". Valid: ${LOGIC_TEST_CATEGORIES.join(', ')}`);
  }

  // `sf logic run test` is async by default (returns a run id); wait for
  // results so `sfdt test --logic` is usable in CI without a separate poll.
  const wait = opts.wait != null && opts.wait !== '' ? String(opts.wait) : '30';
  if (!/^\d+$/.test(wait) || Number.parseInt(wait, 10) < 1) {
    throw new Error(
      `Invalid --wait "${opts.wait}" — must be a whole number of minutes, 1 or greater`,
    );
  }
  const args = ['logic', 'run', 'test', '--target-org', org, '--wait', wait];

  if (opts.testLevel) args.push('--test-level', opts.testLevel);
  // The CLI accepts a comma-separated list on a single `--tests`; pass the
  // user's value through verbatim so `FlowTesting.<name>` entries aren't split.
  if (opts.tests) args.push('--tests', opts.tests);
  if (opts.category) args.push('--test-category', opts.category);
  if (opts.codeCoverage) args.push('--code-coverage');
  return args;
}

/**
 * Detect a run where Salesforce executed zero tests — a "pass" that verified
 * nothing (typo'd test names, missing FlowTesting.<name> prefix, or a
 * permissions gap). Matches the human table ("Tests Ran … 0") and the JSON
 * summary shape; unknown output formats return false (never a false failure).
 */
export function detectZeroTests(output) {
  if (!output) return false;
  // ponytail: text heuristic against the beta runner's output; replace with a
  // parsed result model if/when unified result normalization (blueprint I-4) lands.
  return /Tests Ran\D{0,20}0\b/i.test(output) || /"testsRan"\s*:\s*0\b/.test(output);
}
