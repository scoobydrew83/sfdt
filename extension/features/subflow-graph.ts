// Subflow call graph. The SVG layout/render moved to ui/node-graph.ts when the
// Schema Browser needed the same picture for object relationships — this file
// keeps the Flow-specific parts: fetching the metadata, building the graph, and
// the modal around it.
//
// Still hand-rolled SVG, no external graph library, to keep the bundle lean and
// the security surface tiny.

import {
  buildSubflowGraph,
  getCallChains,
  type SubflowGraph,
} from '@sfdt/flow-core';
import type { Feature } from '../lib/feature-registry.js';
import { CONTEXTS } from '../lib/context-detector.js';
import { escapeSoql } from '../lib/escape.js';
import { getSalesforceApi, type SalesforceApiClient } from '../lib/salesforce-api.js';
import { showToast } from '../ui/toast.js';
import { presentView, type ViewHandle } from '../ui/present-view.js';
import { buildNodeGraphSvg } from '../ui/node-graph.js';
import { setTone } from '../lib/ui-controls.js';
import { busyOverlay } from '../ui/panels.js';


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
            `SELECT MasterLabel, Metadata FROM Flow WHERE Id = '${escapeSoql(def.ActiveVersionId)}'`,
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

/**
 * The Flow view of the shared renderer. The graph structure itself is generic —
 * see the header of ui/node-graph.ts for why no adapter is needed — so this is
 * only the Flow vocabulary for the hover tooltip.
 *
 * Still exported: the modal embeds it under the Graph tab, and the existing
 * tests drive it directly.
 */
export function buildSubflowGraphSvg(doc: Document, graph: SubflowGraph): SVGSVGElement {
  return buildNodeGraphSvg(doc, graph, {
    nodeTitle: (node, depth) =>
      `${node.label}\nDepth ${depth} · calls ${node.outgoing.length} · called by ${node.incoming.length}`,
  });
}

export function buildSubflowGraphModal(doc: Document, graph: SubflowGraph): ViewHandle {
  const titleText = `Subflow Caller Graph — ${graph.nodes.size} flow${graph.nodes.size === 1 ? '' : 's'} · ${graph.cycles.length} cycle${graph.cycles.length === 1 ? '' : 's'}`;

  const body = doc.createElement('div');
  body.style.cssText = 'padding: 16px; overflow: auto; flex: 1;';

  // The Graph/List toggle used to live in the modal header; presentView's
  // header is title + × only, so it sits at the top of the body now.
  const toggle = doc.createElement('div');
  toggle.className = 'sfdt-segment';
  const graphBtn = doc.createElement('button');
  graphBtn.type = 'button';
  const listBtn = doc.createElement('button');
  listBtn.type = 'button';
  graphBtn.textContent = 'Graph';
  listBtn.textContent = 'List';
  toggle.appendChild(graphBtn);
  toggle.appendChild(listBtn);
  body.appendChild(toggle);

  // Cycles sit above whichever view is active — recursion is the most
  // actionable finding the modal surfaces.
  if (graph.cycles.length > 0) {
    const cycleBox = doc.createElement('div');
    cycleBox.style.cssText =
      'border: 1px solid var(--sfdt-color-error); border-radius: 4px; padding: 10px; margin-bottom: 12px; background: var(--sfdt-color-error-bg);';
    const cycleTitle = doc.createElement('div');
    cycleTitle.classList.add('sfdt-subhead');
    cycleTitle.textContent = `${graph.cycles.length} cycle${graph.cycles.length === 1 ? '' : 's'} detected`;
    cycleBox.appendChild(cycleTitle);
    for (const cycle of graph.cycles) {
      const line = doc.createElement('div');
      line.style.cssText = 'font-family: monospace; font-size: 13px;';
      const first = cycle.members[0] ?? '';
      line.textContent = cycle.members.join(' → ') + ' → ' + first;
      cycleBox.appendChild(line);
    }
    body.appendChild(cycleBox);
  }

  const graphPane = doc.createElement('div');
  graphPane.classList.add('sfdt-frame');
  graphPane.appendChild(buildSubflowGraphSvg(doc, graph));

  const listPane = doc.createElement('div');
  listPane.style.display = 'none';
  const flows = Array.from(graph.nodes.values()).sort((a, b) => {
    const depthA = graph.maxDepth.get(a.id) ?? 0;
    const depthB = graph.maxDepth.get(b.id) ?? 0;
    if (depthA !== depthB) return depthB - depthA;
    return a.label.localeCompare(b.label);
  });
  for (const node of flows) {
    const row = doc.createElement('div');
    row.classList.add('sfdt-panel', 'sfdt-below');
    const title = doc.createElement('div');
    title.classList.add('sfdt-subhead');
    title.textContent = node.label;
    const meta = doc.createElement('div');
    meta.classList.add('sfdt-faint');
    const depth = graph.maxDepth.get(node.id) ?? 0;
    meta.textContent = `depth ${depth} · calls ${node.outgoing.length} · called by ${node.incoming.length}`;
    row.appendChild(title);
    row.appendChild(meta);

    if (node.outgoing.length > 0) {
      const chains = getCallChains(graph, node.id, 6);
      if (chains.length > 0) {
        const chainBox = doc.createElement('div');
        chainBox.style.cssText =
          'margin-top: 6px; font-family: monospace; font-size: 12px; color: var(--sfdt-color-text-weak);';
        for (const chain of chains.slice(0, 5)) {
          const line = doc.createElement('div');
          line.textContent = chain.join(' → ');
          chainBox.appendChild(line);
        }
        if (chains.length > 5) {
          const more = doc.createElement('div');
          setTone(more, 'muted');
          more.textContent = `…and ${chains.length - 5} more chain${chains.length - 5 === 1 ? '' : 's'}`;
          chainBox.appendChild(more);
        }
        row.appendChild(chainBox);
      }
    }
    listPane.appendChild(row);
  }

  body.appendChild(graphPane);
  body.appendChild(listPane);

  if (graph.unresolvedReferences.length > 0) {
    const unresolvedBox = doc.createElement('div');
    unresolvedBox.style.cssText =
      'border: 1px solid var(--sfdt-color-warning); border-radius: 4px; padding: 10px; margin-top: 12px; background: var(--sfdt-color-warning-bg-3);';
    const title = doc.createElement('div');
    title.classList.add('sfdt-subhead');
    title.textContent = `${graph.unresolvedReferences.length} reference${graph.unresolvedReferences.length === 1 ? '' : 's'} to flows we couldn't load`;
    unresolvedBox.appendChild(title);
    const list = doc.createElement('div');
    list.classList.add('sfdt-muted');
    list.textContent = graph.unresolvedReferences.join(', ');
    unresolvedBox.appendChild(list);
    body.appendChild(unresolvedBox);
  }

  // '.sfdt-segment' paints the pressed row off aria-pressed, so the state is
  // declared once and is simultaneously the accessible state — the four colour
  // writes per branch this replaces were neither.
  const setView = (mode: 'graph' | 'list') => {
    const onGraph = mode === 'graph';
    graphPane.style.display = onGraph ? '' : 'none';
    listPane.style.display = onGraph ? 'none' : '';
    graphBtn.setAttribute('aria-pressed', String(onGraph));
    listBtn.setAttribute('aria-pressed', String(!onGraph));
  };
  graphBtn.addEventListener('click', () => setView('graph'));
  listBtn.addEventListener('click', () => setView('list'));
  setView('graph');

  return presentView({ title: titleText, body, doc, width: '880px' });
}

export interface SubflowGraphFeatureOptions {
  doc?: Document;
  api?: SalesforceApiClient;
}

export function createSubflowGraphFeature(options: SubflowGraphFeatureOptions = {}): Feature {
  const doc = options.doc ?? document;
  const api = options.api ?? getSalesforceApi();

  return {
    manifest: {
      id: 'subflow-graph',
      name: 'Subflow Caller Graph',
      contexts: [CONTEXTS.SETUP_FLOWS, CONTEXTS.SETUP_OTHER],
    },

    async onActivate() {
      const loading = busyOverlay('Building subflow graph…', doc);
      try {
        const flows = await fetchAllFlowMetadata(api);
        const graph = buildSubflowGraph(flows);
        loading.close();
        buildSubflowGraphModal(doc, graph);
      } catch (err) {
        loading.close();
        showToast(
          `Subflow graph failed: ${err instanceof Error ? err.message : String(err)}`,
          { kind: 'error', doc },
        );
      }
    },
  };
}

export function _subflowGraphTestApi() {
  return { fetchAllFlowMetadata, buildSubflowGraphModal, buildSubflowGraphSvg };
}
