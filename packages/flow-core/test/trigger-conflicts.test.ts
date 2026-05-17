import { describe, it, expect } from 'vitest';
import { detectTriggerConflicts } from '../src/trigger-conflicts.js';
import type { RawFlowMetadata } from '../src/normalize.js';

function recordTriggered(
  triggerType: string,
  recordTriggerType: string,
  object: string,
  filters: number = 0,
): RawFlowMetadata {
  return {
    processType: 'AutoLaunchedFlow',
    start: {
      triggerType,
      recordTriggerType,
      object,
      filters: filters > 0 ? Array.from({ length: filters }, () => ({})) : [],
    },
  };
}

describe('flow-core/trigger-conflicts', () => {
  it('groups two record-triggered flows sharing object + timing + event', () => {
    const groups = detectTriggerConflicts([
      {
        flowId: 'A',
        label: 'A',
        metadata: recordTriggered('RecordAfterSaveCreate', 'Create', 'Account'),
      },
      {
        flowId: 'B',
        label: 'B',
        metadata: recordTriggered('RecordAfterSaveCreate', 'Create', 'Account'),
      },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.objectApiName).toBe('Account');
    expect(groups[0]!.flows).toHaveLength(2);
  });

  it('does NOT group flows on different objects', () => {
    const groups = detectTriggerConflicts([
      {
        flowId: 'A',
        label: 'A',
        metadata: recordTriggered('RecordAfterSaveCreate', 'Create', 'Account'),
      },
      {
        flowId: 'B',
        label: 'B',
        metadata: recordTriggered('RecordAfterSaveCreate', 'Create', 'Opportunity'),
      },
    ]);
    expect(groups).toEqual([]);
  });

  it('does NOT group flows with different timing (before vs after save)', () => {
    const groups = detectTriggerConflicts([
      {
        flowId: 'A',
        label: 'A',
        metadata: recordTriggered('RecordAfterSaveCreate', 'Create', 'Account'),
      },
      {
        flowId: 'B',
        label: 'B',
        metadata: recordTriggered('RecordBeforeSaveCreate', 'Create', 'Account'),
      },
    ]);
    expect(groups).toEqual([]);
  });

  it('does NOT group flows on different events (Create vs Update)', () => {
    const groups = detectTriggerConflicts([
      {
        flowId: 'A',
        label: 'A',
        metadata: recordTriggered('RecordAfterSaveCreate', 'Create', 'Account'),
      },
      {
        flowId: 'B',
        label: 'B',
        metadata: recordTriggered('RecordAfterSaveUpdate', 'Update', 'Account'),
      },
    ]);
    expect(groups).toEqual([]);
  });

  it('skips non-record-triggered flows', () => {
    const groups = detectTriggerConflicts([
      {
        flowId: 'A',
        label: 'A',
        metadata: { processType: 'Flow', start: { triggerType: 'None' } },
      },
      {
        flowId: 'B',
        label: 'B',
        metadata: { processType: 'Flow', start: { triggerType: 'None' } },
      },
    ]);
    expect(groups).toEqual([]);
  });

  it('captures the entry criteria summary for each flow in a group', () => {
    const groups = detectTriggerConflicts([
      {
        flowId: 'A',
        label: 'A',
        metadata: recordTriggered('RecordAfterSaveCreate', 'Create', 'Account', 2),
      },
      {
        flowId: 'B',
        label: 'B',
        metadata: recordTriggered('RecordAfterSaveCreate', 'Create', 'Account', 0),
      },
    ]);
    expect(groups[0]!.flows.map((f) => f.entryCriteriaSummary)).toEqual([
      '2 start filters configured',
      null,
    ]);
  });

  it('returns groups sorted by object, then timing, then event', () => {
    const groups = detectTriggerConflicts([
      {
        flowId: 'X1',
        label: 'X1',
        metadata: recordTriggered('RecordAfterSaveUpdate', 'Update', 'Opportunity'),
      },
      {
        flowId: 'X2',
        label: 'X2',
        metadata: recordTriggered('RecordAfterSaveUpdate', 'Update', 'Opportunity'),
      },
      {
        flowId: 'Y1',
        label: 'Y1',
        metadata: recordTriggered('RecordAfterSaveCreate', 'Create', 'Account'),
      },
      {
        flowId: 'Y2',
        label: 'Y2',
        metadata: recordTriggered('RecordAfterSaveCreate', 'Create', 'Account'),
      },
    ]);
    expect(groups.map((g) => g.objectApiName)).toEqual(['Account', 'Opportunity']);
  });
});
