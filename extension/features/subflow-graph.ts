// Hand-rolled SVG — no external graph library, to keep the bundle lean
// and the security surface tiny.

import {
  buildSubflowGraph,
  getCallChains,
  type SubflowGraph,
  type SubflowGraphNode,
} from '@sfdt/flow-core';
import type { Feature } from '../lib/feature-registry.js';
import { CONTEXTS } from '../lib/context-detector.js';
import { escapeSoql } from '../lib/escape.js';
import { getSalesforceApi, type SalesforceApiClient } from '../lib/salesforce-api.js';
import { showToast } from '../ui/toast.js';
import { presentView, type ViewHandle } from '../ui/present-view.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

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

interface LaidOutNode {
  node: SubflowGraphNode;
  depth: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

const NODE_WIDTH = 160;
const NODE_HEIGHT = 32;
const COLUMN_GAP = 80;
const ROW_GAP = 16;
const MARGIN = 24;
const MAX_LABEL_CHARS = 22;

// Within-column ordering is alphabetical for run-to-run stability.
// No barycentric edge-crossing minimisation — typical orgs have <50 flows
// so the complexity isn't worth it.
function layoutGraph(graph: SubflowGraph): { nodes: LaidOutNode[]; width: number; height: number } {
  const columns = new Map<number, SubflowGraphNode[]>();
  for (const node of graph.nodes.values()) {
    const depth = graph.maxDepth.get(node.id) ?? 0;
    if (!columns.has(depth)) columns.set(depth, []);
    columns.get(depth)!.push(node);
  }
  for (const list of columns.values()) {
    list.sort((a, b) => a.label.localeCompare(b.label));
  }

  const sortedDepths = Array.from(columns.keys()).sort((a, b) => a - b);
  const out: LaidOutNode[] = [];
  let maxColumnHeight = 0;
  for (let i = 0; i < sortedDepths.length; i++) {
    const depth = sortedDepths[i]!;
    const nodes = columns.get(depth)!;
    const x = MARGIN + i * (NODE_WIDTH + COLUMN_GAP);
    for (let j = 0; j < nodes.length; j++) {
      const y = MARGIN + j * (NODE_HEIGHT + ROW_GAP);
      out.push({ node: nodes[j]!, depth, x, y, width: NODE_WIDTH, height: NODE_HEIGHT });
    }
    const colHeight = nodes.length * (NODE_HEIGHT + ROW_GAP);
    if (colHeight > maxColumnHeight) maxColumnHeight = colHeight;
  }
  const width = sortedDepths.length * (NODE_WIDTH + COLUMN_GAP) + MARGIN;
  const height = Math.max(maxColumnHeight + MARGIN * 2, NODE_HEIGHT + MARGIN * 2);
  return { nodes: out, width, height };
}

// Exported for testing — the modal also embeds it under the Graph tab.
export function buildSubflowGraphSvg(doc: Document, graph: SubflowGraph): SVGSVGElement {
  const { nodes: laid, width, height } = layoutGraph(graph);
  const byId = new Map<string, LaidOutNode>(laid.map((n) => [n.node.id, n]));

  // An edge (a→b) is in a cycle when a and b are adjacent (with wrap-around)
  // in the cycle's members list.
  const cycleEdges = new Set<string>();
  for (const cycle of graph.cycles) {
    const m = cycle.members;
    if (m.length === 1) {
      cycleEdges.add(`${m[0]}->${m[0]}`);
      continue;
    }
    for (let i = 0; i < m.length; i++) {
      const a = m[i]!;
      const b = m[(i + 1) % m.length]!;
      cycleEdges.add(`${a}->${b}`);
    }
  }
  const cycleNodes = new Set<string>();
  for (const cycle of graph.cycles) {
    for (const m of cycle.members) cycleNodes.add(m);
  }

  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('xmlns', SVG_NS);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.style.cssText =
    'display: block; font-family: system-ui, sans-serif; background: #fff;';

  const defs = doc.createElementNS(SVG_NS, 'defs');
  for (const [id, fill] of [
    ['sfdt-arrow', '#54698d'],
    ['sfdt-arrow-cycle', '#c23934'],
    ['sfdt-arrow-missing', '#b46600'],
  ] as const) {
    const marker = doc.createElementNS(SVG_NS, 'marker');
    marker.setAttribute('id', id);
    marker.setAttribute('viewBox', '0 0 10 10');
    marker.setAttribute('refX', '9');
    marker.setAttribute('refY', '5');
    marker.setAttribute('markerWidth', '6');
    marker.setAttribute('markerHeight', '6');
    marker.setAttribute('orient', 'auto-start-reverse');
    const path = doc.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
    path.setAttribute('fill', fill);
    marker.appendChild(path);
    defs.appendChild(marker);
  }
  svg.appendChild(defs);

  // Edges first so node rectangles paint on top of them.
  for (const from of laid) {
    for (const edge of from.node.outgoing) {
      const to = byId.get(edge.id);
      const isCycle = cycleEdges.has(`${from.node.id}->${edge.id}`);
      // Unresolved target → render a dashed stub since we have no box to land on.
      if (!to) {
        const line = doc.createElementNS(SVG_NS, 'line');
        const sx = from.x + from.width;
        const sy = from.y + from.height / 2;
        line.setAttribute('x1', String(sx));
        line.setAttribute('y1', String(sy));
        line.setAttribute('x2', String(sx + 30));
        line.setAttribute('y2', String(sy));
        line.setAttribute('stroke', '#b46600');
        line.setAttribute('stroke-width', '1.5');
        line.setAttribute('stroke-dasharray', '4 3');
        line.setAttribute('marker-end', 'url(#sfdt-arrow-missing)');
        svg.appendChild(line);
        continue;
      }
      const sx = from.x + from.width;
      const sy = from.y + from.height / 2;
      const tx = to.x;
      const ty = to.y + to.height / 2;
      const mx = (sx + tx) / 2;
      const path = doc.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', `M ${sx} ${sy} C ${mx} ${sy}, ${mx} ${ty}, ${tx} ${ty}`);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', isCycle ? '#c23934' : '#54698d');
      path.setAttribute('stroke-width', isCycle ? '2' : '1.5');
      if (edge.missing) path.setAttribute('stroke-dasharray', '4 3');
      path.setAttribute('marker-end', isCycle ? 'url(#sfdt-arrow-cycle)' : 'url(#sfdt-arrow)');
      svg.appendChild(path);
    }
  }

  for (const lay of laid) {
    const inCycle = cycleNodes.has(lay.node.id);
    const group = doc.createElementNS(SVG_NS, 'g');
    group.setAttribute('transform', `translate(${lay.x}, ${lay.y})`);

    const rect = doc.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('width', String(lay.width));
    rect.setAttribute('height', String(lay.height));
    rect.setAttribute('rx', '4');
    rect.setAttribute('ry', '4');
    rect.setAttribute('fill', inCycle ? '#fef2f1' : '#f4f6f9');
    rect.setAttribute('stroke', inCycle ? '#c23934' : '#d8dde6');
    rect.setAttribute('stroke-width', '1.5');
    group.appendChild(rect);

    const text = doc.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', String(lay.width / 2));
    text.setAttribute('y', String(lay.height / 2 + 4));
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('font-size', '12');
    text.setAttribute('fill', inCycle ? '#c23934' : '#16325c');
    const label = lay.node.label;
    text.textContent = label.length > MAX_LABEL_CHARS ? label.slice(0, MAX_LABEL_CHARS - 1) + '…' : label;
    const title = doc.createElementNS(SVG_NS, 'title');
    title.textContent = `${lay.node.label}\nDepth ${lay.depth} · calls ${lay.node.outgoing.length} · called by ${lay.node.incoming.length}`;
    group.appendChild(text);
    group.appendChild(title);
    svg.appendChild(group);
  }

  return svg;
}

export function buildSubflowGraphModal(doc: Document, graph: SubflowGraph): ViewHandle {
  const titleText = `Subflow Caller Graph — ${graph.nodes.size} flow${graph.nodes.size === 1 ? '' : 's'} · ${graph.cycles.length} cycle${graph.cycles.length === 1 ? '' : 's'}`;

  const body = doc.createElement('div');
  body.style.cssText = 'padding: 16px; overflow: auto; flex: 1;';

  // The Graph/List toggle used to live in the modal header; presentView's
  // header is title + × only, so it sits at the top of the body now.
  const toggle = doc.createElement('div');
  toggle.style.cssText =
    'display: inline-flex; border: 1px solid #d8dde6; border-radius: 4px; overflow: hidden; margin-bottom: 12px;';
  const graphBtn = doc.createElement('button');
  const listBtn = doc.createElement('button');
  const baseToggleStyle =
    'padding: 4px 12px; border: 0; background: #fff; cursor: pointer; font-size: 12px;';
  graphBtn.style.cssText = baseToggleStyle;
  listBtn.style.cssText = baseToggleStyle;
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
      'border: 1px solid #c23934; border-radius: 4px; padding: 10px; margin-bottom: 12px; background: #fef2f1;';
    const cycleTitle = doc.createElement('div');
    cycleTitle.style.cssText = 'font-weight: 600; color: #c23934; margin-bottom: 4px;';
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
  graphPane.style.cssText = 'border: 1px solid #d8dde6; border-radius: 4px; overflow: auto;';
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
    listPane.appendChild(row);
  }

  body.appendChild(graphPane);
  body.appendChild(listPane);

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

  const setView = (mode: 'graph' | 'list') => {
    if (mode === 'graph') {
      graphPane.style.display = '';
      listPane.style.display = 'none';
      graphBtn.style.background = '#16325c';
      graphBtn.style.color = '#fff';
      listBtn.style.background = '#fff';
      listBtn.style.color = '#16325c';
    } else {
      graphPane.style.display = 'none';
      listPane.style.display = '';
      listBtn.style.background = '#16325c';
      listBtn.style.color = '#fff';
      graphBtn.style.background = '#fff';
      graphBtn.style.color = '#16325c';
    }
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
      const loading = doc.createElement('div');
      loading.style.cssText =
        'position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 100020; display: flex; align-items: center; justify-content: center; color: #fff; font-family: system-ui, sans-serif;';
      loading.textContent = 'Building subflow graph…';
      doc.body.appendChild(loading);
      try {
        const flows = await fetchAllFlowMetadata(api);
        const graph = buildSubflowGraph(flows);
        loading.remove();
        buildSubflowGraphModal(doc, graph);
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
  return { fetchAllFlowMetadata, buildSubflowGraphModal, buildSubflowGraphSvg };
}
