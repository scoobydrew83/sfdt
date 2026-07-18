// Debug Logs → Analyze → flame chart (P3-4). A hand-rolled <canvas> timeline of
// the parser's invocation tree: one rectangle per frame, width ∝ wall time, y ∝
// call depth. No chart library (zero new dependency) and no DOM node per tree
// node — the whole tree draws in one canvas, O(visible rects) per frame.
//
// FRAME BUDGET / PERFORMANCE (AC-2):
//   • Layout (lib/apex-log/flame-layout.ts) is pure and O(n); we call it once
//     per draw, not per node, and only when the view actually changes (zoom,
//     theme, hover-target change) — redraws are rAF-throttled, never per
//     mousemove.
//   • Draw is O(visible rects): rects culled horizontally (off-screen under
//     zoom) and skipped entirely when narrower than 0.5px; labels are only
//     stroked when the rect is wide enough to hold a glyph, so the expensive
//     fillText path scales with what's readable, not with tree size.
//   • Colours (canvas can't read CSS vars) are resolved ONCE from the token
//     block via getComputedStyle and re-resolved on a theme change (observed on
//     the host <html> data-sfdt-theme attribute), so both themes render right.
//
// A11Y TRADEOFF (CONVENTIONS): a <canvas> flame chart is inherently not
// keyboard-navigable. That is acceptable ONLY because the P3-3 method table is
// the fully keyboard-accessible representation of the same data and stays the
// primary path; this canvas is an opt-in visual aid with an aria-label + text
// summary. Do not let the chart become the only way to reach a datum.

import { layoutFlame, hitTestFlame, DEFAULT_ROW_HEIGHT, type FlameRect } from '../lib/apex-log/flame-layout.js';
import { methodKey, formatNanosMs } from '../lib/apex-log/viewmodel.js';
import type { InvocationNode } from '../lib/apex-log/types.js';

const ROW_H = DEFAULT_ROW_HEIGHT;
const DEFAULT_WIDTH = 900;
const MIN_LABEL_PX = 34; // don't attempt a label narrower than this
const MIN_DRAW_PX = 0.5; // sub-pixel rects contribute nothing visible

export interface FlameChartOptions {
  /** Invocation-tree roots (parsed.tree). */
  roots: InvocationNode[];
  doc: Document;
  /** Fired when the user selects a frame (click) or clears it (Reset zoom). */
  onSelectNode?: (node: InvocationNode | null) => void;
  /** CSS pixel width of the canvas. Defaults to the container width, else 900. */
  width?: number;
}

export interface FlameChartHandle {
  /** The container element (canvas + Reset control + tooltip) to mount. */
  element: HTMLElement;
  canvas: HTMLCanvasElement;
  /** Highlight every frame matching a method key (namespace+name) — driven by
   *  the method table row click, so table→chart selection is bidirectional. */
  highlightKey(namespace: string | null, name: string): void;
  destroy(): void;
}

/** Colour palette resolved from the design tokens (canvas can't use var()). */
interface Palette {
  text: string;
  border: string;
  surface: string;
  selected: string;
  dark: boolean;
}

function resolvePalette(doc: Document): Palette {
  const cs = getComputedStyle(doc.documentElement);
  const get = (name: string, fallback: string): string => {
    const v = cs.getPropertyValue(name).trim();
    return v || fallback;
  };
  return {
    text: get('--sfdt-color-on-accent', '#fff'),
    border: get('--sfdt-color-surface', '#fff'),
    surface: get('--sfdt-color-surface', '#fff'),
    selected: get('--sfdt-color-brand-deep', '#16325c'),
    dark: doc.documentElement.getAttribute('data-sfdt-theme') === 'dark',
  };
}

/** Deterministic hue (0..360) from a frame's namespace (or name), so frames in
 *  the same package share a colour band. Canvas fills are data-viz colours, not
 *  UI-chrome tokens, so a computed hsl() is the right tool here. */
function hueFor(node: InvocationNode): number {
  const seed = node.namespace ?? node.name;
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return h;
}

function fillFor(node: InvocationNode, dark: boolean): string {
  const h = hueFor(node);
  // Truncated/dangling frames render muted so they read as "incomplete".
  const sat = node.truncated ? 12 : 62;
  const light = dark ? 42 : 68;
  return `hsl(${h}, ${sat}%, ${light}%)`;
}

export function buildFlameChart(opts: FlameChartOptions): FlameChartHandle {
  const { doc, roots } = opts;

  const element = doc.createElement('div');
  element.style.cssText = 'display: flex; flex-direction: column; gap: 6px; position: relative;';

  // Controls row: Reset zoom + a static text summary (also the a11y summary).
  const controls = doc.createElement('div');
  controls.style.cssText = 'display: flex; align-items: center; gap: 10px; font-size: 12px; color: var(--sfdt-color-text-weak);';

  const resetBtn = doc.createElement('button');
  resetBtn.type = 'button';
  resetBtn.textContent = 'Reset zoom';
  resetBtn.disabled = true;
  resetBtn.style.cssText =
    'background: var(--sfdt-color-surface); border: 1px solid var(--sfdt-color-border); border-radius: 4px; padding: 2px 8px; cursor: pointer; font: inherit; color: var(--sfdt-color-text);';

  const summary = doc.createElement('span');

  controls.append(resetBtn, summary);

  // Scroll container — the canvas can be taller than the modal for deep trees.
  const scroller = doc.createElement('div');
  scroller.style.cssText =
    'position: relative; overflow: auto; max-height: 320px; border: 1px solid var(--sfdt-color-border); border-radius: 4px; background: var(--sfdt-color-code-bg);';

  const canvas = doc.createElement('canvas');
  canvas.setAttribute('role', 'img');
  canvas.style.cssText = 'display: block;';
  scroller.appendChild(canvas);

  const tooltip = doc.createElement('div');
  tooltip.setAttribute('role', 'status');
  tooltip.style.cssText =
    'position: absolute; pointer-events: none; z-index: 5; display: none; max-width: 320px; padding: 4px 8px; border-radius: 4px; font-size: 11px; line-height: 1.4; background: var(--sfdt-color-surface); color: var(--sfdt-color-text); border: 1px solid var(--sfdt-color-border); box-shadow: 0 2px 8px rgba(0,0,0,0.25); white-space: pre;';
  scroller.appendChild(tooltip);

  element.append(controls, scroller);

  // ---- state -------------------------------------------------------------
  let palette = resolvePalette(doc);
  let focus: InvocationNode | null = null;
  let selected: InvocationNode | null = null;
  let hovered: InvocationNode | null = null;
  let highlightedKey: string | null = null;
  let rects: FlameRect[] = [];
  let cssW = opts.width ?? 0;
  let rafPending = false;

  // parent map for the "% of parent" tooltip figure; built once (O(n)).
  const parentOf = new Map<InvocationNode, InvocationNode | null>();
  const totalNodes = (() => {
    let n = 0;
    const walk = (node: InvocationNode, parent: InvocationNode | null): void => {
      parentOf.set(node, parent);
      n++;
      for (const c of node.children) walk(c, node);
    };
    for (const r of roots) walk(r, null);
    return n;
  })();

  let maxDepth = 0;
  for (const r of roots) {
    const walk = (node: InvocationNode, d: number): void => {
      if (d > maxDepth) maxDepth = d;
      for (const c of node.children) walk(c, d + 1);
    };
    walk(r, 0);
  }
  const rowCount = roots.length ? maxDepth + 1 : 0;

  summary.textContent = `${totalNodes} frame${totalNodes === 1 ? '' : 's'}, ${rowCount} level${rowCount === 1 ? '' : 's'} deep. Click a frame to zoom; the method table lists the same data.`;
  canvas.setAttribute(
    'aria-label',
    `Flame chart of the invocation tree: ${totalNodes} frames, ${rowCount} levels deep. Timings are also in the method-timings table above.`,
  );

  function measureWidth(): number {
    return opts.width ?? (scroller.clientWidth || DEFAULT_WIDTH);
  }

  function draw(): void {
    cssW = measureWidth();
    const cssH = rowCount * ROW_H;
    const dpr = doc.defaultView?.devicePixelRatio ?? 1;
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;

    // Layout drives hit-testing, so it runs regardless of whether a 2d context
    // is available (drawing is a separate concern from interaction).
    rects = layoutFlame(roots, { rowHeight: ROW_H, focus });

    const ctx = canvas.getContext('2d');
    if (!ctx) return; // happy-dom / no-canvas env: layout + interaction still work.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.font = '10px ui-monospace, monospace';
    ctx.textBaseline = 'middle';

    for (const rect of rects) {
      const rx = rect.x * cssW;
      const rw = Math.max(rect.width * cssW, 1);
      if (rx + rw < 0 || rx > cssW) continue; // horizontal cull (zoom)
      if (rw < MIN_DRAW_PX) continue;
      const node = rect.node;

      ctx.fillStyle = fillFor(node, palette.dark);
      ctx.fillRect(rx, rect.y, rw, ROW_H - 1);

      const isHi = highlightedKey != null && methodKey(node.namespace, node.name) === highlightedKey;
      const isSel = node === selected || node === hovered;
      if (isHi || isSel) {
        ctx.strokeStyle = palette.selected;
        ctx.lineWidth = isSel ? 2 : 1.5;
        ctx.strokeRect(rx + 1, rect.y + 1, rw - 2, ROW_H - 3);
      } else {
        ctx.strokeStyle = palette.surface;
        ctx.lineWidth = 1;
        ctx.strokeRect(rx + 0.5, rect.y + 0.5, rw - 1, ROW_H - 2);
      }

      if (rw >= MIN_LABEL_PX) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(rx, rect.y, rw, ROW_H);
        ctx.clip();
        ctx.fillStyle = palette.text;
        ctx.fillText(node.name, rx + 4, rect.y + ROW_H / 2);
        ctx.restore();
      }
    }
  }

  function scheduleDraw(): void {
    const raf = doc.defaultView?.requestAnimationFrame;
    if (!raf) {
      draw();
      return;
    }
    if (rafPending) return;
    rafPending = true;
    raf(() => {
      rafPending = false;
      draw();
    });
  }

  // ---- interaction -------------------------------------------------------
  function eventXY(e: MouseEvent): { px: number; py: number } {
    const r = canvas.getBoundingClientRect();
    return { px: e.clientX - r.left, py: e.clientY - r.top };
  }

  /** Hit-test helper — exposed for the click/hover handlers and unit tests. */
  function nodeAtPixel(px: number, py: number): InvocationNode | null {
    return hitTestFlame(rects, px, py, cssW || measureWidth(), ROW_H);
  }

  function selectNode(node: InvocationNode | null): void {
    selected = node;
    focus = node; // clicking a frame also zooms into its subtree
    resetBtn.disabled = focus == null;
    opts.onSelectNode?.(node);
    draw();
  }

  canvas.addEventListener('click', (e) => {
    const { px, py } = eventXY(e);
    const node = nodeAtPixel(px, py);
    if (node) selectNode(node);
  });

  canvas.addEventListener('mousemove', (e) => {
    const { px, py } = eventXY(e);
    const node = nodeAtPixel(px, py);
    if (node === hovered) {
      if (node) positionTooltip(e);
      return;
    }
    hovered = node;
    if (node) {
      showTooltip(node, e);
      scheduleDraw(); // rAF-throttled — never a synchronous per-move redraw
    } else {
      tooltip.style.display = 'none';
      scheduleDraw();
    }
  });

  canvas.addEventListener('mouseleave', () => {
    if (!hovered) return;
    hovered = null;
    tooltip.style.display = 'none';
    scheduleDraw();
  });

  function positionTooltip(e: MouseEvent): void {
    const r = scroller.getBoundingClientRect();
    tooltip.style.left = `${e.clientX - r.left + 12}px`;
    tooltip.style.top = `${e.clientY - r.top + 12}px`;
  }

  function showTooltip(node: InvocationNode, e: MouseEvent): void {
    const total = node.totalNanos ?? 0;
    const self = node.selfNanos ?? 0;
    const parent = parentOf.get(node) ?? null;
    const parentTotal = parent?.totalNanos ?? null;
    const pct = parentTotal && parentTotal > 0 ? ((total / parentTotal) * 100).toFixed(1) : null;
    const lines = [
      node.name,
      `total ${formatNanosMs(total)}  ·  self ${formatNanosMs(self)}`,
      pct != null ? `${pct}% of parent` : 'root frame',
      node.truncated ? '(truncated — timing incomplete)' : '',
    ].filter(Boolean);
    tooltip.textContent = lines.join('\n');
    tooltip.style.display = 'block';
    positionTooltip(e);
  }

  resetBtn.addEventListener('click', () => {
    focus = null;
    resetBtn.disabled = true;
    draw();
  });

  // Re-resolve tokens + redraw when the host theme flips (light/dark).
  const themeObserver = new MutationObserver(() => {
    palette = resolvePalette(doc);
    draw();
  });
  themeObserver.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-sfdt-theme'] });

  draw();

  return {
    element,
    canvas,
    highlightKey(namespace, name) {
      highlightedKey = methodKey(namespace, name);
      draw();
    },
    destroy() {
      themeObserver.disconnect();
    },
  };
}
