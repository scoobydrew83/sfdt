/**
 * Builder for `sf agent test run` — Salesforce's Agentforce agent test runner.
 * Runs an agent test (an `AiEvaluationDefinition`) in an org and, with
 * `--wait`, blocks for the result. Kept as a pure, unit-testable function; the
 * `agent-test` command wires it to execa and gates on the CLI's exit code.
 *
 * @see https://developer.salesforce.com/docs/atlas.en-us.sfdx_cli_reference.meta/sfdx_cli_reference/cli_reference_agent_test_run_unified.htm
 */

/**
 * Build the argv (after `sf`) for an agent test run.
 *
 * @param {object} opts - parsed command options (`spec`, `wait`).
 * @param {string} org - resolved target-org alias (required).
 * @returns {string[]} argv to pass to `execa('sf', argv)`.
 * @throws {Error} when no org is resolved or no test spec is given.
 */
export function buildAgentTestArgs(opts = {}, org) {
  if (!org) {
    throw new Error('No org specified — pass --org <alias> or set defaultOrg in .sfdt/config.json');
  }
  if (!opts.spec) {
    throw new Error('--spec <apiName> is required (the AiEvaluationDefinition / agent test API name)');
  }
  // `sf agent test run` is async by default; `--wait <minutes>` is what makes the
  // command block for the result, which is the only reason it works as a CI gate.
  // A wait of 0 (or negative) returns immediately after the eval is *enqueued*,
  // so `sf` would exit 0 before any test runs — silently defeating the gate.
  // Reject anything below 1 minute rather than let a green-by-default slip through.
  let wait = '30';
  if (opts.wait != null && opts.wait !== '') {
    const minutes = Number(opts.wait);
    if (!Number.isInteger(minutes) || minutes < 1) {
      throw new Error(
        `--wait must be a whole number of minutes >= 1 (got "${opts.wait}"). ` +
          'A wait of 0 returns before the agent test completes and would defeat the CI gate.',
      );
    }
    wait = String(minutes);
  }
  return ['agent', 'test', 'run', '--api-name', opts.spec, '--target-org', org, '--wait', wait, '--json'];
}

/**
 * Validate a `--threshold <percent>` option. Returns the numeric threshold, or
 * `null` when unset (exit-code gate stays authoritative). Throws on garbage.
 *
 * @param {string|number|undefined} raw
 * @returns {number|null}
 */
export function parseThreshold(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    throw new Error(`--threshold must be a percentage between 0 and 100 (got "${raw}")`);
  }
  return n;
}

// A scorer's response is a JSON string like '{"status":"PASS",...}' (new
// "Agentforce Studio" shape). Parse it defensively — an unparseable scorer
// counts as not-passing rather than crashing the gate.
function scorerStatus(raw) {
  try {
    return JSON.parse(raw)?.status;
  } catch {
    return undefined;
  }
}

// A test case passes when every one of its results passes. Handles both shapes
// the sf plugin emits (mirrors salesforcecli/plugin-agent handleTestResults.ts):
//   - Agentforce Studio: `testScorerResults[].scorerResponse` (JSON) status PASS
//   - legacy:            `testResults[].result` === 'PASS'
function casePassed(tc) {
  if (Array.isArray(tc?.testScorerResults)) {
    return tc.testScorerResults.length > 0 && tc.testScorerResults.every((s) => scorerStatus(s?.scorerResponse) === 'PASS');
  }
  if (Array.isArray(tc?.testResults)) {
    return tc.testResults.length > 0 && tc.testResults.every((r) => r?.result === 'PASS');
  }
  return false;
}

/**
 * Compute the aggregate pass rate from a parsed `sf agent test run --json`
 * result object (the `.result` inside sf's JSON envelope).
 *
 * @param {object} result - the `AgentTestResultsResponse` / Studio result.
 * @returns {{ total: number, passed: number, rate: number }|null} `null` when
 *   the shape has no recognisable test cases (caller should not gate on it).
 */
export function computePassRate(result) {
  const cases = result?.testCases;
  if (!Array.isArray(cases) || cases.length === 0) return null;
  const passed = cases.filter(casePassed).length;
  return { total: cases.length, passed, rate: (passed / cases.length) * 100 };
}

/**
 * Parse the `.result` payload out of `sf ... --json` stdout. sf wraps the
 * command result in `{ status, result, warnings }`.
 *
 * @param {string} stdout
 * @returns {object|null} the inner result, or `null` when stdout isn't JSON.
 */
export function parseAgentTestResult(stdout) {
  if (!stdout || typeof stdout !== 'string') return null;
  try {
    const env = JSON.parse(stdout);
    return env?.result ?? env ?? null;
  } catch {
    return null;
  }
}
