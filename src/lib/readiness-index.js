import { buildIndexEvidence } from '@sfdt/flow-core';
import { runAudit } from './audit-runner.js';
import { runMonitor } from './monitor-runner.js';
import { getOrgId } from './org-session.js';

/**
 * Gather the AI-Readiness Index evidence pack for an org: run every audit and
 * monitor check, then group the results under the Index's eight dimensions via
 * the shared @sfdt/flow-core mapping (the same grouping the Chrome Org Health
 * panel uses).
 *
 * Evidence, not a score — see packages/flow-core/src/readiness-index.ts.
 *
 * @param {string} orgAlias
 * @param {object} config - loaded sfdt config (runMonitor needs it)
 * @param {{ auditParams?: object, monitorParams?: object }} [options]
 * @returns {Promise<{ audit: object, monitor: object, evidence: object }>}
 */
export async function runIndexEvidence(orgAlias, config, { auditParams = {}, monitorParams = {} } = {}) {
  const [auditRun, monitorRun, orgId] = await Promise.all([
    runAudit(orgAlias, { params: auditParams }),
    runMonitor(orgAlias, config, { params: monitorParams }),
    getOrgId(orgAlias),
  ]);
  // Both snapshots come from this one run, so they share the org ID; stamping
  // it lets the Chrome panel later refuse them when it is on another org.
  const audit = orgId ? { ...auditRun, orgId } : auditRun;
  const monitor = orgId ? { ...monitorRun, orgId } : monitorRun;
  return { audit, monitor, evidence: buildIndexEvidence({ audit, monitor }) };
}
