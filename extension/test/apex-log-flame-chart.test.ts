import { describe, it, expect, beforeEach } from 'vitest';
import { buildFlameChart } from '../ui/apex-log-flame-chart.js';
import type { InvocationNode } from '../lib/apex-log/types.js';

function node(
  name: string,
  start: number,
  end: number,
  children: InvocationNode[] = [],
  namespace: string | null = null,
): InvocationNode {
  return {
    name,
    kind: 'method',
    namespace,
    enterLine: 0,
    exitLine: 1,
    startNanos: start,
    endNanos: end,
    totalNanos: end - start,
    selfNanos: end - start,
    children,
  };
}

// root(0..100) → a(0..100) → b(25..75). At width 400px, b spans px 100..300 in
// the depth-2 y band (36..54 with ROW_H 18).
function tree(): InvocationNode[] {
  const b = node('Foo.baz()', 25, 75);
  const a = node('Foo.bar()', 0, 100, [b]);
  return [node('EXECUTION', 0, 100, [a])];
}

function clickAt(canvas: HTMLCanvasElement, x: number, y: number): void {
  canvas.dispatchEvent(new MouseEvent('click', { clientX: x, clientY: y, bubbles: true }));
}

describe('apex-log-flame-chart', () => {
  beforeEach(() => {
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
  });

  it('creates a canvas with an aria-label and a text summary', () => {
    const h = buildFlameChart({ roots: tree(), doc: document, width: 400 });
    document.body.appendChild(h.element);
    expect(h.canvas.tagName).toBe('CANVAS');
    expect(h.canvas.getAttribute('aria-label')).toMatch(/flame chart/i);
    expect(h.element.textContent).toMatch(/frames/i);
    h.destroy();
  });

  it('clicking a frame fires onSelectNode with the covering node', () => {
    let selected: InvocationNode | null = null;
    const h = buildFlameChart({
      roots: tree(),
      doc: document,
      width: 400,
      onSelectNode: (n) => {
        selected = n;
      },
    });
    document.body.appendChild(h.element);

    clickAt(h.canvas, 150, 45); // inside Foo.baz() (depth 2)
    expect(selected).not.toBeNull();
    expect(selected!.name).toBe('Foo.baz()');
    h.destroy();
  });

  it('has a Reset zoom control that enables after a zoom click', () => {
    const h = buildFlameChart({ roots: tree(), doc: document, width: 400 });
    document.body.appendChild(h.element);
    const reset = h.element.querySelector<HTMLButtonElement>('button')!;
    expect(reset.textContent).toBe('Reset zoom');
    expect(reset.disabled).toBe(true);
    clickAt(h.canvas, 150, 45); // zoom into a frame
    expect(reset.disabled).toBe(false);
    reset.click();
    expect(reset.disabled).toBe(true);
    h.destroy();
  });

  it('highlightKey does not throw and is callable from the table side', () => {
    const h = buildFlameChart({ roots: tree(), doc: document, width: 400 });
    document.body.appendChild(h.element);
    expect(() => h.highlightKey(null, 'Foo.bar()')).not.toThrow();
    h.destroy();
  });
});
