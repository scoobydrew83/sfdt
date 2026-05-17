// Flow rollback runner — invoked by the bridge `rollback` handler.
//
// Salesforce represents the "active" version of a Flow via the
// FlowDefinition.Metadata.activeVersionNumber field. Changing this field
// activates / deactivates / rolls back without re-deploying any source:
//
//   - activeVersionNumber = N (N >= 1)  → version N is active
//   - activeVersionNumber = 0           → the Flow is deactivated (no active
//                                         version). This is what the
//                                         Tooling API expects when callers
//                                         pass toVersion=0 from the bridge.
//
// The implementation is two `sf` CLI calls:
//
//   1. `sf data query --use-tooling-api` to resolve FlowDefinition.Id from
//      its DeveloperName (the bridge gives us the developer name).
//   2. `sf data update record --use-tooling-api --sobject FlowDefinition
//      --record-id <id> --values "Metadata={\"activeVersionNumber\":<n>}"`
//      to write the new active version.
//
// Both are JSON-mode so we can parse exit codes + error payloads
// deterministically and bubble them back through the bridge contract.

import { execa } from 'execa';
import { loadConfig } from './config.js';

const DEVELOPER_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * Run a Flow rollback / activate / deactivate via sf CLI.
 *
 * @param {object} options
 * @param {string} options.flowApiName     FlowDefinition.DeveloperName.
 * @param {number} options.toVersion       Target activeVersionNumber. >=1 activates that version. 0 deactivates.
 * @param {string} [options.targetOrg]     Org alias. Defaults to config.defaultOrg.
 * @param {number} [options.timeoutMs]     Defaults to 60s — Tooling API round-trip is fast.
 * @returns {Promise<{
 *   ok: true,
 *   data: {
 *     status: string,
 *     flowDefinitionId: string,
 *     previousActiveVersion: number|null,
 *     newActiveVersion: number,
 *     summary: string,
 *   },
 * } | {
 *   ok: false,
 *   error: string,
 *   code?: string,
 * }>}
 */
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

  // ─── Step 1: resolve FlowDefinition.Id + current active version. ─────────
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
  // Pre-rollback active version, surfaced back so the extension can show a
  // "before → after" message in the toast.
  const previousActiveVersion = definition.ActiveVersionId
    ? definition.LatestVersion?.VersionNumber ?? null
    : null;

  // ─── Step 2: PATCH FlowDefinition.Metadata.activeVersionNumber. ──────────
  // `sf data update record --values` accepts a single key=value pair. The
  // Metadata field on FlowDefinition is a complex JSON sObject; passing the
  // whole JSON literal in the value works because sf parses --values payloads
  // as `<field>=<json-or-string>`.
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
    // sf CLI sets status=1 on failure; the error message lives in
    // updateParsed.message or updateParsed.name.
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
