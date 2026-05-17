// Flow Trigger Explorer Enhancer — port of the v2.0.2 feature that augments
// the standard Flow Trigger Explorer page. The v2.0.2 source flagged itself
// as beta because it pulled Flow definitions one at a time. This port honours
// the CHANGELOG-v2.0.0.md:147-148 commitment to promote it out of beta by
// using a Tooling API batch fetch.
//
// Scope for Phase 4: ship the underlying batch-fetch helper plus a feature
// stub that registers on the Flow Trigger Explorer context. The DOM-level
// enhancement (badges, sorting) is left as a follow-up because v2.0.2's
// 822 LOC is mostly selector-fragile Lightning-internal HTML manipulation
// that needs to be re-verified against current Salesforce.

import { detectContext, CONTEXTS } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import { getSalesforceApi, type SalesforceApiClient } from '../lib/salesforce-api.js';

interface FlowDefinitionBatchRecord {
  Id: string;
  DeveloperName: string;
  ActiveVersionId: string | null;
  MasterLabel?: string;
}

/**
 * Fetch metadata for many FlowDefinition ids in a single Tooling API query.
 * This is the speedup that lets the enhancer move out of beta — v2.0.2 ran
 * one query per row.
 *
 * @param api    Salesforce API client
 * @param ids    FlowDefinition ids to fetch
 * @param chunk  Max ids per SOQL IN clause (Salesforce limit is 200; we
 *               default to 50 to stay safely under any sub-query truncation)
 */
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
  // api is constructed at activation time when full DOM enhancement lands;
  // referenced here so the import isn't elided by tree-shaking and so the
  // option remains part of the public surface.
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
      // DOM enhancement lands in a follow-up. The batch fetch above is the
      // out-of-beta promotion called out by CHANGELOG-v2.0.0.md.
    },

    async onActivate() {
      // No-op for now; the side-menu still surfaces the entry on the
      // Trigger Explorer context for the future enhancement.
    },
  };
}

export function _flowTriggerExplorerEnhancerTestApi() {
  return { batchFetchFlowDefinitions };
}
