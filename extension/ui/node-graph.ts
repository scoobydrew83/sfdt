// Layered node-graph renderer — boxes in depth columns, curved edges between.
//
// This was `layoutGraph` + `buildSubflowGraphSvg` inside features/subflow-graph.ts.
// It moved here when the Schema Browser needed the same picture for object
// relationships, and the move was cheap for a reason worth recording: the
// structure it draws was never Flow-specific. `SubflowGraphNode` is
// `{ id, label, outgoing, incoming }` and `SubflowGraph` is
// `{ nodes, cycles, maxDepth }` — only the NAMES were about Flows. Nothing in
// the layout or the SVG ever read a Flow field.
//
// So `GraphNode`/`NodeGraph` below are declared with exactly that shape, which
// makes a `SubflowGraph` structurally assignable with no adapter, no cast and no
// change to flow-core. If this file had needed a `toGenericGraph()` shim, that
// would have been the signal that the reuse was a costume and the honest answer
// was a second renderer.
//
// Colour comes from `var(--sfdt-color-*)` set via the CSS `fill`/`stroke`
// PROPERTIES rather than the SVG presentation attributes — a custom property
// does not resolve in an attribute, and it inherits into the <marker> subtree.

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface GraphNode {
  id: string;
  label: string;
  /** `missing` renders a dashed stub when the target has no box in this graph. */
  outgoing: ReadonlyArray<{ id: string; missing: boolean }>;
  incoming: readonly string[];
}

export interface GraphCycle {
  members: readonly string[];
}

export interface NodeGraph {
  nodes: ReadonlyMap<string, GraphNode>;
  /**
   * Cycles to paint in the error colour. Pass `[]` when a cycle is NOT a defect
   * in your domain — a Flow calling itself is a bug, an Account looking up to a
   * parent Account is Tuesday. This is the whole reason it is a caller-supplied
   * list rather than something this module derives.
   */
  cycles: readonly GraphCycle[];
  /** Column assignment. Nodes with no entry land in column 0. */
  maxDepth: ReadonlyMap<string, number>;
}

export interface GraphOpts {
  /** `<title>` text for a node — the hover tooltip. Domain vocabulary lives here. */
  nodeTitle?: (node: GraphNode, depth: number) => string;
  /** Makes nodes activatable. Omit for a static picture. */
  onNodeClick?: (node: GraphNode) => void;
}

interface LaidOutNode {
  node: GraphNode;
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
// No barycentric edge-crossing minimisation — the graphs this draws are tens of
// nodes, not thousands, so the complexity isn't worth it.
export function layoutGraph(graph: NodeGraph): {
  nodes: LaidOutNode[];
  width: number;
  height: number;
} {
  const columns = new Map<number, GraphNode[]>();
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

export function buildNodeGraphSvg(
  doc: Document,
  graph: NodeGraph,
  opts: GraphOpts = {},
): SVGSVGElement {
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
    'display: block; font-family: system-ui, sans-serif; background: var(--sfdt-color-surface);';

  const defs = doc.createElementNS(SVG_NS, 'defs');
  for (const [id, fill] of [
    ['sfdt-arrow', 'var(--sfdt-color-text-weak)'],
    ['sfdt-arrow-cycle', 'var(--sfdt-color-error)'],
    ['sfdt-arrow-missing', 'var(--sfdt-color-warning-text)'],
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
    // SVG paint via the CSS `fill` property (not the presentation attribute) so
    // the `var(--sfdt-*)` token resolves; the custom property inherits from the
    // injected :root block into the <marker> subtree.
    path.style.fill = fill;
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
        line.style.stroke = 'var(--sfdt-color-warning-text)';
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
      path.style.stroke = isCycle ? 'var(--sfdt-color-error)' : 'var(--sfdt-color-text-weak)';
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
    rect.style.fill = inCycle ? 'var(--sfdt-color-error-bg)' : 'var(--sfdt-color-surface-shade)';
    rect.style.stroke = inCycle ? 'var(--sfdt-color-error)' : 'var(--sfdt-color-border)';
    rect.setAttribute('stroke-width', '1.5');
    group.appendChild(rect);

    const text = doc.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', String(lay.width / 2));
    text.setAttribute('y', String(lay.height / 2 + 4));
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('font-size', '12');
    // '-text-strong', NOT '-brand-deep'. The latter is a FILL token: #16325c in
    // light (fine on a pale node) but #1c3a63 in dark — near-black navy on a
    // #26272c node, which is what shipped and was unreadable. Foreground needs a
    // foreground alias. Same for the cycle colour: '-error' is the fill, and
    // '-error-text' is the one meant to be read.
    text.style.fill = inCycle
      ? 'var(--sfdt-color-error-text)'
      : 'var(--sfdt-color-text-strong)';
    const label = lay.node.label;
    text.textContent =
      label.length > MAX_LABEL_CHARS ? label.slice(0, MAX_LABEL_CHARS - 1) + '…' : label;
    const title = doc.createElementNS(SVG_NS, 'title');
    title.textContent = opts.nodeTitle
      ? opts.nodeTitle(lay.node, lay.depth)
      : `${lay.node.label}\nDepth ${lay.depth} · out ${lay.node.outgoing.length} · in ${lay.node.incoming.length}`;
    group.appendChild(text);
    group.appendChild(title);

    if (opts.onNodeClick) {
      const onClick = opts.onNodeClick;
      // A <g> is not focusable and takes no keyboard activation on its own, so
      // it gets the role, a tab stop and Enter/Space by hand. Without this the
      // graph is a mouse-only navigation surface, which is the classic way an
      // SVG diagram fails the keyboard path in CONVENTIONS.md.
      group.setAttribute('role', 'button');
      group.setAttribute('tabindex', '0');
      group.setAttribute('aria-label', lay.node.label);
      group.classList.add('sfdt-clickable');
      group.addEventListener('click', () => onClick(lay.node));
      group.addEventListener('keydown', (e) => {
        const key = (e as KeyboardEvent).key;
        if (key !== 'Enter' && key !== ' ') return;
        e.preventDefault();
        onClick(lay.node);
      });
    }

    svg.appendChild(group);
  }

  return svg;
}
