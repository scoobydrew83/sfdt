// Subflow Caller Graph — Phase 6a feature.
//
// Renders the flow-core subflow graph as a list view in a modal. Each Flow
// is shown with its incoming and outgoing edges plus its max call depth.
// Cycles are highlighted at the top. A full visual graph (using something
// like react-flow or cytoscape.js) is a follow-up; the list view is the
// minimum-viable surface that already makes recursion + missing references
// inspectable.

import {
  buildSubflowGraph,
  getCallChains,
  type SubflowGraph,
} from '@sfdt/flow-core';
import type { Feature } from '../lib/feature-registry.js';
import { getSalesforceApi, type SalesforceApiClient } from '../lib/salesforce-api.js';
import { showToast } from '../ui/toast.js';

async function fetchAllFlowMetadata(
  api: SalesforceApiClient,
): Promise<Array<{ id: string; label: string; metadata: Record<string, unknown> }>> {
  const defs = await api.toolingQuery<{
    Id: string;
    DeveloperName: string;
    ActiveVersionId: string | null;
  }>(
    'SELECT Id, DeveloperName, ActiveVersionId FROM FlowDefinition ' +
      'WHERE ActiveVersionId != null ORDER BY DeveloperName ASC',
  );
  const out: Array<{ id: string; label: string; metadata: Record<string, unknown> }> = [];
  const queue = [...defs.records];
  await Promise.all(
    Array.from({ length: Math.min(5, queue.length) }, async () => {
      while (queue.length > 0) {
        const def = queue.shift();
        if (!def?.ActiveVersionId) continue;
        try {
          const result = await api.toolingQuery<{
            MasterLabel?: string;
            Metadata?: Record<string, unknown>;
          }>(
            `SELECT MasterLabel, Metadata FROM Flow WHERE Id = '${def.ActiveVersionId.replace(/'/g, "\\'")}'`,
          );
          const record = result.records[0];
          if (record?.Metadata) {
            out.push({
              id: def.DeveloperName,
              label: record.MasterLabel ?? def.DeveloperName,
              metadata: record.Metadata,
            });
          }
        } catch {
          // Skip — surfaces as a missing node downstream.
        }
      }
    }),
  );
  return out;
}

export function buildSubflowGraphModal(doc: Document, graph: SubflowGraph): HTMLDivElement {
  const overlay = doc.createElement('div');
  overlay.style.cssText =
    'position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 100020; display: flex; align-items: center; justify-content: center; font-family: system-ui, sans-serif;';

  const modal = doc.createElement('div');
  modal.style.cssText =
    'background: #fff; border-radius: 4px; width: 760px; max-width: 90vw; max-height: 90vh; display: flex; flex-direction: column;';

  const header = doc.createElement('div');
  header.style.cssText =
    'padding: 12px 16px; border-bottom: 1px solid #d8dde6; display: flex; justify-content: space-between; align-items: center; font-weight: 600;';
  const headerLabel = doc.createElement('span');
  headerLabel.textContent = `Subflow Caller Graph — ${graph.nodes.size} flow${graph.nodes.size === 1 ? '' : 's'} · ${graph.cycles.length} cycle${graph.cycles.length === 1 ? '' : 's'}`;
  const closeBtn = doc.createElement('button');
  closeBtn.textContent = '×';
  closeBtn.style.cssText = 'background: none; border: 0; font-size: 22px; cursor: pointer;';
  closeBtn.addEventListener('click', () => overlay.remove());
  header.appendChild(headerLabel);
  header.appendChild(closeBtn);
  modal.appendChild(header);

  const body = doc.createElement('div');
  body.style.cssText = 'padding: 16px; overflow-y: auto; flex: 1;';

  // Cycles section — front-and-centre because they are the most actionable.
  if (graph.cycles.length > 0) {
    const cycleBox = doc.createElement('div');
    cycleBox.style.cssText =
      'border: 1px solid #c23934; border-radius: 4px; padding: 10px; margin-bottom: 12px; background: #fef2f1;';
    const cycleTitle = doc.createElement('div');
    cycleTitle.style.cssText = 'font-weight: 600; color: #c23934; margin-bottom: 4px;';
    cycleTitle.textContent = `${graph.cycles.length} cycle${graph.cycles.length === 1 ? '' : 's'} detected`;
    cycleBox.appendChild(cycleTitle);
    for (const cycle of graph.cycles) {
      const line = doc.createElement('div');
      line.style.cssText = 'font-family: monospace; font-size: 13px;';
      line.textContent = cycle.members.join(' → ') + ' → ' + cycle.members[0];
      cycleBox.appendChild(line);
    }
    body.appendChild(cycleBox);
  }

  // Per-flow rows.
  const flows = Array.from(graph.nodes.values()).sort((a, b) => {
    const depthA = graph.maxDepth.get(a.id) ?? 0;
    const depthB = graph.maxDepth.get(b.id) ?? 0;
    if (depthA !== depthB) return depthB - depthA;
    return a.label.localeCompare(b.label);
  });
  for (const node of flows) {
    const row = doc.createElement('div');
    row.style.cssText =
      'border: 1px solid #d8dde6; border-radius: 4px; padding: 10px; margin-bottom: 6px;';
    const title = doc.createElement('div');
    title.style.cssText = 'font-weight: 600;';
    title.textContent = node.label;
    const meta = doc.createElement('div');
    meta.style.cssText = 'color: #80868d; font-size: 12px; margin-top: 2px;';
    const depth = graph.maxDepth.get(node.id) ?? 0;
    meta.textContent = `depth ${depth} · calls ${node.outgoing.length} · called by ${node.incoming.length}`;
    row.appendChild(title);
    row.appendChild(meta);

    if (node.outgoing.length > 0) {
      const chains = getCallChains(graph, node.id, 6);
      if (chains.length > 0) {
        const chainBox = doc.createElement('div');
        chainBox.style.cssText =
          'margin-top: 6px; font-family: monospace; font-size: 12px; color: #54698d;';
        for (const chain of chains.slice(0, 5)) {
          const line = doc.createElement('div');
          line.textContent = chain.join(' → ');
          chainBox.appendChild(line);
        }
        if (chains.length > 5) {
          const more = doc.createElement('div');
          more.style.color = '#80868d';
          more.textContent = `…and ${chains.length - 5} more chain${chains.length - 5 === 1 ? '' : 's'}`;
          chainBox.appendChild(more);
        }
        row.appendChild(chainBox);
      }
    }
    body.appendChild(row);
  }

  if (graph.unresolvedReferences.length > 0) {
    const unresolvedBox = doc.createElement('div');
    unresolvedBox.style.cssText =
      'border: 1px solid #fe9339; border-radius: 4px; padding: 10px; margin-top: 12px; background: #fff7eb;';
    const title = doc.createElement('div');
    title.style.cssText = 'font-weight: 600; color: #b46600;';
    title.textContent = `${graph.unresolvedReferences.length} reference${graph.unresolvedReferences.length === 1 ? '' : 's'} to flows we couldn't load`;
    unresolvedBox.appendChild(title);
    const list = doc.createElement('div');
    list.style.cssText = 'font-size: 12px; color: #b46600;';
    list.textContent = graph.unresolvedReferences.join(', ');
    unresolvedBox.appendChild(list);
    body.appendChild(unresolvedBox);
  }

  modal.appendChild(body);
  overlay.appendChild(modal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  return overlay;
}

export interface SubflowGraphFeatureOptions {
  doc?: Document;
  api?: SalesforceApiClient;
}

export function createSubflowGraphFeature(options: SubflowGraphFeatureOptions = {}): Feature {
  const doc = options.doc ?? document;
  const api = options.api ?? getSalesforceApi();

  return {
    id: 'subflow-graph',

    async onActivate() {
      const loading = doc.createElement('div');
      loading.style.cssText =
        'position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 100020; display: flex; align-items: center; justify-content: center; color: #fff; font-family: system-ui, sans-serif;';
      loading.textContent = 'Building subflow graph…';
      doc.body.appendChild(loading);
      try {
        const flows = await fetchAllFlowMetadata(api);
        const graph = buildSubflowGraph(flows);
        loading.remove();
        doc.body.appendChild(buildSubflowGraphModal(doc, graph));
      } catch (err) {
        loading.remove();
        showToast(
          `Subflow graph failed: ${err instanceof Error ? err.message : String(err)}`,
          { kind: 'error', doc },
        );
      }
    },
  };
}

export function _subflowGraphTestApi() {
  return { fetchAllFlowMetadata, buildSubflowGraphModal };
}
