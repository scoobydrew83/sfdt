export type Severity = 'high' | 'medium' | 'low' | 'info';

export type Category = 'performance' | 'reliability' | 'maintainability' | 'portability';

export type Confidence = 'high' | 'medium' | 'low';

export interface FindingLocation {
  elementLabel?: string;
  elementApiName?: string | null;
  resourceName?: string;
}

export interface FindingMetadata {
  dependencyName?: string;
  [key: string]: unknown;
}

export interface Finding {
  id: string;
  ruleId: string;
  scoreFamily: string;
  title: string;
  severity: Severity;
  category: Category;
  confidence: Confidence;
  message: string;
  recommendation?: string;
  location?: FindingLocation;
  metadata?: FindingMetadata;
}

export interface AffectedItem {
  type: 'element' | 'resource' | 'dependency';
  label: string;
  apiName: string | null;
}

export interface IssueFamily {
  scoreFamily: string;
  title: string;
  severity: Severity;
  category: Category;
  scoreImpact: number;
  instanceCount: number;
  findings: Finding[];
  affectedItems: AffectedItem[];
}

export type Rating = 'Excellent' | 'Very Good' | 'Good' | 'Poor' | 'Very Poor';

export interface ScoreSummary {
  overallScore: number;
  rating: Rating;
  severityCounts: Record<Severity, number>;
  categoryCounts: Record<Category, number>;
}
