import {
  buildIssueFamilies,
  calculateScore,
  evaluate,
  normalize,
  type IssueFamily,
  type NormalizedFlow,
} from '@sfdt/flow-core';
import { detectContext, CONTEXTS } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import { getSalesforceApi, type SalesforceApiClient } from '../lib/salesforce-api.js';
import { mountHealthModal, type HealthModalHandle, type HealthReport } from '../ui/health-modal.js';
import { showToast } from '../ui/toast.js';
const DEFAULT_RULES_CONFIG = {
  outdatedApiVersionThreshold: 6,
  currentApiVersion: 65,
  highDataOperationThreshold: 8,
  namingConventions: {
    variable: /^var[A-Z].*/,
    formula: /^frm[A-Z].*/,
    constant: /^con[A-Z].*/,
  },
};
const DATA_OPERATION_TYPES = new Set([
  'GetRecords',
  'CreateRecords',
  'UpdateRecords',
  'DeleteRecords',
  'Action',
  'Subflow',
] as const);
interface FetchedFlow {
  Id?: string;
  MasterLabel?: string;
  Metadata?: Record<string, unknown>;
  ProcessType?: string;
  Status?: string;
  Definition?: { DeveloperName?: string };
  [key: string]: unknown;
}
function resolveFlowApiName(record: FetchedFlow, metadata: Record<string, unknown>): string {
  const candidates = [
    (record as { DeveloperName?: string }).DeveloperName,
    (record as { FullName?: string }).FullName,
    (record as { ApiName?: string }).ApiName,
    record.Definition?.DeveloperName,
    (metadata as { fullName?: string }).fullName,
    (metadata as { apiName?: string }).apiName,
  ];
  const label = (metadata as { label?: string }).label;
  const valid = candidates.find(
    (v): v is string => typeof v === 'string' && v.trim().length > 0 && v.trim() !== label,
  );
  return valid ?? label ?? 'unknown_flow';
}
function buildReport(
  record: FetchedFlow,
  normalized: NormalizedFlow,
  issueFamilies: IssueFamily[],
): HealthReport {
  const score = calculateScore(issueFamilies);
  const nodes = normalized.nodes;
  const countOf = (type: string) => nodes.filter((n) => n.type === type).length;
  return {
    meta: {
      flowLabel: normalized.meta.flowLabel,
      flowType: normalized.meta.flowType,
      apiVersion: normalized.meta.apiVersion ?? null,
      status: normalized.meta.status,
    },
    summary: {
      overallScore: score.overallScore,
      rating: score.rating,
      severityCounts: score.severityCounts,
      categoryCounts: score.categoryCounts,
      metrics: {
        elementCount: nodes.filter((n) => n.type !== 'Start').length,
        decisionCount: countOf('Decision'),
        loopCount: countOf('Loop'),
        dataOperationCount: nodes.filter((n) =>
          DATA_OPERATION_TYPES.has(n.type as never),
        ).length,
        dependencyCount: normalized.dependencies.length,
      },
    },
    issueFamilies,
    rawJson: JSON.stringify(
      {
        meta: { ...normalized.meta, recordId: record.Id ?? null },
        summary: score,
        issueFamilies,
        dependencies: normalized.dependencies,
      },
      null,
      2,
    ),
  };
}
export interface FlowHealthCheckOptions {
  doc?: Document;
  win?: Window;
  api?: SalesforceApiClient;
  modal?: HealthModalHandle;
}
export function createFlowHealthCheckFeature(options: FlowHealthCheckOptions = {}): Feature {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  const api = options.api ?? getSalesforceApi();
  let modal: HealthModalHandle | null = options.modal ?? null;
  function getModal(): HealthModalHandle {
    if (!modal) {
      modal = mountHealthModal({
        doc,
        onCopyJson: async (json) => {
          try {
            await navigator.clipboard.writeText(json);
            showToast('JSON copied to clipboard ✓', { kind: 'success', doc });
          } catch {
            showToast('Could not copy to clipboard', { kind: 'error', doc });
          }
        },
      });
    }
    return modal;
  }
  return {
    manifest: {
      id: 'flow-health-check',
      name: 'Run Health Check',
      contexts: [CONTEXTS.FLOW_BUILDER],
      permissions: ['clipboardWrite'],
    },
    async onActivate() {
      if (detectContext({ location: { href: win.location.href } }, doc) !== CONTEXTS.FLOW_BUILDER) {
        getModal().showError('Open the Flow Builder canvas before running a health check.');
        return;
      }
      const flowId = new URL(win.location.href).searchParams.get('flowId');
      if (!flowId) {
        getModal().showError('Could not determine the current Flow ID from the URL.');
        return;
      }
      getModal().showLoading('Current Flow');
      try {
        const record = (await api.getFlowMetadata(flowId)) as FetchedFlow;
        const metadata = record?.Metadata;
        if (!metadata) {
          getModal().showError('Could not retrieve Flow metadata.');
          return;
        }
        const resolvedApiName = resolveFlowApiName(record, metadata);
        const normalized = normalize(metadata as Parameters<typeof normalize>[0], {
          flowVersionId: record?.Id ?? flowId,
          flowApiName: resolvedApiName,
        });
        const findings = evaluate(normalized, DEFAULT_RULES_CONFIG);
        const issueFamilies = buildIssueFamilies(findings);
        const report = buildReport(record, normalized, issueFamilies);
        getModal().showReport(report);
      } catch (err) {
        console.error('[SFUT flow-health-check] failed:', err);
        getModal().showError(err instanceof Error ? err.message : 'Unexpected error');
      }
    },
  };
}
export function _flowHealthCheckTestApi() {
  return { buildReport, resolveFlowApiName };
}
