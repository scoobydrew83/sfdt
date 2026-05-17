// Flow deploy runner — invoked by the bridge `deploy` handler so the
// extension's Flow Builder "Deploy" button completes a real round-trip.
//
// Wraps `sf project deploy start --metadata Flow:<name>` via execa. This is
// the "deploy what's already in the local force-app" path: the user is
// responsible for having pulled the flow into source first (via sfdt pull
// or sf project retrieve start). A future enhancement is "fetch from source
// org → write locally → deploy" so the user doesn't have to pull first,
// but that's more state to manage.

import { execa } from 'execa';
import { loadConfig } from './config.js';

/**
 * Run a Flow deploy via sf CLI.
 *
 * @param {object} options
 * @param {string} options.flowApiName       Developer name of the Flow to deploy.
 * @param {string} [options.targetOrg]       Org alias. Defaults to config.defaultOrg.
 * @param {boolean} [options.validateOnly]   When true, runs --dry-run (check-only).
 * @param {number} [options.timeoutMs]       Defaults to 5 minutes — sf CLI deploys can be slow.
 * @returns {Promise<{
 *   ok: true,
 *   data: {
 *     status: string,
 *     deployId: string|null,
 *     summary: string,
 *     numberComponentsTotal: number,
 *     numberComponentErrors: number,
 *     numberTestsCompleted: number,
 *     componentFailures: Array<{ fullName: string, problem: string, problemType: string }>,
 *     stdout: string,
 *   },
 * } | {
 *   ok: false,
 *   error: string,
 *   code?: string,
 * }>}
 */
export async function runFlowDeploy(options) {
  const flowApiName = options?.flowApiName;
  if (!flowApiName || typeof flowApiName !== 'string') {
    return { ok: false, error: 'flowApiName is required', code: 'REQUEST_INVALID' };
  }
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(flowApiName)) {
    return {
      ok: false,
      error: `flowApiName "${flowApiName}" is not a valid Salesforce developer name`,
      code: 'REQUEST_INVALID',
    };
  }

  let config;
  try {
    config = await loadConfig();
  } catch (err) {
    return {
      ok: false,
      error: `Not inside an sfdt project (no .sfdt/ found). ${err.message}`,
      code: 'INTERNAL_ERROR',
    };
  }
  const targetOrg = options.targetOrg ?? config.defaultOrg;
  if (!targetOrg) {
    return {
      ok: false,
      error: 'No targetOrg specified and config.defaultOrg is not set',
      code: 'REQUEST_INVALID',
    };
  }

  const args = [
    'project',
    'deploy',
    'start',
    '--metadata',
    `Flow:${flowApiName}`,
    '--target-org',
    targetOrg,
    '--json',
    '--wait',
    '10',
  ];
  if (options.validateOnly) args.push('--dry-run');

  let result;
  try {
    result = await execa('sf', args, {
      cwd: config._projectRoot,
      timeout: options.timeoutMs ?? 5 * 60 * 1000,
      reject: false, // We parse the JSON regardless of exit code so failures still surface useful info.
    });
  } catch (err) {
    return {
      ok: false,
      error: `sf CLI invocation failed: ${err instanceof Error ? err.message : String(err)}`,
      code: 'INTERNAL_ERROR',
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err) {
    return {
      ok: false,
      error: `sf CLI returned non-JSON output (exit ${result.exitCode}). stdout: ${result.stdout?.slice(0, 500) ?? ''}; stderr: ${result.stderr?.slice(0, 200) ?? ''}; parse error: ${err.message}`,
      code: 'INTERNAL_ERROR',
    };
  }

  // `sf project deploy start --json` shape: { status, result: { ... } }
  // when successful. When it fails, result still carries the diagnostic
  // payload (deployId, details.componentFailures, etc.).
  const r = parsed?.result ?? {};
  const details = r.details ?? {};
  const failures = Array.isArray(details.componentFailures)
    ? details.componentFailures.map((f) => ({
        fullName: String(f.fullName ?? ''),
        problem: String(f.problem ?? ''),
        problemType: String(f.problemType ?? ''),
      }))
    : [];

  const status = r.status ?? (result.exitCode === 0 ? 'Succeeded' : 'Failed');
  const succeeded = status === 'Succeeded' || (result.exitCode === 0 && failures.length === 0);

  return {
    ok: true,
    data: {
      status,
      deployId: r.id ?? null,
      summary: succeeded
        ? `Flow "${flowApiName}" deployed to ${targetOrg}`
        : `Deploy ${status.toLowerCase()} for "${flowApiName}" on ${targetOrg}`,
      numberComponentsTotal: r.numberComponentsTotal ?? 0,
      numberComponentErrors: r.numberComponentErrors ?? failures.length,
      numberTestsCompleted: r.numberTestsCompleted ?? 0,
      componentFailures: failures,
      stdout: typeof result.stdout === 'string' ? result.stdout.slice(0, 4000) : '',
    },
  };
}
