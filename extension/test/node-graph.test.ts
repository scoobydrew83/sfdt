import { describe, it, expect, vi } from 'vitest';
import { buildNodeGraphSvg, layoutGraph, type NodeGraph } from '../ui/node-graph.js';

function graph(
  spec: Array<{ id: string; depth: number; out?: string[]; missing?: string[] }>,
  cycles: Array<{ members: string[] }> = [],
): NodeGraph {
  const nodes = new Map(
    spec.map((n) => [
      n.id,
      {
        id: n.id,
        label: n.id,
        outgoing: [
          ...(n.out ?? []).map((id) => ({ id, missing: false })),
          ...(n.missing ?? []).map((id) => ({ id, missing: true })),
        ],
        incoming: spec.filter((o) => (o.out ?? []).includes(n.id)).map((o) => o.id),
      },
    ]),
  );
  return { nodes, cycles, maxDepth: new Map(spec.map((n) => [n.id, n.depth])) };
}

describe('layoutGraph', () => {
  it('puts each depth in its own column, alphabetically within it', () => {
    // Stable ordering matters: without it the same graph redraws differently on
    // every render and the picture appears to change when nothing did.
    const { nodes } = layoutGraph(graph([
      { id: 'zeta', depth: 1 },
      { id: 'alpha', depth: 1 },
      { id: 'root', depth: 0, out: ['alpha', 'zeta'] },
    ]));
    const byId = new Map(nodes.map((n) => [n.node.id, n]));
    expect(byId.get('root')!.x).toBeLessThan(byId.get('alpha')!.x);
    expect(byId.get('alpha')!.x).toBe(byId.get('zeta')!.x);
    expect(byId.get('alpha')!.y).toBeLessThan(byId.get('zeta')!.y);
  });

  it('defaults a node with no depth entry to column 0', () => {
    const g = graph([{ id: 'orphan', depth: 0 }]);
    (g.maxDepth as Map<string, number>).delete('orphan');
    expect(layoutGraph(g).nodes[0]!.x).toBeGreaterThan(0);
  });

  it('sizes the canvas to the widest column and the tallest', () => {
    const one = layoutGraph(graph([{ id: 'a', depth: 0 }]));
    const two = layoutGraph(graph([
      { id: 'a', depth: 0 },
      { id: 'b', depth: 1 },
      { id: 'c', depth: 1 },
    ]));
    expect(two.width).toBeGreaterThan(one.width);
    expect(two.height).toBeGreaterThan(one.height);
  });
});

describe('buildNodeGraphSvg', () => {
  it('draws a box per node and an edge per link', () => {
    const svg = buildNodeGraphSvg(document, graph([
      { id: 'a', depth: 0, out: ['b'] },
      { id: 'b', depth: 1 },
    ]));
    expect(svg.querySelectorAll('rect')).toHaveLength(2);
    expect(svg.querySelectorAll('path[marker-end]')).toHaveLength(1);
  });

  it('paints declared cycles in the error colour, and nothing when none are declared', () => {
    // The Schema Browser passes cycles: [] on purpose — an Account looking up to
    // a parent Account is normal, and red would call it a defect.
    const cyc = buildNodeGraphSvg(document, graph(
      [{ id: 'a', depth: 0, out: ['b'] }, { id: 'b', depth: 1, out: ['a'] }],
      [{ members: ['a', 'b'] }],
    ));
    expect(cyc.querySelector('rect')!.style.stroke).toContain('error');

    const plain = buildNodeGraphSvg(document, graph([
      { id: 'a', depth: 0, out: ['b'] },
      { id: 'b', depth: 1, out: ['a'] },
    ]));
    expect(plain.querySelector('rect')!.style.stroke).not.toContain('error');
  });

  it('renders an unresolved target as a dashed stub, not a dropped edge', () => {
    const svg = buildNodeGraphSvg(document, graph([{ id: 'a', depth: 0, missing: ['ghost'] }]));
    const stub = svg.querySelector('line');
    expect(stub).not.toBeNull();
    expect(stub!.getAttribute('stroke-dasharray')).toBe('4 3');
  });

  it('uses the caller’s vocabulary for the tooltip', () => {
    const svg = buildNodeGraphSvg(
      document,
      graph([{ id: 'a', depth: 0 }]),
      { nodeTitle: (n) => `${n.label} — click to browse` },
    );
    expect(svg.querySelector('title')!.textContent).toBe('a — click to browse');
  });

  it('is a static picture unless a click handler is supplied', () => {
    const svg = buildNodeGraphSvg(document, graph([{ id: 'a', depth: 0 }]));
    expect(svg.querySelector('g[role="button"]')).toBeNull();
  });

  it('gives an activatable node a full keyboard path, not just a click', () => {
    // An <g> is not focusable and takes no keyboard activation of its own —
    // this is the classic way an SVG diagram ends up mouse-only.
    const onNodeClick = vi.fn();
    const svg = buildNodeGraphSvg(document, graph([{ id: 'a', depth: 0 }]), { onNodeClick });
    const node = svg.querySelector('g[role="button"]')!;
    expect(node.getAttribute('tabindex')).toBe('0');
    expect(node.getAttribute('aria-label')).toBe('a');

    node.dispatchEvent(new MouseEvent('click'));
    expect(onNodeClick).toHaveBeenCalledTimes(1);

    node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    node.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', cancelable: true }));
    expect(onNodeClick).toHaveBeenCalledTimes(3);

    node.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', cancelable: true }));
    expect(onNodeClick).toHaveBeenCalledTimes(3);
  });

  it('paints colour through the CSS property, never the SVG attribute', () => {
    // A var(--sfdt-*) does not resolve in a presentation attribute. This is the
    // one rule that makes the whole diagram theme-aware.
    const svg = buildNodeGraphSvg(document, graph([{ id: 'a', depth: 0 }]));
    const rect = svg.querySelector('rect')!;
    expect(rect.style.fill).toContain('var(--sfdt-color');
    expect(rect.getAttribute('fill')).toBeNull();
  });
});
