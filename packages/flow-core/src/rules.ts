// Produces raw Finding objects; scoring is downstream in scorer.ts.
// Pure logic; no DOM, no API, no chrome.*.
// Finding ids use a per-evaluation monotonic counter (not Math.random) so
// evaluate() output is deterministic and snapshottable.

import type {
  Category,
  Confidence,
  Finding,
  FindingLocation,
  FindingMetadata,
  Severity,
} from './types.js';
import type { Dependency, NormalizedFlow, NormalizedNode, NormalizedResource } from './normalize.js';

export interface RulesConfig {
  namingConventions?: {
    flow?: RegExp;
    variable?: RegExp;
    formula?: RegExp;
    constant?: RegExp;
  };
  highDataOperationThreshold?: number;
  outdatedApiVersionThreshold?: number;
  currentApiVersion?: number;
}

interface FindingDraft {
  ruleId: string;
  scoreFamily: string;
  title: string;
  severity: Severity;
  category: Category;
  confidence?: Confidence;
  message: string;
  recommendation?: string;
  location?: FindingLocation;
  metadata?: FindingMetadata;
}

function makeFindingFactory() {
  let counter = 0;
  return function finding(draft: FindingDraft): Finding {
    counter += 1;
    return {
      id: `${draft.ruleId}-${counter}`,
      ruleId: draft.ruleId,
      scoreFamily: draft.scoreFamily,
      title: draft.title,
      severity: draft.severity,
      category: draft.category,
      confidence: draft.confidence ?? 'high',
      message: draft.message,
      ...(draft.recommendation !== undefined ? { recommendation: draft.recommendation } : {}),
      ...(draft.location !== undefined ? { location: draft.location } : {}),
      ...(draft.metadata !== undefined ? { metadata: draft.metadata } : {}),
    };
  };
}

// ---------------------------------------------------------------------------
// Individual rule checks. Each returns 0..N findings.

function checkFlowDescription(flow: NormalizedFlow, finding: ReturnType<typeof makeFindingFactory>): Finding[] {
  if (flow.metadata.description) return [];
  return [
    finding({
      ruleId: 'FLOW_DESC_MISSING',
      scoreFamily: 'flow_description',
      title: 'Flow description missing',
      severity: 'low',
      category: 'maintainability',
      message: 'The flow itself does not have a description.',
      recommendation:
        'Add a clear summary describing what triggers the flow, what it does, and the main business outcome.',
    }),
  ];
}

function checkElementDescriptions(
  flow: NormalizedFlow,
  finding: ReturnType<typeof makeFindingFactory>,
): Finding[] {
  return flow.nodes
    .filter((n) => n.type !== 'Start')
    .filter((n) => !n.description)
    .map((node) =>
      finding({
        ruleId: 'ELEMENT_DESC_MISSING',
        scoreFamily: 'element_descriptions',
        title: 'Elements missing descriptions',
        severity: 'low',
        category: 'maintainability',
        message: `The element "${node.label}" does not have a description.`,
        recommendation:
          'Add a short element description to explain its purpose and expected outcome.',
        location: { elementLabel: node.label, elementApiName: node.apiName },
      }),
    );
}

function checkResourceDescriptions(
  flow: NormalizedFlow,
  finding: ReturnType<typeof makeFindingFactory>,
): Finding[] {
  return flow.resources
    .filter((r) => !r.description)
    .map((resource) =>
      finding({
        ruleId: 'RESOURCE_DESC_MISSING',
        scoreFamily: 'resource_descriptions',
        title: 'Resources missing descriptions',
        severity: 'low',
        category: 'maintainability',
        message: `The resource "${resource.name}" does not have a description.`,
        recommendation:
          'Add a description so future admins can understand how the resource is used.',
        location: { resourceName: resource.name },
      }),
    );
}

const GENERIC_NAMING_PATTERN =
  /^(Assignment|Decision|Loop|Screen|Get Records|Update Records|Create Records|Delete Records|Action|Subflow)\s+\d+$/i;

function checkGenericElementNaming(
  flow: NormalizedFlow,
  finding: ReturnType<typeof makeFindingFactory>,
): Finding[] {
  return flow.nodes
    .filter((n) => n.type !== 'Start')
    .filter((n) => GENERIC_NAMING_PATTERN.test(n.label ?? ''))
    .map((node) =>
      finding({
        ruleId: 'GENERIC_ELEMENT_NAMING',
        scoreFamily: 'generic_element_naming',
        title: 'Generic element naming',
        severity: 'low',
        category: 'maintainability',
        message: `The element "${node.label}" uses a generic label.`,
        recommendation: 'Rename the element so its purpose is obvious from the canvas.',
        location: { elementLabel: node.label, elementApiName: node.apiName },
      }),
    );
}

const STANDARD_VARIABLE_NAMES = new Set(['recordId']);

function isAllowedResourceName(resource: NormalizedResource): boolean {
  if (!resource?.name) return false;
  if (resource.type === 'Variable' && STANDARD_VARIABLE_NAMES.has(resource.name)) return true;
  return false;
}

function checkNamingConventions(
  flow: NormalizedFlow,
  config: RulesConfig,
  finding: ReturnType<typeof makeFindingFactory>,
): Finding[] {
  const findings: Finding[] = [];
  const naming = config.namingConventions ?? {};

  if (naming.flow && flow.meta.flowApiName && !naming.flow.test(flow.meta.flowApiName)) {
    findings.push(
      finding({
        ruleId: 'NAMING_CONVENTION_MISMATCH',
        scoreFamily: 'flow_naming',
        title: 'Naming convention mismatch',
        severity: 'low',
        category: 'maintainability',
        message: `The flow API name "${flow.meta.flowApiName}" does not match the configured naming convention.`,
        recommendation: 'Align the flow API name with your team naming standard.',
      }),
    );
  }

  flow.resources.forEach((resource) => {
    let matcher: RegExp | undefined;
    if (resource.type === 'Variable') matcher = naming.variable;
    if (resource.type === 'Formula') matcher = naming.formula;
    if (resource.type === 'Constant') matcher = naming.constant;

    if (isAllowedResourceName(resource)) return;
    if (matcher && !matcher.test(resource.name)) {
      findings.push(
        finding({
          ruleId: 'NAMING_CONVENTION_MISMATCH',
          scoreFamily: 'resource_naming',
          title: 'Naming convention mismatch',
          severity: 'low',
          category: 'maintainability',
          message: `The resource name "${resource.name}" does not match the configured convention for ${resource.type}.`,
          recommendation: 'Rename the resource to align with your naming standard.',
          location: { resourceName: resource.name },
        }),
      );
    }
  });

  return findings;
}

function checkFaultPaths(flow: NormalizedFlow, finding: ReturnType<typeof makeFindingFactory>): Finding[] {
  return flow.nodes
    .filter((n) => n.supportsFaultPath)
    .filter((n) => !n.hasFaultPath)
    .map((node) => {
      let scoreFamily: string = 'fault_paths_actions';
      let severity: Severity = 'high';
      if (node.type === 'GetRecords') {
        scoreFamily = 'fault_paths_queries';
        severity = 'medium';
      } else if (
        node.type === 'CreateRecords' ||
        node.type === 'UpdateRecords' ||
        node.type === 'DeleteRecords'
      ) {
        scoreFamily = 'fault_paths_dml';
        severity = 'high';
      }
      return finding({
        ruleId: 'FAULT_PATH_MISSING',
        scoreFamily,
        title: 'Missing fault path',
        severity,
        category: 'reliability',
        message: `The element "${node.label}" does not appear to have a fault path.`,
        recommendation:
          'Add a fault path that logs, surfaces, or routes errors so failures can be diagnosed and handled safely.',
        location: { elementLabel: node.label, elementApiName: node.apiName },
      });
    });
}

const DML_TYPES = new Set<NormalizedNode['type']>(['CreateRecords', 'UpdateRecords', 'DeleteRecords']);

function checkDmlInsideLoops(flow: NormalizedFlow, finding: ReturnType<typeof makeFindingFactory>): Finding[] {
  return flow.nodes
    .filter((n) => DML_TYPES.has(n.type) && n.isInLoop)
    .map((node) =>
      finding({
        ruleId: 'DML_INSIDE_LOOP',
        scoreFamily: 'dml_inside_loops',
        title: 'DML inside loop',
        severity: 'high',
        category: 'performance',
        message: `The DML element "${node.label}" is inside a loop.`,
        recommendation:
          'Collect changes during the loop and perform the DML operation once outside the loop.',
        location: { elementLabel: node.label, elementApiName: node.apiName },
      }),
    );
}

function checkQueriesInsideLoops(
  flow: NormalizedFlow,
  finding: ReturnType<typeof makeFindingFactory>,
): Finding[] {
  return flow.nodes
    .filter((n) => n.type === 'GetRecords' && n.isInLoop)
    .map((node) =>
      finding({
        ruleId: 'QUERIES_INSIDE_LOOP',
        scoreFamily: 'queries_inside_loops',
        title: 'Get Records inside loop',
        severity: 'high',
        category: 'performance',
        message: `The query element "${node.label}" is inside a loop.`,
        recommendation:
          'Move the query outside the loop where possible or redesign the data retrieval pattern.',
        location: { elementLabel: node.label, elementApiName: node.apiName },
      }),
    );
}

function checkNestedLoops(flow: NormalizedFlow, finding: ReturnType<typeof makeFindingFactory>): Finding[] {
  return flow.nodes
    .filter((n) => n.loopDepth > 1)
    .map((node) =>
      finding({
        ruleId: 'NESTED_LOOPS',
        scoreFamily: 'nested_loops',
        title: 'Nested loop detected',
        severity: 'medium',
        category: 'performance',
        message: `The element "${node.label}" appears to be inside nested loops.`,
        recommendation:
          'Simplify nested iteration where possible to reduce complexity and scale risk.',
        location: { elementLabel: node.label, elementApiName: node.apiName },
      }),
    );
}

const DATA_OPERATION_TYPES = new Set<NormalizedNode['type']>([
  'GetRecords',
  'CreateRecords',
  'UpdateRecords',
  'DeleteRecords',
  'Action',
  'Subflow',
]);

function checkHighDataOperationCount(
  flow: NormalizedFlow,
  config: RulesConfig,
  finding: ReturnType<typeof makeFindingFactory>,
): Finding[] {
  const threshold = Number(config.highDataOperationThreshold ?? 8);
  const dataOps = flow.nodes.filter((n) => DATA_OPERATION_TYPES.has(n.type));
  if (dataOps.length <= threshold) return [];
  return [
    finding({
      ruleId: 'HIGH_DATA_OPERATION_COUNT',
      scoreFamily: 'excessive_data_operations',
      title: 'High data operation count',
      severity: 'medium',
      category: 'performance',
      message: `This flow contains ${dataOps.length} data/action operations, which exceeds the configured threshold of ${threshold}.`,
      recommendation: 'Review whether some operations can be consolidated or simplified.',
    }),
  ];
}

function checkBroadEntryCriteria(
  flow: NormalizedFlow,
  finding: ReturnType<typeof makeFindingFactory>,
): Finding[] {
  if (flow.meta.flowType !== 'RecordTriggered') return [];
  if (flow.trigger.entryCriteriaSummary) return [];
  return [
    finding({
      ruleId: 'BROAD_ENTRY_CRITERIA',
      scoreFamily: 'broad_entry_criteria',
      title: 'Broad or missing entry criteria',
      severity: 'medium',
      category: 'reliability',
      message: 'This record-triggered flow does not appear to have meaningful entry criteria.',
      recommendation: 'Add entry criteria so the flow runs only when needed.',
    }),
  ];
}

function checkTriggerTiming(
  flow: NormalizedFlow,
  finding: ReturnType<typeof makeFindingFactory>,
): Finding[] {
  if (flow.meta.flowType !== 'RecordTriggered') return [];
  const timing = flow.trigger.timing;
  const hasOnlySelfMutation =
    flow.nodes.some((n) => n.type === 'UpdateRecords') &&
    !flow.nodes.some(
      (n) =>
        n.type === 'CreateRecords' ||
        n.type === 'DeleteRecords' ||
        n.type === 'Action' ||
        n.type === 'Subflow',
    );

  if (timing === 'AfterSave' && hasOnlySelfMutation) {
    return [
      finding({
        ruleId: 'TRIGGER_TIMING_MISMATCH',
        scoreFamily: 'trigger_timing_mismatch',
        title: 'After-save flow may be better as before-save',
        severity: 'medium',
        category: 'performance',
        message:
          'This flow appears to be after-save but may only be updating the triggering record.',
        recommendation:
          'Consider whether this flow could be converted to before-save for better efficiency.',
      }),
    ];
  }
  return [];
}

function checkOutdatedApiVersion(
  flow: NormalizedFlow,
  config: RulesConfig,
  finding: ReturnType<typeof makeFindingFactory>,
): Finding[] {
  const threshold = Number(config.outdatedApiVersionThreshold ?? 6);
  const currentTarget = Number(config.currentApiVersion ?? 65);
  if (!flow.meta.apiVersion) return [];
  const gap = currentTarget - Number(flow.meta.apiVersion);
  if (gap < threshold) return [];
  return [
    finding({
      ruleId: 'OUTDATED_API_VERSION',
      scoreFamily: 'outdated_api_version',
      title: 'Outdated API version',
      severity: 'medium',
      category: 'portability',
      message: `This flow uses API version ${flow.meta.apiVersion}, which is ${gap} versions behind the configured target of ${currentTarget}.`,
      recommendation: 'Review and upgrade the flow API version where appropriate.',
    }),
  ];
}

// Hard-coded ID and URL detection. Walks the metadata blobs hanging off each
// node / resource and inspects only certain "literal" keys to avoid false
// positives from internal references.

const INSPECTABLE_LITERAL_KEYS = new Set(['stringValue', 'formulaExpression', 'expression', 'text', 'fieldText']);

const ID_REGEX = /\b([a-zA-Z0-9]{15}|[a-zA-Z0-9]{18})\b/g;
const URL_REGEX = /(https?:\/\/[^\s"']+)/gi;

const BLOCKED_ID_LITERALS = new Set([
  '$User.Id',
  'UseStoredValues',
  'ContentDocument',
  'ContentDocumentLink',
  'CustomNotificationType',
  'DisplayText',
  'InputField',
  'ComponentInstance',
  'MULTI_SELECT',
]);

function looksLikeSalesforceId(value: string): boolean {
  const trimmed = value.trim();
  if (!/^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(trimmed)) return false;
  if (!/\d/.test(trimmed)) return false;
  if (!/[A-Z]/.test(trimmed)) return false;
  if (/^[A-Za-z]+$/.test(trimmed)) return false;
  if (BLOCKED_ID_LITERALS.has(trimmed)) return false;
  return true;
}

function walkLiteralStrings(obj: unknown, callback: (s: string) => void): void {
  if (obj == null) return;
  if (typeof obj === 'string') {
    callback(obj);
    return;
  }
  if (Array.isArray(obj)) {
    obj.forEach((item) => walkLiteralStrings(item, callback));
    return;
  }
  if (typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (INSPECTABLE_LITERAL_KEYS.has(key) && typeof value === 'string') {
        callback(value);
        continue;
      }
      walkLiteralStrings(value, callback);
    }
  }
}

function checkHardCodedIds(flow: NormalizedFlow, finding: ReturnType<typeof makeFindingFactory>): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();

  function inspect(label: string, apiName: string | null, value: string, kind: 'element' | 'resource'): void {
    const matches = value.match(ID_REGEX);
    if (!matches) return;
    for (const match of matches) {
      const normalised = match.trim();
      if (!looksLikeSalesforceId(normalised)) continue;
      const key = `${kind}::${apiName ?? label}::${normalised}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push(
        finding({
          ruleId: 'HARD_CODED_ID',
          scoreFamily: 'hard_coded_ids',
          title: 'Possible hard-coded Salesforce ID',
          severity: 'high',
          category: 'portability',
          confidence: 'medium',
          message: `The ${kind} "${label}" appears to contain a hard-coded Salesforce ID.`,
          recommendation:
            'Replace the hard-coded ID with configuration, metadata, or a lookup pattern that will work across environments.',
          location:
            kind === 'resource'
              ? { resourceName: label }
              : { elementLabel: label, elementApiName: apiName },
          metadata: { matchedValue: normalised },
        }),
      );
    }
  }

  flow.nodes.forEach((node) =>
    walkLiteralStrings(node.metadata, (value) => inspect(node.label, node.apiName, value, 'element')),
  );
  flow.resources.forEach((resource) =>
    walkLiteralStrings(resource.metadata, (value) => inspect(resource.name, null, value, 'resource')),
  );
  return findings;
}

function checkHardCodedUrls(flow: NormalizedFlow, finding: ReturnType<typeof makeFindingFactory>): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();

  function inspect(label: string, apiName: string | null, value: string, kind: 'element' | 'resource'): void {
    const matches = value.match(URL_REGEX);
    if (!matches) return;
    for (const match of matches) {
      const key = `${kind}::${apiName ?? label}::${match}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push(
        finding({
          ruleId: 'HARD_CODED_URL',
          scoreFamily: 'hard_coded_urls',
          title: 'Possible hard-coded URL',
          severity: 'medium',
          category: 'portability',
          confidence: 'medium',
          message: `The ${kind} "${label}" appears to contain a hard-coded URL.`,
          recommendation:
            'Replace hard-coded URLs with environment-aware configuration where possible.',
          location:
            kind === 'resource'
              ? { resourceName: label }
              : { elementLabel: label, elementApiName: apiName },
          metadata: { matchedValue: match },
        }),
      );
    }
  }

  flow.nodes.forEach((node) =>
    walkLiteralStrings(node.metadata, (value) => inspect(node.label, node.apiName, value, 'element')),
  );
  flow.resources.forEach((resource) =>
    walkLiteralStrings(resource.metadata, (value) => inspect(resource.name, null, value, 'resource')),
  );
  return findings;
}

function checkDependencyInventory(
  flow: NormalizedFlow,
  finding: ReturnType<typeof makeFindingFactory>,
): Finding[] {
  return flow.dependencies.map((dependency: Dependency) => {
    let family = 'custom_apex_dependencies';
    if (dependency.type === 'LwcComponent') family = 'custom_lwc_dependencies';
    if (dependency.type === 'Subflow') family = 'subflow_dependencies';
    if (dependency.type === 'ApexDefinedType') family = 'apex_defined_dependencies';
    return finding({
      ruleId: 'DEPENDENCY_INVENTORY',
      scoreFamily: family,
      title: 'Custom dependency inventory',
      severity: 'info',
      category: 'portability',
      message: `This flow depends on ${dependency.type} "${dependency.name}".`,
      recommendation:
        'Confirm this dependency exists and is compatible in the target org before deployment.',
      metadata: {
        dependencyType: dependency.type,
        dependencyName: dependency.name,
        count: dependency.count,
      },
    });
  });
}

// ---------------------------------------------------------------------------
// Public entrypoint.

export function evaluate(flow: NormalizedFlow, config: RulesConfig = {}): Finding[] {
  const finding = makeFindingFactory();
  return [
    ...checkFlowDescription(flow, finding),
    ...checkElementDescriptions(flow, finding),
    ...checkResourceDescriptions(flow, finding),
    ...checkGenericElementNaming(flow, finding),
    ...checkNamingConventions(flow, config, finding),
    ...checkFaultPaths(flow, finding),
    ...checkDmlInsideLoops(flow, finding),
    ...checkQueriesInsideLoops(flow, finding),
    ...checkNestedLoops(flow, finding),
    ...checkHighDataOperationCount(flow, config, finding),
    ...checkBroadEntryCriteria(flow, finding),
    ...checkTriggerTiming(flow, finding),
    ...checkOutdatedApiVersion(flow, config, finding),
    ...checkHardCodedIds(flow, finding),
    ...checkHardCodedUrls(flow, finding),
    ...checkDependencyInventory(flow, finding),
  ];
}
