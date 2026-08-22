// Moved to @sfdt/flow-core so the CLI, the MCP tools and this extension share
// ONE editability model — see packages/flow-core/src/record-edit.ts.
//
// This file stays as the extension's import path on purpose: every consumer
// here (features/inspect-record.ts, its tests) keeps importing
// '../lib/record-edit.js' and nothing about their code changes. A re-export is
// also the honest shape for the move — there is no second implementation to
// drift, only a second name for the first one.
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
} from '@sfdt/flow-core';
export type {
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
} from '@sfdt/flow-core';
