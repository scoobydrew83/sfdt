import { execa } from 'execa';
import { loadConfig } from './config.js';
const DEVELOPER_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
export async function runFlowRollback(options) {
  const flowApiName = options?.flowApiName;
  if (!flowApiName || typeof flowApiName !== 'string') {
    return { ok: false, error: 'flowApiName is required', code: 'REQUEST_INVALID' };
  }
  if (!DEVELOPER_NAME_RE.test(flowApiName)) {
    return {
      ok: false,
      error: `flowApiName "${flowApiName}" is not a valid Salesforce developer name`,
      code: 'REQUEST_INVALID',
    };
  }
  const toVersion = options.toVersion;
  if (!Number.isInteger(toVersion) || toVersion < 0) {
    return {
      ok: false,
      error: 'toVersion must be a non-negative integer (0 deactivates)',
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
  const timeout = options.timeoutMs ?? 60 * 1000;
  const cwd = config._projectRoot;
  const queryArgs = [
    'data',
    'query',
    '--use-tooling-api',
    '-q',
    `SELECT Id, ActiveVersionId, LatestVersion.VersionNumber FROM FlowDefinition WHERE DeveloperName = '${flowApiName.replace(/'/g, "\\'")}' LIMIT 1`,
    '--target-org',
    targetOrg,
    '--json',
  ];
  let queryResult;
  try {
    queryResult = await execa('sf', queryArgs, { cwd, timeout, reject: false });
  } catch (err) {
    return {
      ok: false,
      error: `sf CLI invocation failed during FlowDefinition lookup: ${err instanceof Error ? err.message : String(err)}`,
      code: 'INTERNAL_ERROR',
    };
  }
  let queryParsed;
  try {
    queryParsed = JSON.parse(queryResult.stdout);
  } catch (err) {
    return {
      ok: false,
      error: `sf CLI returned non-JSON output during FlowDefinition lookup (exit ${queryResult.exitCode}). parse error: ${err.message}`,
      code: 'INTERNAL_ERROR',
    };
  }
  const records = queryParsed?.result?.records ?? [];
  if (records.length === 0) {
    return {
      ok: false,
      error: `No FlowDefinition with DeveloperName "${flowApiName}" found in ${targetOrg}`,
      code: 'NOT_FOUND',
    };
  }
  const definition = records[0];
  const flowDefinitionId = definition.Id;
  const previousActiveVersion = definition.ActiveVersionId
    ? definition.LatestVersion?.VersionNumber ?? null
    : null;
  const metadataValue = `Metadata={"activeVersionNumber":${toVersion}}`;
  const updateArgs = [
    'data',
    'update',
    'record',
    '--use-tooling-api',
    '--sobject',
    'FlowDefinition',
    '--record-id',
    flowDefinitionId,
    '--values',
    metadataValue,
    '--target-org',
    targetOrg,
    '--json',
  ];
  let updateResult;
  try {
    updateResult = await execa('sf', updateArgs, { cwd, timeout, reject: false });
  } catch (err) {
    return {
      ok: false,
      error: `sf CLI invocation failed during FlowDefinition update: ${err instanceof Error ? err.message : String(err)}`,
      code: 'INTERNAL_ERROR',
    };
  }
  let updateParsed;
  try {
    updateParsed = JSON.parse(updateResult.stdout);
  } catch (err) {
    return {
      ok: false,
      error: `sf CLI returned non-JSON output during FlowDefinition update (exit ${updateResult.exitCode}). parse error: ${err.message}`,
      code: 'INTERNAL_ERROR',
    };
  }
  if (updateParsed.status !== 0 && updateParsed.status !== undefined) {
    const errMsg = updateParsed.message ?? updateParsed.name ?? 'unknown sf data update failure';
    return {
      ok: false,
      error: `FlowDefinition update failed: ${errMsg}`,
      code: 'INTERNAL_ERROR',
    };
  }
  const action = toVersion === 0 ? 'deactivated' : `set active to v${toVersion}`;
  return {
    ok: true,
    data: {
      status: 'Succeeded',
      flowDefinitionId,
      previousActiveVersion,
      newActiveVersion: toVersion,
      summary: `Flow "${flowApiName}" ${action} on ${targetOrg}`,
    },
  };
}
