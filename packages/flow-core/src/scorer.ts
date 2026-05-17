// Formula per family:
//   deduction = min( appearancePenalty + weight * log2(instanceCount + 1), cap )
//
// Severity model (tuned constants — do not adjust without re-running fixtures):
//   High    appearance 1.5  weight 5.5  cap 22
//   Medium  appearance 0.5  weight 3.0  cap 13
//   Low     appearance 0.0  weight 1.0  cap 6
//   Info    appearance 0.0  weight 0.0  cap 0

import type {
  AffectedItem,
  Category,
  Finding,
  IssueFamily,
  Rating,
  ScoreSummary,
  Severity,
} from './types.js';

const SCORE_APPEARANCE: Record<Severity, number> = {
  high: 1.5,
  medium: 0.5,
  low: 0,
  info: 0,
};

const SCORE_WEIGHTS: Record<Severity, number> = {
  high: 5.5,
  medium: 3,
  low: 1,
  info: 0,
};

const SCORE_CAPS: Record<Severity, number> = {
  high: 22,
  medium: 13,
  low: 6,
  info: 0,
};

const SEVERITY_ORDER: Record<Severity, number> = {
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

const FAMILY_TITLES: Record<string, string> = {
  flow_description: 'Flow description missing',
  element_descriptions: 'Elements missing descriptions',
  resource_descriptions: 'Resources missing descriptions',
  flow_naming: 'Flow naming convention mismatches',
  resource_naming: 'Resource naming convention mismatches',
  generic_element_naming: 'Generic element naming',
  fault_paths_actions: 'Action elements missing fault paths',
  fault_paths_queries: 'Query elements missing fault paths',
  fault_paths_dml: 'DML elements missing fault paths',
  dml_inside_loops: 'DML inside loops',
  queries_inside_loops: 'Queries inside loops',
  nested_loops: 'Nested loops',
  excessive_data_operations: 'High data operation count',
  broad_entry_criteria: 'Broad or missing entry criteria',
  trigger_timing_mismatch: 'Trigger timing mismatch',
  outdated_api_version: 'Outdated API version',
  hard_coded_ids: 'Possible hard-coded Salesforce IDs found',
  hard_coded_urls: 'Possible hard-coded URLs found',
  custom_apex_dependencies: 'Custom Apex dependencies detected',
  custom_lwc_dependencies: 'Custom LWC dependencies detected',
  subflow_dependencies: 'Subflow dependencies detected',
  apex_defined_dependencies: 'Apex-defined dependencies detected',
  elevated_run_context: 'Elevated run context detected',
};

function computeDeduction(severity: Severity, instanceCount: number): number {
  const appearance = SCORE_APPEARANCE[severity];
  const weight = SCORE_WEIGHTS[severity];
  const cap = SCORE_CAPS[severity];
  const safeCount = Math.max(1, Number(instanceCount) || 1);
  const raw = appearance + weight * Math.log2(safeCount + 1);
  const capped = Math.min(raw, cap);
  return Math.round(capped * 10) / 10;
}

function titleFromFamily(scoreFamily: string): string {
  return FAMILY_TITLES[scoreFamily] ?? scoreFamily;
}

function extractAffectedItem(finding: Finding): AffectedItem | null {
  if (finding.location?.elementLabel) {
    return {
      type: 'element',
      label: finding.location.elementLabel,
      apiName: finding.location.elementApiName ?? null,
    };
  }
  if (finding.location?.resourceName) {
    return {
      type: 'resource',
      label: finding.location.resourceName,
      apiName: null,
    };
  }
  if (finding.metadata?.dependencyName && typeof finding.metadata.dependencyName === 'string') {
    return {
      type: 'dependency',
      label: finding.metadata.dependencyName,
      apiName: null,
    };
  }
  return null;
}

function uniqueAffectedItems(items: AffectedItem[]): AffectedItem[] {
  const seen = new Set<string>();
  const out: AffectedItem[] = [];
  for (const item of items) {
    const key = `${item.type}::${item.label}::${item.apiName ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function buildIssueFamilies(findings: Finding[]): IssueFamily[] {
  const families = new Map<string, IssueFamily>();

  for (const finding of findings) {
    const key = finding.scoreFamily || finding.ruleId;
    const affected = extractAffectedItem(finding);

    const existing = families.get(key);
    if (!existing) {
      families.set(key, {
        scoreFamily: key,
        title: titleFromFamily(key),
        severity: finding.severity,
        category: finding.category,
        scoreImpact: 0,
        instanceCount: 1,
        findings: [finding],
        affectedItems: affected ? [affected] : [],
      });
      continue;
    }

    existing.instanceCount += 1;
    existing.findings.push(finding);
    if (affected) existing.affectedItems.push(affected);

    if (SEVERITY_ORDER[finding.severity] > SEVERITY_ORDER[existing.severity]) {
      existing.severity = finding.severity;
      existing.category = finding.category;
    }
  }

  return Array.from(families.values())
    .map((family) => ({
      ...family,
      affectedItems: uniqueAffectedItems(family.affectedItems),
      scoreImpact: computeDeduction(family.severity, family.instanceCount),
    }))
    .sort((a, b) => {
      const sev = SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity];
      if (sev !== 0) return sev;
      return a.title.localeCompare(b.title);
    });
}

export function getScoreRating(score: number): Rating {
  if (score >= 90) return 'Excellent';
  if (score >= 80) return 'Very Good';
  if (score >= 70) return 'Good';
  if (score >= 55) return 'Poor';
  return 'Very Poor';
}

function countBySeverity(families: IssueFamily[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { high: 0, medium: 0, low: 0, info: 0 };
  for (const family of families) counts[family.severity] += 1;
  return counts;
}

function countByCategory(families: IssueFamily[]): Record<Category, number> {
  const counts: Record<Category, number> = {
    performance: 0,
    reliability: 0,
    maintainability: 0,
    portability: 0,
  };
  for (const family of families) {
    if (family.category in counts) counts[family.category] += 1;
  }
  return counts;
}

export function calculateScore(issueFamilies: IssueFamily[]): ScoreSummary {
  let score = 100;
  for (const family of issueFamilies) score -= family.scoreImpact;

  const finalScore = Math.max(0, Math.min(100, Math.round(score)));

  return {
    overallScore: finalScore,
    rating: getScoreRating(finalScore),
    severityCounts: countBySeverity(issueFamilies),
    categoryCounts: countByCategory(issueFamilies),
  };
}
