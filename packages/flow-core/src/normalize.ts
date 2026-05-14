// Flow health normalizer — ported from
// /Users/dkennedy/dev/2.0.2_0 copy/utils/flow-health-normalizer.js.
//
// Turns the raw Tooling API Flow.Metadata payload into a stable internal
// shape consumed by the rules engine and scorer. Pure logic; no DOM, no API.

// ---------------------------------------------------------------------------
// Raw input shapes (Tooling API Flow.Metadata block — partial, only what the
// normalizer actually reads). Every field is optional because Salesforce
// omits keys whose value is the default.

export interface RawConnector {
  targetReference?: string;
}

export interface RawDecisionRule {
  name?: string;
  label?: string;
  connector?: RawConnector;
}

export interface RawScreenField {
  fieldType?: string;
  extensionName?: string;
  [key: string]: unknown;
}

export interface RawElementBase {
  name?: string;
  label?: string;
  description?: string;
  connector?: RawConnector;
  faultConnector?: RawConnector;
  [key: string]: unknown;
}

export interface RawActionCall extends RawElementBase {
  actionType?: string;
  actionName?: string;
  inputParameters?: unknown[];
  outputParameters?: unknown[];
  timeoutConnector?: RawConnector;
}

export interface RawAssignment extends RawElementBase {
  assignmentItems?: unknown[];
}

export interface RawDecision extends RawElementBase {
  rules?: RawDecisionRule[];
  defaultConnector?: RawConnector;
  defaultConnectorLabel?: string;
}

export interface RawRecordElement extends RawElementBase {
  object?: string;
  filters?: unknown[];
}

export interface RawScreen extends RawElementBase {
  fields?: RawScreenField[];
}

export interface RawLoop extends RawElementBase {
  nextValueConnector?: RawConnector;
  noMoreValuesConnector?: RawConnector;
  collectionReference?: string;
}

export interface RawSubflow extends RawElementBase {
  flowName?: string;
}

export interface RawVariable {
  name?: string;
  description?: string;
  dataType?: string;
  isCollection?: boolean;
  isInput?: boolean;
  isOutput?: boolean;
  value?: unknown;
  apexClass?: string;
}

export interface RawFormula {
  name?: string;
  description?: string;
  dataType?: string;
  expression?: string;
}

export interface RawConstant {
  name?: string;
  description?: string;
  dataType?: string;
  value?: unknown;
}

export interface RawTextTemplate {
  name?: string;
  description?: string;
  text?: string;
}

export interface RawStartBlock {
  triggerType?: string;
  recordTriggerType?: string;
  eventType?: string;
  flowRunAsUser?: string;
  description?: string;
  connector?: RawConnector;
  schedule?: unknown;
  object?: string;
  filters?: unknown[];
  filterFormula?: string;
}

export interface RawFlowMetadata {
  label?: string;
  description?: string;
  fullName?: string;
  apiVersion?: number | string;
  status?: string;
  processType?: string;
  runInMode?: string;
  start?: RawStartBlock;
  actionCalls?: RawActionCall[];
  assignments?: RawAssignment[];
  decisions?: RawDecision[];
  recordLookups?: RawRecordElement[];
  recordCreates?: RawRecordElement[];
  recordUpdates?: RawRecordElement[];
  recordDeletes?: RawRecordElement[];
  screens?: RawScreen[];
  loops?: RawLoop[];
  transforms?: RawElementBase[];
  subflows?: RawSubflow[];
  collectionProcessors?: RawElementBase[];
  variables?: RawVariable[];
  formulas?: RawFormula[];
  constants?: RawConstant[];
  textTemplates?: RawTextTemplate[];
  [key: string]: unknown;
}

export interface NormalizeOptions {
  flowVersionId?: string | null;
  flowApiName?: string | null;
}

// ---------------------------------------------------------------------------
// Normalized output shapes.

export type NodeType =
  | 'Start'
  | 'Action'
  | 'Assignment'
  | 'Decision'
  | 'GetRecords'
  | 'CreateRecords'
  | 'UpdateRecords'
  | 'DeleteRecords'
  | 'Screen'
  | 'Loop'
  | 'Transform'
  | 'Subflow'
  | 'CollectionProcessor';

export interface NormalizedNode {
  id: string;
  type: NodeType;
  label: string;
  apiName: string;
  description: string | null | undefined;
  supportsFaultPath: boolean;
  hasFaultPath: boolean;
  isInLoop: boolean;
  loopDepth: number;
  metadata: Record<string, unknown>;
}

export interface NormalizedResource {
  name: string;
  type: 'Variable' | 'Formula' | 'Constant' | 'TextTemplate';
  dataType: string | null | undefined;
  description: string | null | undefined;
  metadata: Record<string, unknown>;
}

export interface NormalizedEdge {
  from: string;
  to: string;
  kind: 'default' | 'fault' | 'loop' | 'decision';
  label: string | null;
}

export interface Dependency {
  type: 'ApexAction' | 'LwcComponent' | 'Subflow' | 'ApexDefinedType';
  name: string;
  count: number;
}

export type FlowType = 'ScreenFlow' | 'Autolaunched' | 'Scheduled' | 'RecordTriggered' | 'Unknown';

export type TriggerTiming = 'BeforeSave' | 'AfterSave' | 'Async' | 'Unknown';
export type TriggerEvent = 'Create' | 'Update' | 'CreateOrUpdate' | 'Delete' | 'Unknown';

export interface NormalizedMeta {
  flowVersionId: string | null;
  flowLabel: string;
  flowApiName: string;
  flowType: FlowType;
  apiVersion: number | string | null;
  status: string;
}

export interface NormalizedTrigger {
  objectApiName: string | null;
  timing: TriggerTiming;
  event: TriggerEvent;
  entryCriteriaSummary: string | null;
  runContext: string;
}

export interface NormalizedFlow {
  meta: NormalizedMeta;
  trigger: NormalizedTrigger;
  nodes: NormalizedNode[];
  edges: NormalizedEdge[];
  resources: NormalizedResource[];
  dependencies: Dependency[];
  metadata: RawFlowMetadata;
}

// ---------------------------------------------------------------------------
// Normalize

function detectFlowType(metadata: RawFlowMetadata): FlowType {
  // recordTriggerType wins over processType — a record-triggered flow is
  // almost always saved with processType="AutoLaunchedFlow", so the original
  // v2.0.2 normalizer (which checked processType first) never classified any
  // flow as RecordTriggered. The record-trigger-specific rules in rules.ts
  // (broad_entry_criteria, trigger_timing_mismatch) consequently never fired.
  // Promoting this check fixes that latent bug.
  if (metadata.start?.recordTriggerType) return 'RecordTriggered';
  if ((metadata.screens ?? []).length > 0) return 'ScreenFlow';
  if (metadata.start?.schedule) return 'Scheduled';
  const processType = metadata.processType ?? '';
  if (processType === 'Flow') return 'Autolaunched';
  if (processType === 'AutoLaunchedFlow') return 'Autolaunched';
  if (processType === 'Workflow') return 'Autolaunched';
  return 'Unknown';
}

function detectTriggerTiming(metadata: RawFlowMetadata): TriggerTiming {
  // Timing lives in triggerType (RecordBeforeSave / RecordAfterSave / Async).
  // recordTriggerType is the event (Create / Update / Delete / CreateAndUpdate)
  // and has no timing words, so reading it here would always return Unknown.
  // The v2.0.2 normalizer had this bug too — it preferred recordTriggerType
  // and consequently classified every record-triggered flow as Unknown
  // timing, suppressing the trigger_timing_mismatch rule.
  const triggerType = metadata.start?.triggerType ?? metadata.start?.eventType ?? '';
  const normal = triggerType.toLowerCase();
  if (!normal) return 'Unknown';
  if (normal.includes('before')) return 'BeforeSave';
  if (normal.includes('after')) return 'AfterSave';
  if (normal.includes('async')) return 'Async';
  return 'Unknown';
}

function detectTriggerEvent(metadata: RawFlowMetadata): TriggerEvent {
  const start = metadata.start ?? {};
  const event = start.triggerType ?? start.eventType ?? '';
  const normal = String(event).toLowerCase();
  if (normal.includes('create') && normal.includes('update')) return 'CreateOrUpdate';
  if (normal.includes('create')) return 'Create';
  if (normal.includes('update')) return 'Update';
  if (normal.includes('delete')) return 'Delete';
  return 'Unknown';
}

function detectRunContext(metadata: RawFlowMetadata): string {
  return metadata.runInMode ?? metadata.start?.flowRunAsUser ?? 'Unknown';
}

function buildEntryCriteriaSummary(metadata: RawFlowMetadata): string | null {
  const start = metadata.start ?? {};
  const filterCount = (start.filters ?? []).length;
  const hasFormula = !!start.filterFormula;
  if (filterCount === 0 && !hasFormula) return null;
  if (hasFormula) return 'Formula criteria defined';
  return `${filterCount} start filter${filterCount === 1 ? '' : 's'} configured`;
}

function buildEdges(metadata: RawFlowMetadata): NormalizedEdge[] {
  const edges: NormalizedEdge[] = [];
  function pushEdge(
    from: string | undefined,
    to: string | undefined,
    kind: NormalizedEdge['kind'] = 'default',
    label: string | null = null,
  ): void {
    if (!from || !to) return;
    edges.push({ from, to, kind, label });
  }

  if (metadata.start?.connector?.targetReference) {
    pushEdge('__start__', metadata.start.connector.targetReference, 'default');
  }

  (metadata.actionCalls ?? []).forEach((item) => {
    pushEdge(item.name, item.connector?.targetReference, 'default');
    pushEdge(item.name, item.faultConnector?.targetReference, 'fault');
    pushEdge(item.name, item.timeoutConnector?.targetReference, 'fault');
  });
  (metadata.assignments ?? []).forEach((item) =>
    pushEdge(item.name, item.connector?.targetReference, 'default'),
  );
  (metadata.recordLookups ?? []).forEach((item) => {
    pushEdge(item.name, item.connector?.targetReference, 'default');
    pushEdge(item.name, item.faultConnector?.targetReference, 'fault');
  });
  (metadata.recordCreates ?? []).forEach((item) => {
    pushEdge(item.name, item.connector?.targetReference, 'default');
    pushEdge(item.name, item.faultConnector?.targetReference, 'fault');
  });
  (metadata.recordUpdates ?? []).forEach((item) => {
    pushEdge(item.name, item.connector?.targetReference, 'default');
    pushEdge(item.name, item.faultConnector?.targetReference, 'fault');
  });
  (metadata.recordDeletes ?? []).forEach((item) => {
    pushEdge(item.name, item.connector?.targetReference, 'default');
    pushEdge(item.name, item.faultConnector?.targetReference, 'fault');
  });
  (metadata.screens ?? []).forEach((item) =>
    pushEdge(item.name, item.connector?.targetReference, 'default'),
  );
  (metadata.loops ?? []).forEach((item) => {
    pushEdge(item.name, item.nextValueConnector?.targetReference, 'loop', 'nextValue');
    pushEdge(item.name, item.noMoreValuesConnector?.targetReference, 'default', 'noMoreValues');
  });
  (metadata.decisions ?? []).forEach((item) => {
    (item.rules ?? []).forEach((rule) => {
      pushEdge(item.name, rule.connector?.targetReference, 'decision', rule.label ?? rule.name ?? null);
    });
    pushEdge(item.name, item.defaultConnector?.targetReference, 'decision', item.defaultConnectorLabel ?? 'Default');
  });
  (metadata.transforms ?? []).forEach((item) =>
    pushEdge(item.name, item.connector?.targetReference, 'default'),
  );
  (metadata.subflows ?? []).forEach((item) => {
    pushEdge(item.name, item.connector?.targetReference, 'default');
    pushEdge(item.name, item.faultConnector?.targetReference, 'fault');
  });
  (metadata.collectionProcessors ?? []).forEach((item) =>
    pushEdge(item.name, item.connector?.targetReference, 'default'),
  );

  return edges;
}

function computeLoopMembership(edges: NormalizedEdge[]): Record<string, number> {
  const byNode: Record<string, number> = {};
  const loopTargets = new Set(
    edges.filter((e) => e.kind === 'loop' && e.to).map((e) => e.to),
  );
  if (loopTargets.size === 0) return byNode;

  const outgoing: Record<string, NormalizedEdge[]> = {};
  edges.forEach((edge) => {
    (outgoing[edge.from] ??= []).push(edge);
  });

  const visited = new Set<string>();
  const queue: Array<{ id: string; depth: number }> = Array.from(loopTargets).map((id) => ({
    id,
    depth: 1,
  }));

  while (queue.length) {
    const current = queue.shift();
    if (!current || visited.has(current.id)) continue;
    visited.add(current.id);
    byNode[current.id] = Math.max(byNode[current.id] ?? 0, current.depth);
    const nextEdges = outgoing[current.id] ?? [];
    for (const edge of nextEdges) {
      if (edge.kind === 'fault') continue;
      if (edge.label === 'noMoreValues') continue;
      if (!visited.has(edge.to)) queue.push({ id: edge.to, depth: current.depth });
    }
  }
  return byNode;
}

function mergeDependencies(items: Dependency[]): Dependency[] {
  const map = new Map<string, Dependency>();
  for (const item of items) {
    const key = `${item.type}::${item.name}`;
    const existing = map.get(key);
    if (existing) existing.count += item.count;
    else map.set(key, { ...item });
  }
  return Array.from(map.values()).sort((a, b) => {
    if (a.type === b.type) return a.name.localeCompare(b.name);
    return a.type.localeCompare(b.type);
  });
}

function pushNode(
  nodes: NormalizedNode[],
  base: { id: string; type: NodeType; label: string; apiName: string; description?: string | null },
  partial: Partial<NormalizedNode>,
): void {
  nodes.push({
    id: base.id,
    type: base.type,
    label: base.label,
    apiName: base.apiName,
    description: base.description ?? null,
    supportsFaultPath: false,
    hasFaultPath: false,
    isInLoop: false,
    loopDepth: 0,
    metadata: {},
    ...partial,
  });
}

export function normalize(metadata: RawFlowMetadata, options: NormalizeOptions = {}): NormalizedFlow {
  const flowType = detectFlowType(metadata);
  const nodes: NormalizedNode[] = [];
  const resources: NormalizedResource[] = [];
  const dependencies: Dependency[] = [];

  // Start
  pushNode(
    nodes,
    {
      id: '__start__',
      type: 'Start',
      label: metadata.label ?? 'Start',
      apiName: '__start__',
      description: metadata.start?.description ?? metadata.description ?? null,
    },
    {
      metadata: {
        connectorTarget: metadata.start?.connector?.targetReference ?? null,
      },
    },
  );

  // Actions
  (metadata.actionCalls ?? []).forEach((item) => {
    const isApex = item.actionType === 'apex';
    pushNode(
      nodes,
      {
        id: item.name!,
        type: 'Action',
        label: item.label ?? item.name!,
        apiName: item.name!,
        description: item.description,
      },
      {
        supportsFaultPath: true,
        hasFaultPath: !!item.faultConnector?.targetReference,
        metadata: {
          actionType: item.actionType ?? null,
          actionName: item.actionName ?? null,
          connectorTarget: item.connector?.targetReference ?? null,
          inputParameters: item.inputParameters ?? [],
          outputParameters: item.outputParameters ?? [],
        },
      },
    );
    if (isApex && item.actionName) {
      dependencies.push({ type: 'ApexAction', name: item.actionName, count: 1 });
    }
  });

  // Assignments
  (metadata.assignments ?? []).forEach((item) => {
    pushNode(
      nodes,
      {
        id: item.name!,
        type: 'Assignment',
        label: item.label ?? item.name!,
        apiName: item.name!,
        description: item.description,
      },
      {
        metadata: {
          connectorTarget: item.connector?.targetReference ?? null,
          assignmentItems: item.assignmentItems ?? [],
        },
      },
    );
  });

  // Decisions
  (metadata.decisions ?? []).forEach((item) => {
    pushNode(
      nodes,
      {
        id: item.name!,
        type: 'Decision',
        label: item.label ?? item.name!,
        apiName: item.name!,
        description: item.description,
      },
      {
        metadata: {
          rules: item.rules ?? [],
          defaultConnector: item.defaultConnector?.targetReference ?? null,
        },
      },
    );
  });

  // Record ops
  const recordTypes: Array<['recordLookups' | 'recordCreates' | 'recordUpdates' | 'recordDeletes', NodeType]> = [
    ['recordLookups', 'GetRecords'],
    ['recordCreates', 'CreateRecords'],
    ['recordUpdates', 'UpdateRecords'],
    ['recordDeletes', 'DeleteRecords'],
  ];
  for (const [key, type] of recordTypes) {
    (metadata[key] as RawRecordElement[] | undefined ?? []).forEach((item) => {
      pushNode(
        nodes,
        {
          id: item.name!,
          type,
          label: item.label ?? item.name!,
          apiName: item.name!,
          description: item.description,
        },
        {
          supportsFaultPath: true,
          hasFaultPath: !!item.faultConnector?.targetReference,
          metadata: {
            object: item.object ?? null,
            connectorTarget: item.connector?.targetReference ?? null,
            ...(type === 'GetRecords' ? { filters: item.filters ?? [] } : {}),
          },
        },
      );
    });
  }

  // Screens
  (metadata.screens ?? []).forEach((item) => {
    pushNode(
      nodes,
      {
        id: item.name!,
        type: 'Screen',
        label: item.label ?? item.name!,
        apiName: item.name!,
        description: item.description,
      },
      {
        metadata: {
          connectorTarget: item.connector?.targetReference ?? null,
          fields: item.fields ?? [],
        },
      },
    );
    (item.fields ?? []).forEach((field) => {
      if (field.fieldType === 'ComponentInstance' && field.extensionName) {
        const ext = field.extensionName;
        if (!ext.startsWith('flowruntime:')) {
          dependencies.push({ type: 'LwcComponent', name: ext, count: 1 });
        }
      }
    });
  });

  // Loops
  (metadata.loops ?? []).forEach((item) => {
    pushNode(
      nodes,
      {
        id: item.name!,
        type: 'Loop',
        label: item.label ?? item.name!,
        apiName: item.name!,
        description: item.description,
      },
      {
        metadata: {
          nextValueConnector: item.nextValueConnector?.targetReference ?? null,
          noMoreValuesConnector: item.noMoreValuesConnector?.targetReference ?? null,
          collectionReference: item.collectionReference ?? null,
        },
      },
    );
  });

  // Transforms
  (metadata.transforms ?? []).forEach((item) => {
    pushNode(
      nodes,
      {
        id: item.name!,
        type: 'Transform',
        label: item.label ?? item.name!,
        apiName: item.name!,
        description: item.description,
      },
      { metadata: { connectorTarget: item.connector?.targetReference ?? null } },
    );
  });

  // Subflows
  (metadata.subflows ?? []).forEach((item) => {
    pushNode(
      nodes,
      {
        id: item.name!,
        type: 'Subflow',
        label: item.label ?? item.name!,
        apiName: item.name!,
        description: item.description,
      },
      {
        metadata: {
          flowName: item.flowName ?? null,
          connectorTarget: item.connector?.targetReference ?? null,
        },
      },
    );
    if (item.flowName) dependencies.push({ type: 'Subflow', name: item.flowName, count: 1 });
  });

  // Collection processors
  (metadata.collectionProcessors ?? []).forEach((item) => {
    pushNode(
      nodes,
      {
        id: item.name!,
        type: 'CollectionProcessor',
        label: item.label ?? item.name!,
        apiName: item.name!,
        description: item.description,
      },
      { metadata: { connectorTarget: item.connector?.targetReference ?? null } },
    );
  });

  // Resources
  (metadata.variables ?? []).forEach((item) => {
    resources.push({
      name: item.name ?? '',
      type: 'Variable',
      dataType: item.dataType,
      description: item.description,
      metadata: {
        isCollection: !!item.isCollection,
        isInput: !!item.isInput,
        isOutput: !!item.isOutput,
        value: item.value ?? null,
      },
    });
    if (item.apexClass) {
      dependencies.push({ type: 'ApexDefinedType', name: item.apexClass, count: 1 });
    }
  });

  (metadata.formulas ?? []).forEach((item) => {
    resources.push({
      name: item.name ?? '',
      type: 'Formula',
      dataType: item.dataType,
      description: item.description,
      metadata: { expression: item.expression ?? null },
    });
  });

  (metadata.constants ?? []).forEach((item) => {
    resources.push({
      name: item.name ?? '',
      type: 'Constant',
      dataType: item.dataType,
      description: item.description,
      metadata: { value: item.value ?? null },
    });
  });

  (metadata.textTemplates ?? []).forEach((item) => {
    resources.push({
      name: item.name ?? '',
      type: 'TextTemplate',
      dataType: 'Text',
      description: item.description,
      metadata: { text: item.text ?? null },
    });
  });

  const edges = buildEdges(metadata);
  const loopByNode = computeLoopMembership(edges);
  const normalizedNodes = nodes.map((node) => ({
    ...node,
    isInLoop: !!loopByNode[node.id],
    loopDepth: loopByNode[node.id] ?? 0,
  }));

  return {
    meta: {
      flowVersionId: options.flowVersionId ?? null,
      flowLabel: metadata.label ?? 'Unknown Flow',
      flowApiName: options.flowApiName ?? metadata.fullName ?? metadata.label ?? 'unknown_flow',
      flowType,
      apiVersion: metadata.apiVersion ?? null,
      status: metadata.status ?? 'Unknown',
    },
    trigger: {
      objectApiName: metadata.start?.object ?? null,
      timing: detectTriggerTiming(metadata),
      event: detectTriggerEvent(metadata),
      entryCriteriaSummary: buildEntryCriteriaSummary(metadata),
      runContext: detectRunContext(metadata),
    },
    nodes: normalizedNodes,
    edges,
    resources,
    dependencies: mergeDependencies(dependencies),
    metadata,
  };
}
