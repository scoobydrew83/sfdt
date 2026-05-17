// Shared helper that wires Tooling API Flow.Metadata payloads into the
// @sfdt/flow-core normalize → evaluate → score pipeline. Used by:
//
//   - The `quality` kind on the bridge exchange route (called by the
//     Chrome extension when its local sfdt-bridge picks `localhost` as the
//     transport).
//   - The standalone `/api/flow/quality` GUI route consumed by the
//     FlowHealth dashboard page.
//   - `sfdt flow scan` and `sfdt flow conflicts` indirectly, via the same
//     normalize → evaluate → score sequence inline.
//
// Keeping the assembly in one place guarantees CLI, dashboard, and
// extension produce byte-identical scores for the same Flow metadata.

import {
  buildIssueFamilies,
  calculateScore,
  evaluate,
  normalize,
} from '@sfdt/flow-core';

export const DEFAULT_RULES_CONFIG = {
  outdatedApiVersionThreshold: 6,
  currentApiVersion: 65,
  highDataOperationThreshold: 8,
  namingConventions: {
    variable: /^var[A-Z].*/,
    formula: /^frm[A-Z].*/,
    constant: /^con[A-Z].*/,
  },
};

/**
 * Run the flow-core pipeline on a Tooling-API-shaped Flow.Metadata payload.
 *
 * @param {Record<string, unknown>} metadata
 * @param {object} [options]
 * @param {string} [options.flowApiName]    Optional override for the flow API
 *                                          name baked into the report.
 * @param {string} [options.flowVersionId]
 * @param {object} [options.rulesConfig]    Overrides DEFAULT_RULES_CONFIG.
 * @returns {{
 *   meta: object,
 *   summary: object,
 *   issueFamilies: object[],
 *   findings: object[],
 *   dependencies: object[],
 * }}
 */
export function runFlowQuality(metadata, options = {}) {
  const rulesConfig = options.rulesConfig ?? DEFAULT_RULES_CONFIG;
  const normalized = normalize(metadata, {
    flowApiName: options.flowApiName ?? metadata?.label ?? 'unknown_flow',
    flowVersionId: options.flowVersionId ?? null,
  });
  const findings = evaluate(normalized, rulesConfig);
  const issueFamilies = buildIssueFamilies(findings);
  const score = calculateScore(issueFamilies);
  return {
    meta: normalized.meta,
    summary: score,
    issueFamilies,
    findings,
    dependencies: normalized.dependencies,
  };
}
