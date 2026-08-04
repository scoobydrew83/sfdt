// ui/panels.ts owns the four blocks every feature used to re-invent. Two of the
// properties here are load-bearing rather than cosmetic: the error panel's class
// is what carries `white-space: pre-wrap` for multi-line org errors, and
// busyOverlay mounts into the shared content root — the three copies it replaced
// used doc.body, which on a Salesforce page is OUTSIDE our closed shadow root.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { errorPanel, loadingPanel, emptyPanel, busyOverlay } from '../ui/panels.js';
import { setContentRoot } from '../ui/content-root.js';

beforeEach(() => {
  document.body.replaceChildren();
});

afterEach(() => {
  setContentRoot(null);
});

describe('errorPanel()', () => {
  it('announces itself as an alert', () => {
    const el = errorPanel('INVALID_FIELD: No such column');
    expect(el.getAttribute('role')).toBe('alert');
    expect(el.textContent).toBe('INVALID_FIELD: No such column');
  });

  it('wears the class that preserves newlines', () => {
    // Since lib/sf-error-guidance.ts a Salesforce error message is multi-line —
    // the org's text, then the "what to do" line. Without a white-space rule the
    // guidance runs into the org's own text; that shipped once, which is why
    // test/error-render-newlines.test.ts exists.
    expect(errorPanel('a\nb').className).toContain('sfdt-console');
  });

  it('never interprets the org text as markup', () => {
    const el = errorPanel('<img src=x onerror=alert(1)>');
    expect(el.children).toHaveLength(0);
    expect(el.textContent).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('loadingPanel()', () => {
  it('is a status region so it is announced, not silent', () => {
    const el = loadingPanel();
    expect(el.getAttribute('role')).toBe('status');
    expect(el.textContent).toBe('Loading…');
  });

  it('takes the caller-supplied words', () => {
    expect(loadingPanel('Describing Account…').textContent).toBe('Describing Account…');
  });
});

describe('emptyPanel()', () => {
  it('renders the message alone by default', () => {
    const el = emptyPanel('No results');
    expect(el.textContent).toBe('No results');
    expect(el.querySelector('svg[data-sfdt-icon]')).toBeNull();
  });

  it('adds the hint that says what WOULD produce results', () => {
    // "No results" on its own is a dead end.
    const el = emptyPanel('No results', { hint: 'Try removing the WHERE clause.' });
    expect(el.textContent).toContain('Try removing the WHERE clause.');
  });

  it('takes an optional glyph', () => {
    const el = emptyPanel('Nothing here', { iconName: 'search' });
    expect(el.querySelector('svg[data-sfdt-icon]')).not.toBeNull();
  });
});

describe('busyOverlay()', () => {
  it('mounts into the shared content root when there is one', () => {
    // On a Salesforce page that root is the closed shadow root's wrapper.
    // doc.body — what all three replaced copies used — puts the scrim outside
    // it, where the host page's CSS can restyle it and it sits in a different
    // stacking context from every other overlay we own.
    const root = document.createElement('div');
    document.body.appendChild(root);
    setContentRoot(root);

    const busy = busyOverlay('Retrieving…');
    expect(root.querySelector('.sfdt-busy')).not.toBeNull();
    busy.close();
  });

  it('falls back to the body on our own full-page surfaces', () => {
    // The Workspace and options page render in light DOM and set no root.
    const busy = busyOverlay('Retrieving…');
    expect(document.body.querySelector('.sfdt-busy')).not.toBeNull();
    busy.close();
  });

  it('is a status region with the spinner hidden from assistive tech', () => {
    const busy = busyOverlay('Retrieving…');
    const el = document.querySelector('.sfdt-busy') as HTMLElement;
    expect(el.getAttribute('role')).toBe('status');
    expect(el.querySelector('.sfdt-spinner')?.getAttribute('aria-hidden')).toBe('true');
    busy.close();
  });

  it('swaps the message in place, so a failure can be reported before dismissing', () => {
    const busy = busyOverlay('Retrieving…');
    busy.setMessage('Retrieve failed:\nINSUFFICIENT_ACCESS');
    expect(document.querySelector('.sfdt-msg')?.textContent).toContain('INSUFFICIENT_ACCESS');
    busy.close();
  });

  it('closes idempotently', () => {
    // Callers close it on both the success and the failure path, and some do
    // both in a finally.
    const busy = busyOverlay('Retrieving…');
    busy.close();
    expect(() => busy.close()).not.toThrow();
    expect(document.querySelector('.sfdt-busy')).toBeNull();
  });
});
