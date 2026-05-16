import { execa } from 'execa';
import { loadConfig } from './config.js';
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
      reject: false,
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
