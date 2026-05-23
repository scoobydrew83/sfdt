import { detectContext, CONTEXTS } from '../lib/context-detector.js';
import { escapeSoql } from '../lib/escape.js';
import type { Feature } from '../lib/feature-registry.js';
import { getSalesforceApi, type SalesforceApiClient } from '../lib/salesforce-api.js';

interface FlowDefinitionBatchRecord {
  Id: string;
  DeveloperName: string;
  ActiveVersionId: string | null;
  MasterLabel?: string;
}

// chunk size of 50 stays well under Salesforce's 200-id IN-clause limit and
// avoids sub-query truncation on Tooling API.
export async function batchFetchFlowDefinitions(
  api: SalesforceApiClient,
  ids: readonly string[],
  chunk = 50,
): Promise<FlowDefinitionBatchRecord[]> {
  const out: FlowDefinitionBatchRecord[] = [];
  for (let i = 0; i < ids.length; i += chunk) {
    const slice = ids.slice(i, i + chunk);
    const escaped = slice.map((id) => `'${escapeSoql(id)}'`).join(',');
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
  // Touch the api so tree-shaking doesn't drop it before the DOM enhancement
  // lands and starts using it.
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
      // No-op until the DOM enhancement lands.
    },
  };
}

export function _flowTriggerExplorerEnhancerTestApi() {
  return { batchFetchFlowDefinitions };
}
