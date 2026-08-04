// ui/apex-limit-tiles.ts renders the governor-limit strip shared by Execute
// Anonymous and the Debug Logs viewer. The interesting logic is the SNAPSHOT
// choice: a log carries one block per namespace plus a cumulative roll-up when
// managed-package code ran, and leading with the cumulative one over-reports
// what the user's own Apex consumed.

import { describe, it, expect, beforeEach } from 'vitest';
import type { NamespaceLimits } from '../lib/apex-log/types.js';
import {
  pickLimitSnapshot,
  formatLimitValue,
  limitFillClass,
  createLimitTiles,
  LIMIT_TILES,
} from '../ui/apex-limit-tiles.js';

const snapshot = (
  namespace: string,
  cumulative: boolean,
  metrics: Record<string, { used: number; max: number }>,
): NamespaceLimits => ({ namespace, cumulative, metrics });

const FULL = {
  heapSize: { used: 3_145_728, max: 6_291_456 },
  cpuTime: { used: 1200, max: 10_000 },
  dmlStatements: { used: 3, max: 150 },
  soqlQueries: { used: 12, max: 100 },
};

beforeEach(() => {
  document.body.replaceChildren();
});

describe('pickLimitSnapshot()', () => {
  it('prefers the per-execution block over the cumulative roll-up', () => {
    const picked = pickLimitSnapshot([
      snapshot('(cumulative)', true, FULL),
      snapshot('', false, FULL),
    ]);
    expect(picked?.cumulative).toBe(false);
  });

  it('falls back to the cumulative block when that is all there is', () => {
    const picked = pickLimitSnapshot([snapshot('(cumulative)', true, FULL)]);
    expect(picked?.cumulative).toBe(true);
  });

  it('skips a block with no parsed metrics', () => {
    // A header-only block would otherwise win and render an empty panel.
    const picked = pickLimitSnapshot([snapshot('', false, {}), snapshot('ns', true, FULL)]);
    expect(picked?.namespace).toBe('ns');
  });

  it('is null when the log carried no limits at all', () => {
    expect(pickLimitSnapshot([])).toBeNull();
    expect(pickLimitSnapshot([snapshot('', false, {})])).toBeNull();
  });
});

describe('formatLimitValue()', () => {
  it('rounds heap, because "6291456" is not a number anyone reads', () => {
    expect(formatLimitValue(6_291_456, 'B')).toBe('6.0 MB');
    expect(formatLimitValue(4096, 'B')).toBe('4 KB');
    expect(formatLimitValue(512, 'B')).toBe('512 B');
  });

  it('keeps the unit on a measured value and drops it on a count', () => {
    expect(formatLimitValue(1200, 'ms')).toBe('1,200 ms');
    expect(formatLimitValue(12, '')).toBe('12');
  });
});

describe('limitFillClass()', () => {
  it('bands as usage — a governor limit at 90% is nearly spent', () => {
    expect(limitFillClass(0.1)).toBe('sfdt-ok');
    expect(limitFillClass(0.7)).toBe('sfdt-warn');
    expect(limitFillClass(0.9)).toBe('sfdt-bad');
  });
});

describe('createLimitTiles()', () => {
  it('starts hidden — there is nothing to show before a run', () => {
    expect(createLimitTiles().el.style.display).toBe('none');
  });

  it('renders one tile per known limit present', () => {
    const tiles = createLimitTiles();
    tiles.render(snapshot('', false, FULL));
    expect(tiles.el.querySelectorAll('.sfdt-tile')).toHaveLength(LIMIT_TILES.length);
    expect(tiles.el.style.display).toBe('');
    expect(tiles.el.textContent).toContain('3.0 MB');
    expect(tiles.el.textContent).toContain('/ 6.0 MB');
  });

  it('renders only the limits the log actually reported', () => {
    const tiles = createLimitTiles();
    tiles.render(snapshot('', false, { soqlQueries: { used: 12, max: 100 } }));
    expect(tiles.el.querySelectorAll('.sfdt-tile')).toHaveLength(1);
  });

  it('hides again when a run reports nothing usable', () => {
    // Log capture can be off, and a snapshot can carry only metrics outside the
    // four we tile. Either way an empty strip should not occupy the layout.
    const tiles = createLimitTiles();
    tiles.render(snapshot('', false, FULL));
    tiles.render(snapshot('', false, { queueableJobs: { used: 0, max: 50 } }));
    expect(tiles.el.querySelectorAll('.sfdt-tile')).toHaveLength(0);
    expect(tiles.el.style.display).toBe('none');
    tiles.render(null);
    expect(tiles.el.style.display).toBe('none');
  });

  it('REPLACES the previous run rather than appending to it', () => {
    // Both consumers re-render into the same element — Execute Anonymous on
    // every run, Debug Logs on every row selected.
    const tiles = createLimitTiles();
    tiles.render(snapshot('', false, FULL));
    tiles.render(snapshot('', false, FULL));
    expect(tiles.el.querySelectorAll('.sfdt-tile')).toHaveLength(LIMIT_TILES.length);
  });

  it('does not divide by a zero max', () => {
    const tiles = createLimitTiles();
    tiles.render(snapshot('', false, { cpuTime: { used: 5, max: 0 } }));
    const fill = tiles.el.querySelector('.sfdt-meter i') as HTMLElement;
    expect(fill.style.width).toBe('0%');
  });
});
