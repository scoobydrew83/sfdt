import { buildIndexEvidence } from '@sfdt/flow-core';
import { runAudit } from './audit-runner.js';
import { runMonitor } from './monitor-runner.js';

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
  const [audit, monitor] = await Promise.all([
    runAudit(orgAlias, { params: auditParams }),
    runMonitor(orgAlias, config, { params: monitorParams }),
  ]);
  return { audit, monitor, evidence: buildIndexEvidence({ audit, monitor }) };
}
