// Flame-chart layout (P3-4) — pure, zero-DOM. Maps the parser's invocation tree
// into positioned rectangles for a canvas flame chart. This is the testable core
// of the flame view: given the invocation `tree` (InvocationNode roots) it emits
// one FlameRect per node with time-scaled x/width and depth-scaled y. No canvas,
// no chrome.*, no DOM — the renderer (ui/apex-log-flame-chart.ts) consumes this.
//
// Coordinates: `x`/`width` are FRACTIONS (0..1) of the active time range, so the
// renderer multiplies by the pixel width of the canvas. `y` is in the same unit
// as `rowHeight` (pixels by default). A child's [start,end] is always ⊆ its
// parent's span in nanoseconds, and the transform is linear, so a child rect
// always sits within its parent's x-span — the flame invariant.

import type { InvocationNode } from './types.js';

export interface FlameRect {
  node: InvocationNode;
  /** Left edge as a fraction (0..1) of the active time range. */
  x: number;
  /** Width as a fraction of the active time range. Truncated/zero-duration
   *  frames get `minWidth` (default 0). May exceed [0,1] under zoom — the
   *  renderer culls/clamps. */
  width: number;
  /** Tree depth (root = 0). */
  depth: number;
  /** Vertical offset = depth * rowHeight. */
  y: number;
}

export interface FlameLayoutOptions {
  /** Row height in the same unit `y` is measured in (px). Default 18. */
  rowHeight?: number;
  /** Zoom target: rescale X so this node's time span fills [0,1]. */
  focus?: InvocationNode | null;
  /** Floor width for zero-duration/truncated frames, as a fraction. Default 0. */
  minWidth?: number;
}

export const DEFAULT_ROW_HEIGHT = 18;

/** Effective start: a node's own start, or the parent's start when unknown. */
function effStart(node: InvocationNode, inherited: number): number {
  return node.startNanos ?? inherited;
}

/** Effective end: own end, else start+total, else the start (⇒ zero width for a
 *  truncated frame with no closing event). */
function effEnd(node: InvocationNode, start: number): number {
  if (node.endNanos != null) return node.endNanos;
  if (node.startNanos != null && node.totalNanos != null) return node.startNanos + node.totalNanos;
  return start;
}

/** Time range spanned by a set of roots (min start → max end), inheriting 0. */
function rootRange(roots: InvocationNode[]): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const r of roots) {
    const s = effStart(r, 0);
    const e = effEnd(r, s);
    if (s < min) min = s;
    if (e > max) max = e;
  }
  if (!isFinite(min)) return [0, 0];
  return [min, max];
}

/**
 * Lay out the invocation tree into flame rectangles (one per node, pre-order).
 * By default the range is the full span of `roots`; pass `focus` to zoom X onto
 * a single node's time range (its rect then spans [0,1] and descendants scale
 * up). O(n) in the node count — no per-node allocation beyond the rect itself.
 */
export function layoutFlame(roots: InvocationNode[], opts: FlameLayoutOptions = {}): FlameRect[] {
  const rowHeight = opts.rowHeight ?? DEFAULT_ROW_HEIGHT;
  const minWidth = opts.minWidth ?? 0;

  let rangeStart: number;
  let rangeEnd: number;
  if (opts.focus) {
    rangeStart = effStart(opts.focus, 0);
    rangeEnd = effEnd(opts.focus, rangeStart);
  } else {
    [rangeStart, rangeEnd] = rootRange(roots);
  }
  const span = rangeEnd - rangeStart;
  // Degenerate range (single instant / all-truncated): every width collapses to
  // the floor rather than dividing by zero.
  const denom = span > 0 ? span : 1;

  const rects: FlameRect[] = [];
  const walk = (node: InvocationNode, depth: number, inheritedStart: number): void => {
    const s = effStart(node, inheritedStart);
    const e = effEnd(node, s);
    const x = (s - rangeStart) / denom;
    let width = span > 0 ? (e - s) / denom : 0;
    if (width < minWidth) width = minWidth;
    rects.push({ node, x, width, depth, y: depth * rowHeight });
    for (const child of node.children) walk(child, depth + 1, s);
  };
  for (const r of roots) walk(r, 0, rangeStart);
  return rects;
}

/**
 * Hit-test: the node whose rect covers pixel (px, py), or null. `px` is in the
 * same pixel space as `width * pixelWidth`; `py` matches `y`. Rects never overlap
 * within a depth band (siblings are time-disjoint) and bands are y-disjoint, so
 * the first cover is unambiguous. Deeper rects are tried first so a padded
 * (min-width) parent never shadows a real child at the same x.
 */
export function hitTestFlame(
  rects: FlameRect[],
  px: number,
  py: number,
  pixelWidth: number,
  rowHeight = DEFAULT_ROW_HEIGHT,
): InvocationNode | null {
  for (let i = rects.length - 1; i >= 0; i--) {
    const r = rects[i]!;
    if (py < r.y || py > r.y + rowHeight) continue;
    const rx = r.x * pixelWidth;
    const rw = r.width * pixelWidth;
    if (px >= rx && px <= rx + rw) return r.node;
  }
  return null;
}
