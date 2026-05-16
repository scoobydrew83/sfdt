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
