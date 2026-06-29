// Wires a Tooling-API Flow.Metadata payload through the normalize → evaluate →
// score pipeline. Lives in flow-core (browser-safe, zero Node deps) so the CLI
// bridge, the GUI route, and the Chrome flow-quality tool all produce
// byte-identical scores from one place — no server round-trip required.

import { normalize, type RawFlowMetadata, type NormalizedMeta, type Dependency } from './normalize.js';
import { evaluate, type RulesConfig } from './rules.js';
import { buildIssueFamilies, calculateScore } from './scorer.js';
import type { Finding, IssueFamily, ScoreSummary } from './types.js';

// Salesforce ships ~4 API versions per year. The fallback below is the floor for
// the "outdated API version" rule when no config is provided; callers should pass
// currentApiVersion via rulesConfig (normally from sfdx-project.json sourceApiVersion).
const FALLBACK_API_VERSION = 65;

export const DEFAULT_RULES_CONFIG: RulesConfig = {
  outdatedApiVersionThreshold: 6,
  currentApiVersion: FALLBACK_API_VERSION,
  highDataOperationThreshold: 8,
  namingConventions: {
    variable: /^var[A-Z].*/,
    formula: /^frm[A-Z].*/,
    constant: /^con[A-Z].*/,
  },
};

/** Convert an API version ("62.0" / "v62.0" / "62" / 62) to a positive int, or null. */
export function parseApiVersion(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  const str = typeof raw === 'string' ? raw : String(raw);
  const match = str.match(/(\d+)/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export interface FlowQualityOptions {
  flowApiName?: string;
  flowVersionId?: string | null;
  rulesConfig?: RulesConfig;
  /** Overrides DEFAULT_RULES_CONFIG.currentApiVersion; accepts "62.0"/62. Ignored if rulesConfig is given. */
  currentApiVersion?: string | number;
}

export interface FlowQualityReport {
  meta: NormalizedMeta;
  summary: ScoreSummary;
  issueFamilies: IssueFamily[];
  findings: Finding[];
  dependencies: Dependency[];
}

/** Run the flow-core pipeline on a Tooling-API Flow.Metadata payload. */
export function runFlowQuality(metadata: RawFlowMetadata, options: FlowQualityOptions = {}): FlowQualityReport {
  let rulesConfig = options.rulesConfig ?? DEFAULT_RULES_CONFIG;
  if (!options.rulesConfig && options.currentApiVersion !== undefined) {
    const parsed = parseApiVersion(options.currentApiVersion);
    if (parsed !== null) {
      rulesConfig = { ...DEFAULT_RULES_CONFIG, currentApiVersion: parsed };
    }
  }
  const normalized = normalize(metadata, {
    flowApiName: options.flowApiName ?? (metadata as { label?: string })?.label ?? 'unknown_flow',
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
