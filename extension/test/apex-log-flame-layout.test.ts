import { describe, it, expect } from 'vitest';
import { layoutFlame, hitTestFlame } from '../lib/apex-log/flame-layout.js';
import type { InvocationNode } from '../lib/apex-log/types.js';

// Minimal node factory — only the fields the layout reads.
function node(
  name: string,
  start: number | null,
  end: number | null,
  children: InvocationNode[] = [],
  extra: Partial<InvocationNode> = {},
): InvocationNode {
  const total = start != null && end != null ? end - start : null;
  return {
    name,
    kind: 'method',
    namespace: null,
    enterLine: 0,
    exitLine: end == null ? null : 1,
    startNanos: start,
    endNanos: end,
    totalNanos: total,
    selfNanos: total,
    children,
    ...extra,
  };
}

describe('flame-layout — layoutFlame', () => {
  it('scales x/width/depth against the root time range', () => {
    const child = node('child', 25, 75);
    const root = node('root', 0, 100, [child]);
    const rects = layoutFlame([root], { rowHeight: 10 });

    expect(rects).toHaveLength(2);
    const r0 = rects[0]!;
    expect(r0.node.name).toBe('root');
    expect(r0.x).toBeCloseTo(0);
    expect(r0.width).toBeCloseTo(1);
    expect(r0.depth).toBe(0);
    expect(r0.y).toBe(0);

    const r1 = rects[1]!;
    expect(r1.node.name).toBe('child');
    expect(r1.x).toBeCloseTo(0.25);
    expect(r1.width).toBeCloseTo(0.5);
    expect(r1.depth).toBe(1);
    expect(r1.y).toBe(10);
  });

  it('keeps every child within its parent x-span', () => {
    const gc = node('gc', 40, 60);
    const child = node('child', 30, 70, [gc]);
    const root = node('root', 0, 100, [child]);
    const rects = layoutFlame([root]);
    const byName = new Map(rects.map((r) => [r.node.name, r]));
    const p = byName.get('child')!;
    const g = byName.get('gc')!;
    expect(g.x).toBeGreaterThanOrEqual(p.x);
    expect(g.x + g.width).toBeLessThanOrEqual(p.x + p.width + 1e-9);
  });

  it('zoom (focus) rescales X so the focus node fills [0,1]', () => {
    const child = node('child', 25, 75);
    const root = node('root', 0, 100, [child]);
    const rects = layoutFlame([root], { focus: child });
    const byName = new Map(rects.map((r) => [r.node.name, r]));
    const c = byName.get('child')!;
    expect(c.x).toBeCloseTo(0);
    expect(c.width).toBeCloseTo(1);
    // The root now extends left of the viewport (starts before the focus).
    expect(byName.get('root')!.x).toBeLessThan(0);
  });

  it('gives truncated / null-duration frames zero width and does not crash', () => {
    const truncated = node('dangling', 50, null, [], { truncated: true });
    const root = node('root', 0, 100, [truncated]);
    const rects = layoutFlame([root]);
    const t = rects.find((r) => r.node.name === 'dangling')!;
    expect(t.width).toBe(0);
    // minWidth floor is honoured when asked.
    const floored = layoutFlame([root], { minWidth: 0.01 });
    expect(floored.find((r) => r.node.name === 'dangling')!.width).toBeCloseTo(0.01);
  });

  it('handles a degenerate (zero-span) range without dividing by zero', () => {
    const root = node('root', 5, 5);
    const rects = layoutFlame([root]);
    expect(rects[0]!.width).toBe(0);
    expect(Number.isFinite(rects[0]!.x)).toBe(true);
  });

  it('scales to a large synthetic tree (O(n), one rect per node)', () => {
    // 8-ary tree, depth 4 → 1 + 8 + 64 + 512 + 4096 = 4681 nodes.
    let id = 0;
    const build = (depth: number, start: number, end: number): InvocationNode => {
      const kids: InvocationNode[] = [];
      if (depth > 0) {
        const span = (end - start) / 8;
        for (let i = 0; i < 8; i++) {
          kids.push(build(depth - 1, start + i * span, start + (i + 1) * span));
        }
      }
      return node(`n${id++}`, start, end, kids);
    };
    const root = build(4, 0, 1_000_000);
    const rects = layoutFlame([root]);
    expect(rects).toHaveLength(4681);
    expect(rects.every((r) => Number.isFinite(r.x) && Number.isFinite(r.width))).toBe(true);
  });
});

describe('flame-layout — hitTestFlame', () => {
  const child = node('child', 25, 75);
  const root = node('root', 0, 100, [child]);
  const rects = layoutFlame([root], { rowHeight: 10 });

  it('returns the node whose rect covers the pixel', () => {
    // width 200px: child spans px 50..150 at y-band 10..20.
    expect(hitTestFlame(rects, 100, 15, 200, 10)?.name).toBe('child');
    // Top band is the root.
    expect(hitTestFlame(rects, 100, 5, 200, 10)?.name).toBe('root');
  });

  it('returns null outside any rect', () => {
    expect(hitTestFlame(rects, 100, 500, 200, 10)).toBeNull();
    expect(hitTestFlame(rects, 10, 15, 200, 10)).toBeNull(); // left of child
  });
});
