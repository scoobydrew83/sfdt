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
  // `sf agent test run` is async; `--wait` blocks for the result so the command
  // is a usable CI gate. `--json` gives the machine-readable envelope; the exit
  // code is the pass/fail signal.
  const wait = opts.wait != null && opts.wait !== '' ? String(opts.wait) : '30';
  return ['agent', 'test', 'run', '--api-name', opts.spec, '--target-org', org, '--wait', wait, '--json'];
}
