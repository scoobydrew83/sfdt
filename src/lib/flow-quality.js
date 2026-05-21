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

// Salesforce ships ~4 API versions per year. The hardcoded fallback below is
// the floor for the "outdated API version" rule when no config is provided;
// callers (CLI + GUI + bridge) should pass currentApiVersion through
// rulesConfig, normally derived from sfdx-project.json's sourceApiVersion.
const FALLBACK_API_VERSION = 65;

export const DEFAULT_RULES_CONFIG = {
  outdatedApiVersionThreshold: 6,
  currentApiVersion: FALLBACK_API_VERSION,
  highDataOperationThreshold: 8,
  namingConventions: {
    variable: /^var[A-Z].*/,
    formula: /^frm[A-Z].*/,
    constant: /^con[A-Z].*/,
  },
};

/**
 * Convert a Salesforce API version string ("62.0", "v62.0", "62", 62) into a
 * positive integer. Returns null when the value isn't parseable.
 */
export function parseApiVersion(raw) {
  if (raw === undefined || raw === null) return null;
  const str = typeof raw === 'string' ? raw : String(raw);
  const match = str.match(/(\d+)/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Run the flow-core pipeline on a Tooling-API-shaped Flow.Metadata payload.
 *
 * @param {Record<string, unknown>} metadata
 * @param {object} [options]
 * @param {string} [options.flowApiName]    Optional override for the flow API
 *                                          name baked into the report.
 * @param {string} [options.flowVersionId]
 * @param {object} [options.rulesConfig]    Overrides DEFAULT_RULES_CONFIG.
 * @param {string|number} [options.currentApiVersion]
 *                                          Overrides DEFAULT_RULES_CONFIG.currentApiVersion;
 *                                          accepts "62.0"/"v62.0"/62. Ignored if
 *                                          a full rulesConfig is provided.
 * @returns {{
 *   meta: object,
 *   summary: object,
 *   issueFamilies: object[],
 *   findings: object[],
 *   dependencies: object[],
 * }}
 */
export function runFlowQuality(metadata, options = {}) {
  let rulesConfig = options.rulesConfig ?? DEFAULT_RULES_CONFIG;
  if (!options.rulesConfig && options.currentApiVersion !== undefined) {
    const parsed = parseApiVersion(options.currentApiVersion);
    if (parsed !== null) {
      rulesConfig = { ...DEFAULT_RULES_CONFIG, currentApiVersion: parsed };
    }
  }
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
