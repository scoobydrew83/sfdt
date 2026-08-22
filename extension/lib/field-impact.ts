// Field Impact Analysis — re-export shim.
//
// The viewmodel and the pure Tooling query builders moved to
// `@sfdt/flow-core`'s `field-impact` module so the CLI, MCP, VS Code and the
// browser reach identical conclusions about what writes a field, from one
// implementation and to the same scan depth.
//
// This file stays so extension code (and its tests) keep importing
// `../lib/field-impact.js` unchanged — the same shape `lib/record-edit.ts` took
// when the record editability model was promoted.

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
} from '@sfdt/flow-core';

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
} from '@sfdt/flow-core';
