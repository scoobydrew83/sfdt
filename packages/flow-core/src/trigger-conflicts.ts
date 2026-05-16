import { normalize, type NormalizedFlow, type RawFlowMetadata } from './normalize.js';
export interface FlowConflictCandidate {
  flowId: string;
  label: string;
  metadata: RawFlowMetadata;
}
export interface FlowConflictGroup {
  objectApiName: string;
  triggerTiming: NormalizedFlow['trigger']['timing'];
  triggerEvent: NormalizedFlow['trigger']['event'];
  flows: Array<{
    flowId: string;
    label: string;
    entryCriteriaSummary: string | null;
  }>;
}
function groupKey(flow: NormalizedFlow): string | null {
  if (flow.meta.flowType !== 'RecordTriggered') return null;
  const obj = flow.trigger.objectApiName;
  if (!obj) return null;
  return [obj, flow.trigger.timing, flow.trigger.event].join('::');
}
export function detectTriggerConflicts(
  candidates: readonly FlowConflictCandidate[],
): FlowConflictGroup[] {
  const buckets = new Map<
    string,
    {
      objectApiName: string;
      triggerTiming: NormalizedFlow['trigger']['timing'];
      triggerEvent: NormalizedFlow['trigger']['event'];
      flows: Array<{ flowId: string; label: string; entryCriteriaSummary: string | null }>;
    }
  >();
  for (const candidate of candidates) {
    let normalized: NormalizedFlow;
    try {
      normalized = normalize(candidate.metadata, { flowApiName: candidate.flowId });
    } catch {
      continue;
    }
    const key = groupKey(normalized);
    if (!key) continue;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        objectApiName: normalized.trigger.objectApiName!,
        triggerTiming: normalized.trigger.timing,
        triggerEvent: normalized.trigger.event,
        flows: [],
      };
      buckets.set(key, bucket);
    }
    bucket.flows.push({
      flowId: candidate.flowId,
      label: candidate.label,
      entryCriteriaSummary: normalized.trigger.entryCriteriaSummary,
    });
  }
  return Array.from(buckets.values())
    .filter((bucket) => bucket.flows.length >= 2)
    .sort((a, b) => {
      if (a.objectApiName !== b.objectApiName) return a.objectApiName.localeCompare(b.objectApiName);
      if (a.triggerTiming !== b.triggerTiming) return a.triggerTiming.localeCompare(b.triggerTiming);
      return a.triggerEvent.localeCompare(b.triggerEvent);
    });
}
