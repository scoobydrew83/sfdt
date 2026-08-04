// A labelled card with a proportion bar.
//
// Four surfaces had built this independently — Apex governor limits, org limits,
// Apex code coverage, and the Workspace overview tiles — each with its own card
// CSS, its own bar height (5px / 6px / 8px), and its own map from a band to a
// colour. They render the same thing: a name, a number, and how full it is.
//
// The BAND is still the caller's decision, because the thresholds genuinely
// differ: 90% coverage is healthy, 90% of an API limit is an incident. Only the
// presentation is shared.

import { ensureComponentStyles } from '../lib/ui-styles.js';

export type MeterTone = 'ok' | 'warn' | 'bad' | 'idle';

/**
 * Tone from headroom — the common case, where MORE used is WORSE.
 *
 * Coverage inverts this (more is better), which is exactly why it is a separate
 * function the caller opts into rather than something meterCard() assumes.
 */
export function usageTone(pct: number): MeterTone {
  if (pct >= 0.85) return 'bad';
  if (pct >= 0.6) return 'warn';
  return 'ok';
}

export interface MeterCardOpts {
  /** The thing being measured. */
  label: string;
  /** The headline figure, already formatted ('3.0 MB', '82%'). */
  value: string;
  /** Trailing detail beside the value ('/ 6.0 MB', '41/50 lines'). */
  sub?: string;
  /** 0..1. Clamped; values outside the range are a caller bug, not a crash. */
  pct: number;
  tone: MeterTone;
  doc?: Document;
}

export function meterCard(opts: MeterCardOpts): HTMLElement {
  const doc = opts.doc ?? document;
  ensureComponentStyles(doc);

  const card = doc.createElement('div');
  card.className = 'sfdt-tile';

  const label = doc.createElement('div');
  label.className = 'sfdt-tile-label';
  label.textContent = opts.label;
  card.appendChild(label);

  const value = doc.createElement('div');
  value.className = 'sfdt-tile-value';
  value.textContent = opts.value;
  if (opts.sub) {
    const small = doc.createElement('small');
    small.textContent = ` ${opts.sub}`;
    value.appendChild(small);
  }
  card.appendChild(value);

  // Decorative: the value above already states it in words, and a bar is the one
  // thing a screen reader cannot usefully render.
  const meter = doc.createElement('div');
  meter.className = 'sfdt-meter';
  meter.setAttribute('aria-hidden', 'true');
  const fill = doc.createElement('i');
  fill.className = `sfdt-${opts.tone}`;
  fill.style.width = `${Math.round(Math.min(1, Math.max(0, opts.pct)) * 100)}%`;
  meter.appendChild(fill);
  card.appendChild(meter);

  return card;
}

/** The grid these sit in. Auto-fill, so it reflows instead of needing a count. */
export function meterGrid(doc: Document = document): HTMLDivElement {
  ensureComponentStyles(doc);
  const grid = doc.createElement('div');
  grid.className = 'sfdt-tiles';
  return grid;
}
