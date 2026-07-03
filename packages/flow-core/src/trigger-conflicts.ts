// Groups record-triggered Flows that share the same object + timing + event.
// Pure data analysis over already-normalized records — the CLI and extension
// share this engine.

import { normalize, type NormalizedFlow, type RawFlowMetadata } from './normalize.js';

export interface FlowConflictCandidate {
  flowId: string;          // Whatever id the caller passes through — Flow's Id, DeveloperName, etc.
  label: string;           // Display label
  metadata: RawFlowMetadata;
}

export interface FlowConflictGroup {
  objectApiName: string;
  triggerTiming: NormalizedFlow['trigger']['timing'];
  triggerEvent: NormalizedFlow['trigger']['event'];
  // entryCriteriaSummary is informational — a null-or-broad summary often
  // turns out to be the real culprit, but two flows with different formulas
  // can still legitimately co-exist. Include the summaries so the user can
  // judge.
  flows: Array<{
    flowId: string;
    label: string;
    entryCriteriaSummary: string | null;
  }>;
}

type TriggerEvent = NormalizedFlow['trigger']['event'];

// The record events a flow actually fires on. A CreateOrUpdate flow
// (recordTriggerType "CreateAndUpdate") runs on BOTH create and update, so it
// overlaps — and can therefore conflict with — Create-only and Update-only
// flows on the same object + timing. Expanding it into both base events is what
// lets the detector catch that overlap while still keeping pure Create and pure
// Update flows in separate, non-conflicting buckets.
function firesOn(event: TriggerEvent): TriggerEvent[] {
  return event === 'CreateOrUpdate' ? ['Create', 'Update'] : [event];
}

/**
 * Identify record-triggered flows that share the same object + timing + event,
 * which is the canonical "two flows fire on the same save" scenario that
 * Salesforce documentation warns about. Returns one group per overlap of
 * 2 or more flows.
 *
 * The detector is conservative: a flow that only differs by entry criteria is
 * still flagged because the criteria are evaluated AFTER the trigger fires
 * and the order of execution is not guaranteed across flows in the same
 * group. The user is the right judge of whether the criteria are mutually
 * exclusive enough to make co-existence safe.
 */
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
    if (normalized.meta.flowType !== 'RecordTriggered') continue;
    const obj = normalized.trigger.objectApiName;
    if (!obj) continue;

    for (const event of firesOn(normalized.trigger.event)) {
      const key = [obj, normalized.trigger.timing, event].join('::');
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          objectApiName: obj,
          triggerTiming: normalized.trigger.timing,
          triggerEvent: event,
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
  }

  // A group whose flows are all CreateOrUpdate lands identically under both the
  // Create and Update buckets — collapse those by exact flow-id set so a pair of
  // CreateAndUpdate flows reads as one conflict, not two.
  const seen = new Set<string>();
  return Array.from(buckets.values())
    .filter((bucket) => bucket.flows.length >= 2)
    .filter((bucket) => {
      const sig = bucket.flows.map((f) => f.flowId).sort().join('|');
      if (seen.has(sig)) return false;
      seen.add(sig);
      return true;
    })
    .sort((a, b) => {
      if (a.objectApiName !== b.objectApiName) return a.objectApiName.localeCompare(b.objectApiName);
      if (a.triggerTiming !== b.triggerTiming) return a.triggerTiming.localeCompare(b.triggerTiming);
      return a.triggerEvent.localeCompare(b.triggerEvent);
    });
}
