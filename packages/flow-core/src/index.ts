export const VERSION = '0.0.1';

export type {
  AffectedItem,
  Category,
  Confidence,
  Finding,
  FindingLocation,
  FindingMetadata,
  IssueFamily,
  Rating,
  ScoreSummary,
  Severity,
} from './types.js';

export { buildIssueFamilies, calculateScore, getScoreRating } from './scorer.js';

export { describeFinding } from './health-findings.js';

export {
  ORG_HEALTH_THRESHOLDS,
  coverageBand,
  usageBand,
  inactiveBand,
  worstBand,
  summariseCoverage,
  summariseInactiveUsers,
  summariseLicenses,
  summariseApiVersions,
  summariseLimits,
} from './org-health-checks.js';
export type {
  Band,
  CheckBody,
  RawOrgWideCoverageRow,
  RawUserRow,
  RawLicenseRow,
  RawApexVersionRow,
  RawLimits,
} from './org-health-checks.js';

export { shapeClassCoverage, classCoverageBand } from './coverage.js';
export type { ClassCoverageBand, RawClassCoverageRow, ClassCoverageRow } from './coverage.js';

export {
  escapeSoql,
  METADATA_TYPES,
  METADATA_TYPE_REGISTRY,
  GRAPH_SOURCE_TYPES,
  resolveQueryFor,
  referencesQuery,
  referencedByQuery,
  neighborsQuery,
  groupByType,
} from './dependencies.js';
export type { MetadataType, MetadataTypeInfo, GraphSourceType, DependencyGroup } from './dependencies.js';

export {
  ApiNameLibrary,
  DEFAULT_PREFIXES,
  ICON_TO_TYPE,
} from './api-name.js';
export type {
  ApiNameImportResult,
  NamingPattern,
  PrefixEntry,
  PrefixFile,
  ApiNameLibraryOptions,
} from './api-name.js';

export { createMemoryStorage } from './storage.js';
export type { KeyValueStorage } from './storage.js';

export {
  FREQUENCY,
  DAYS_LONG,
  DAYS_SHORT,
  MONTHS_LONG,
  MONTHS_SHORT,
  parseSchedule,
  parseActivationDate,
  getScheduleStartDateTime,
  calculateNextRun,
  isExpired,
  getRunsInRange,
  buildSummarySentence,
  formatFilters,
  formatTime,
  formatDateLong,
  formatDateTimeLong,
  formatRelative,
} from './scheduled-calc.js';
export type {
  FlowFilterClause,
  FlowFilterValue,
  FlowMetadata,
  FlowRecord,
  FlowScheduleBlock,
  FlowStartBlock,
  Frequency,
  ParsedSchedule,
} from './scheduled-calc.js';

export {
  DEFAULT_PROMPT_TEMPLATES,
  assembleDefaultPrompt,
  getDefaultPromptById,
  getFallbackDefaultPromptId,
} from './default-prompts.js';
export type {
  DefaultPromptTemplate,
  PromptCategory,
  PromptContext,
} from './default-prompts.js';

export { normalize } from './normalize.js';
export type {
  Dependency,
  FlowType,
  NodeType,
  NormalizeOptions,
  NormalizedEdge,
  NormalizedFlow,
  NormalizedMeta,
  NormalizedNode,
  NormalizedResource,
  NormalizedTrigger,
  RawFlowMetadata,
  RawStartBlock,
  TriggerEvent,
  TriggerTiming,
} from './normalize.js';

export { evaluate } from './rules.js';
export type { RulesConfig } from './rules.js';

export { runFlowQuality, parseApiVersion, DEFAULT_RULES_CONFIG } from './flow-quality.js';
export type { FlowQualityOptions, FlowQualityReport } from './flow-quality.js';

export { expectedGaApiVersion, releaseFromVersionList } from './org-release.js';
export type { OrgApiVersionEntry, OrgReleaseInfo } from './org-release.js';

export { detectTriggerConflicts } from './trigger-conflicts.js';
export type {
  FlowConflictCandidate,
  FlowConflictGroup,
} from './trigger-conflicts.js';

export { buildSubflowGraph, getCallChains } from './subflow-graph.js';
export type {
  SubflowCycle,
  SubflowGraph,
  SubflowGraphCandidate,
  SubflowGraphNode,
} from './subflow-graph.js';

export {
  makeErrorResponse,
  makeSuccessResponse,
  validateSfdtRequest,
} from './bridge-contract.js';
export type {
  AiRequest,
  CompareRequest,
  DeployRequest,
  DriftRequest,
  PingRequest,
  PingResponseData,
  QualityRequest,
  QualityResponseData,
  RequestEnvelope,
  RollbackRequest,
  ScanRequest,
  SfdtErrorResponse,
  SfdtRequest,
  SfdtRequestKind,
  SfdtResponse,
  SfdtSuccessResponse,
  ValidationError,
  VersionRequest,
  VersionResponseData,
} from './bridge-contract.js';

export {
  cleanFlowMetadata,
  estimateTokens,
  summariseFlowMetadata,
} from './metadata-cleaner.js';
export type { FlowMetadataSummary } from './metadata-cleaner.js';

export { PromptLibrary, PROMPT_CATEGORIES } from './prompts.js';
export type {
  ConflictMode,
  CustomPrompt,
  ImportEntry,
  ImportError,
  ImportOptions,
  ImportResult,
  PromptLibraryOptions,
  ResolvedPrompt,
  ValidationResult,
} from './prompts.js';

export {
  extractApexRefs,
  extractLwcApexRefs,
  extractFormulaRefs,
  extractFlowRefs,
} from './dependency-parsers.js';
export type { InferredRef, InferredRefKind } from './dependency-parsers.js';

// "What writes this field?" (P4-4) — the single Flow parsing engine for field
// writes, consumed by the Field Impact model below.
export {
  extractFieldWrites,
  filterFieldWrites,
  FIELD_WRITE_KIND_LABELS,
} from './field-writes.js';
export type {
  FieldWriteKind,
  FieldWriteQuery,
  FieldWriteStatus,
  FlowFieldWrite,
} from './field-writes.js';

// Field Impact Analysis — the viewmodel, the scan caps and the pure Tooling
// query builders. Shared by `sfdt field`, the MCP tools and the Chrome
// extension so every surface scans an org to the same depth and applies the
// same confirmed/inferred vocabulary to what it finds.
export {
  analyzeFieldImpact,
  buildFieldImpactVM,
  flowBuilderUrl,
  setupRecordUrl,
  STATUS_LEGEND,
  FLOW_CANDIDATE_CAP,
  FLOW_ANALYSE_CAP,
  WORKFLOW_LIST_CAP,
  WORKFLOW_METADATA_CAP,
  WORKFLOW_DETAIL_CONCURRENCY,
  APEX_HIT_CAP,
  customFieldIdQuery,
  flowCandidateQuery,
  recentActiveFlowsQuery,
  flowMetadataQuery,
  workflowFieldUpdateListQuery,
  workflowFieldUpdateDetailQuery,
  objectFromFullName,
  apexSearchSosl,
  otherReferencesQuery,
  REFERENCE_CAP,
} from './field-impact.js';
export type {
  FieldImpactQueries,
  FieldImpactRequest,
  FieldImpactStatus,
  FieldImpactSourceType,
  FlowCandidate,
  WorkflowFieldUpdateCandidate,
  ApexSearchHit,
  FieldImpactInput,
  FieldImpactRow,
  FieldImpactVM,
} from './field-impact.js';

// Object-wide field usage — the sweep that precedes a cleanup, plus the
// population fold that makes `safeToRemove` mean something. Shared by
// `sfdt field usage` and any surface that wants the same adjudication.
export {
  analyzeFieldUsage,
  applyPopulation,
  chunk,
  customFieldsForObjectQuery,
  dependencyBatchQuery,
  developerName,
  DEPENDENCY_CHUNK,
  DEPENDENCY_ROW_CAP,
  FIELD_ID_CAP,
} from './field-usage.js';
export type {
  FieldUsageQueries,
  FieldUsageFieldInput,
  FieldUsageRow,
  FieldUsageVM,
  FieldPopulation,
} from './field-usage.js';

// Record editability model — shared by the CLI (`sfdt record`), the MCP tools
// and the Chrome extension, so a field is refused identically on every surface.
export {
  EDITABLE_TYPES,
  isEditableType,
  SYSTEM_FIELD_NAMES,
  classifyFieldEditability,
  formatForInput,
  coerceForWire,
  buildDirtyDiff,
  buildCreateBody,
  mapSaveErrors,
} from './record-edit.js';
export type {
  FieldDescribe,
  SalesforceRestErrorDetail,
  EditableType,
  NotEditableReason,
  EditabilityMode,
  FieldEditability,
  InputValue,
  DirtyDiff,
  DescribeLike,
  CreateBody,
  FieldSaveError,
  BannerSaveError,
  MappedSaveErrors,
} from './record-edit.js';
