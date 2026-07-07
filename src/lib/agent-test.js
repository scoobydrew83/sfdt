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
