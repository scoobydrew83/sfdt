import { detectContext, CONTEXTS } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import { getSalesforceApi, type SalesforceApiClient } from '../lib/salesforce-api.js';
interface FlowDefinitionBatchRecord {
  Id: string;
  DeveloperName: string;
  ActiveVersionId: string | null;
  MasterLabel?: string;
}
export async function batchFetchFlowDefinitions(
  api: SalesforceApiClient,
  ids: readonly string[],
  chunk = 50,
): Promise<FlowDefinitionBatchRecord[]> {
  const out: FlowDefinitionBatchRecord[] = [];
  for (let i = 0; i < ids.length; i += chunk) {
    const slice = ids.slice(i, i + chunk);
    const escaped = slice.map((id) => `'${id.replace(/'/g, "\\'")}'`).join(',');
    const soql =
      'SELECT Id, DeveloperName, ActiveVersionId, MasterLabel ' +
      `FROM FlowDefinition WHERE Id IN (${escaped})`;
    const result = await api.toolingQuery<FlowDefinitionBatchRecord>(soql);
    out.push(...result.records);
  }
  return out;
}
export interface FlowTriggerExplorerEnhancerOptions {
  doc?: Document;
  win?: Window;
  api?: SalesforceApiClient;
}
export function createFlowTriggerExplorerEnhancerFeature(
  options: FlowTriggerExplorerEnhancerOptions = {},
): Feature {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  const _api = options.api ?? getSalesforceApi();
  void _api;
  return {
    manifest: {
      id: 'flow-trigger-explorer-enhancer',
      name: 'Flow Trigger Explorer Enhancer',
      contexts: [CONTEXTS.FLOW_TRIGGER_EXPLORER],
    },
    async init() {
      if (
        detectContext({ location: { href: win.location.href } }, doc) !==
        CONTEXTS.FLOW_TRIGGER_EXPLORER
      ) {
        return;
      }
    },
    async onActivate() {
    },
  };
}
export function _flowTriggerExplorerEnhancerTestApi() {
  return { batchFetchFlowDefinitions };
}
