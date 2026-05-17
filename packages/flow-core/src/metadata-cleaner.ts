// Strips canvas coordinates, builder internals, nulls, and empty containers
// from a Tooling API Flow.Metadata blob — smaller AI payload, cleaner CLI
// serialisation.

export interface FlowMetadataSummary {
  label: string;
  processType: string;
  status: string;
  apiVersion: string | number;
  description: string;
  totalElements: number;
  totalResources: number;
  elements: Record<string, number>;
  resources: Record<string, number>;
}

function cleanNode(node: unknown): unknown {
  if (node === null || node === undefined) return undefined;
  if (typeof node !== 'object') return node;

  if (Array.isArray(node)) {
    const out: unknown[] = [];
    for (const item of node) {
      const c = cleanNode(item);
      if (c !== undefined && c !== null) out.push(c);
    }
    return out.length > 0 ? out : undefined;
  }

  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'locationX' || key === 'locationY') continue;
    if (key === 'processMetadataValues') {
      if (Array.isArray(value) && value.length === 0) continue;
    }
    const c = cleanNode(value);
    if (c === null || c === undefined) continue;
    if (Array.isArray(c) && c.length === 0) continue;
    if (typeof c === 'object' && !Array.isArray(c) && Object.keys(c).length === 0) continue;
    cleaned[key] = c;
  }
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

export function cleanFlowMetadata(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const draft = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
  delete draft.processMetadataValues;
  const cleaned = cleanNode(draft);
  return (cleaned as Record<string, unknown>) ?? undefined;
}

const ELEMENT_TYPES: ReadonlyArray<readonly [string, string]> = [
  ['actionCalls', 'Actions'],
  ['assignments', 'Assignments'],
  ['decisions', 'Decisions'],
  ['loops', 'Loops'],
  ['recordCreates', 'Create Records'],
  ['recordDeletes', 'Delete Records'],
  ['recordLookups', 'Get Records'],
  ['recordUpdates', 'Update Records'],
  ['screens', 'Screens'],
  ['subflows', 'Subflows'],
  ['transforms', 'Transforms'],
  ['collectionProcessors', 'Collection Processors'],
  ['waits', 'Waits'],
  ['recordRollbacks', 'Rollbacks'],
];

const RESOURCE_TYPES: ReadonlyArray<readonly [string, string]> = [
  ['variables', 'Variables'],
  ['formulas', 'Formulas'],
  ['constants', 'Constants'],
  ['textTemplates', 'Text Templates'],
  ['choices', 'Choices'],
  ['dynamicChoiceSets', 'Dynamic Choice Sets'],
  ['stages', 'Stages'],
];

export function summariseFlowMetadata(metadata: Record<string, unknown> | null | undefined): FlowMetadataSummary | null {
  if (!metadata) return null;
  const elements: Record<string, number> = {};
  let totalElements = 0;
  for (const [key, label] of ELEMENT_TYPES) {
    const arr = metadata[key];
    const count = Array.isArray(arr) ? arr.length : 0;
    if (count > 0) {
      elements[label] = count;
      totalElements += count;
    }
  }
  const resources: Record<string, number> = {};
  let totalResources = 0;
  for (const [key, label] of RESOURCE_TYPES) {
    const arr = metadata[key];
    const count = Array.isArray(arr) ? arr.length : 0;
    if (count > 0) {
      resources[label] = count;
      totalResources += count;
    }
  }
  return {
    label: String(metadata.label ?? 'Unknown'),
    processType: String(metadata.processType ?? 'Unknown'),
    status: String(metadata.status ?? 'Unknown'),
    apiVersion: (metadata.apiVersion as string | number) ?? 'Unknown',
    description: String(metadata.description ?? '(No description)'),
    totalElements,
    totalResources,
    elements,
    resources,
  };
}

/**
 * Rough token estimate for a JSON string. The 4-char-per-token heuristic
 * matches v2.0.2 and is good enough for "raw vs clean savings" UI labels.
 */
export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}
