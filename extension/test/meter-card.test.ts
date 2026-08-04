// ui/meter-card.ts is the card four surfaces had each built: Apex governor
// limits, org limits, code coverage, and the Workspace overview tiles. The BAND
// stays the caller's call — 90% coverage is healthy, 90% of an API limit is an
// incident — so what's tested here is the presentation contract and the clamp.

import { describe, it, expect, beforeEach } from 'vitest';
import { meterCard, meterGrid, usageTone } from '../ui/meter-card.js';

const fill = (card: HTMLElement): HTMLElement => card.querySelector('.sfdt-meter i') as HTMLElement;

beforeEach(() => {
  document.body.replaceChildren();
});

describe('usageTone()', () => {
  it('bands by headroom, where MORE used is worse', () => {
    expect(usageTone(0)).toBe('ok');
    expect(usageTone(0.59)).toBe('ok');
    expect(usageTone(0.6)).toBe('warn');
    expect(usageTone(0.84)).toBe('warn');
    expect(usageTone(0.85)).toBe('bad');
    expect(usageTone(1)).toBe('bad');
  });
});

describe('meterCard()', () => {
  it('renders label, value and trailing detail', () => {
    const card = meterCard({ label: 'Heap', value: '3.0 MB', sub: '/ 6.0 MB', pct: 0.5, tone: 'ok' });
    expect(card.querySelector('.sfdt-tile-label')?.textContent).toBe('Heap');
    expect(card.querySelector('.sfdt-tile-value')?.textContent).toBe('3.0 MB / 6.0 MB');
  });

  it('sets the bar width from pct', () => {
    expect(fill(meterCard({ label: 'x', value: '1', pct: 0.42, tone: 'ok' })).style.width).toBe('42%');
  });

  it('CLAMPS a pct outside 0..1 rather than rendering a bar off the card', () => {
    // Used > max is a real Salesforce answer for some limits, and a caller
    // dividing by zero produces Infinity. Neither should be a layout bug.
    expect(fill(meterCard({ label: 'x', value: '1', pct: 1.4, tone: 'bad' })).style.width).toBe('100%');
    expect(fill(meterCard({ label: 'x', value: '1', pct: -0.2, tone: 'ok' })).style.width).toBe('0%');
    expect(
      fill(meterCard({ label: 'x', value: '1', pct: Number.POSITIVE_INFINITY, tone: 'bad' })).style
        .width,
    ).toBe('100%');
  });

  it('carries the tone as a class, not as a colour', () => {
    // The five independent BAND_COLOUR maps this replaced each wrote a colour
    // inline, which is how one of them ended up using a FILL token as a
    // foreground and rendering low-contrast in dark mode.
    expect(fill(meterCard({ label: 'x', value: '1', pct: 0.9, tone: 'bad' })).className).toBe('sfdt-bad');
    expect(fill(meterCard({ label: 'x', value: '1', pct: 0.1, tone: 'idle' })).className).toBe(
      'sfdt-idle',
    );
  });

  it('hides the bar from assistive tech', () => {
    // The value above already states it in words, and a bar is the one thing a
    // screen reader cannot usefully render.
    const card = meterCard({ label: 'Heap', value: '3.0 MB', pct: 0.5, tone: 'ok' });
    expect(card.querySelector('.sfdt-meter')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('builds into the passed document, never the global one', () => {
    const other = document.implementation.createHTMLDocument('other');
    expect(meterCard({ label: 'x', value: '1', pct: 0, tone: 'ok', doc: other }).ownerDocument).toBe(
      other,
    );
  });
});

describe('meterGrid()', () => {
  it('is an auto-fill grid, so it reflows instead of needing a count', () => {
    expect(meterGrid().className).toBe('sfdt-tiles');
  });
});
