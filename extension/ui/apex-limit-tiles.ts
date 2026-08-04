// Governor-limit tiles — the "how close did that run come to the wall" strip.
//
// The parser has always extracted these (lib/apex-log/parser.ts); for a long
// time they were only reachable by opening the analyzer and scrolling to a
// two-column table. This renders the four that matter as tiles with meters, so
// any surface holding a parsed log can show them inline.
//
// Two consumers, which is the bar for this being a component rather than a
// wrapper: Execute Anonymous shows the limits of the run it just made, and the
// Debug Logs viewer shows the limits of whichever log is selected.
//
// Deliberately NOT a fixed side rail, though both mockups drew one. presentView
// renders the same DOM at 860–960px as a modal and at full width as a Workspace
// tab; a fixed rail is right in one and cramped in the other. '.sfdt-tiles' is
// an auto-fit grid, so it is 4-across in the pane and 2-across in the modal.

import type { LimitPair, NamespaceLimits } from '../lib/apex-log/types.js';
import { meterCard, usageTone } from './meter-card.js';

// The four worth a tile. The parser extracts eleven, but these are what a run is
// actually measured against — the rest stay one click away in the analyzer
// rather than turning a strip into a table. `key` matches LIMIT_LABEL_MAP in
// lib/apex-log/parser.ts.
export const LIMIT_TILES: ReadonlyArray<{ key: string; label: string; unit: string }> = [
  { key: 'heapSize', label: 'Heap', unit: 'B' },
  { key: 'cpuTime', label: 'CPU time', unit: 'ms' },
  { key: 'dmlStatements', label: 'DML', unit: '' },
  { key: 'soqlQueries', label: 'SOQL', unit: '' },
];

/**
 * Choose which governor-limit snapshot to show.
 *
 * A log carries one block per namespace, plus a cumulative roll-up when managed
 * package code ran. The per-execution block is what the user's own Apex is
 * measured against — a cumulative block includes limits the code under
 * inspection did not consume, so leading with it would over-report. Blocks with
 * no parsed metrics are skipped so a header-only block can't win and render an
 * empty panel.
 */
export function pickLimitSnapshot(limits: NamespaceLimits[]): NamespaceLimits | null {
  const useful = limits.filter((l) => Object.keys(l.metrics).length > 0);
  return useful.find((l) => !l.cumulative) ?? useful[0] ?? null;
}

/**
 * Render a limit number for a tile. Heap is reported in bytes, and "6291456" is
 * not a number anyone reads — it's the one metric where the raw value is
 * strictly worse than a rounded one.
 */
export function formatLimitValue(n: number, unit: string): string {
  if (unit === 'B') {
    if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    if (n >= 1024) return `${Math.round(n / 1024)} KB`;
    return `${n} B`;
  }
  return unit ? `${n.toLocaleString()} ${unit}` : n.toLocaleString();
}

/**
 * Fill class by headroom. Now just the shared usage banding — kept as a named
 * export because "how full is a governor limit" is the question this module is
 * about, and its test asserts the thresholds directly.
 */
export function limitFillClass(pct: number): string {
  return `sfdt-${usageTone(pct)}`;
}

function limitTile(
  doc: Document,
  spec: { key: string; label: string; unit: string },
  pair: LimitPair,
): HTMLElement {
  const pct = pair.max > 0 ? pair.used / pair.max : 0;
  return meterCard({
    doc,
    label: spec.label,
    value: formatLimitValue(pair.used, spec.unit),
    sub: `/ ${formatLimitValue(pair.max, spec.unit)}`,
    pct,
    // Governor limits are usage: more consumed is worse.
    tone: usageTone(pct),
  });
}

export interface LimitTiles {
  /** Mount this. It hides itself when there is nothing to show. */
  el: HTMLElement;
  /** Replace the contents. `null` (or a snapshot with none of the four) hides it. */
  render(snapshot: NamespaceLimits | null): void;
}

export function createLimitTiles(doc: Document = document): LimitTiles {
  const el = doc.createElement('div');
  el.className = 'sfdt-tiles';
  el.style.display = 'none';

  return {
    el,
    render(snapshot) {
      el.textContent = '';
      const tiles = snapshot
        ? LIMIT_TILES.flatMap((spec) => {
            const pair = snapshot.metrics[spec.key];
            return pair ? [limitTile(doc, spec, pair)] : [];
          })
        : [];
      for (const tile of tiles) el.appendChild(tile);
      el.style.display = tiles.length ? '' : 'none';
    },
  };
}
