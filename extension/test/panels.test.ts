// ui/panels.ts owns the four blocks every feature used to re-invent. Two of the
// properties here are load-bearing rather than cosmetic: the error panel's class
// is what carries `white-space: pre-wrap` for multi-line org errors, and
// busyOverlay mounts into the shared content root — the three copies it replaced
// used doc.body, which on a Salesforce page is OUTSIDE our closed shadow root.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  renderSfError,
  setSfError,
  clearSfError,
  loadingPanel,
  emptyPanel,
  busyOverlay,
} from '../ui/panels.js';
import { setContentRoot } from '../ui/content-root.js';

beforeEach(() => {
  document.body.replaceChildren();
});

afterEach(() => {
  setContentRoot(null);
});

// A Salesforce error's `.message` is multi-line by construction since
// lib/sf-error-guidance.ts: the org's own text, then everything we appended.
const ORG_TEXT = "No such column 'Invoice_Statuss__c' on entity 'Invoice__c'.";
const NOTE = 'INVALID_FIELD · field: Invoice_Statuss__c — That field is not on the object.';
const COMPOSED = `${ORG_TEXT}\n${NOTE}`;

describe('renderSfError()', () => {
  it('announces itself as an alert', () => {
    // The a11y half of the item: 15 hand-rolled copies of this block set the
    // classes and forgot the role, so a screen reader never announced a
    // failure. A builder cannot forget.
    const el = renderSfError(new Error(ORG_TEXT));
    expect(el.getAttribute('role')).toBe('alert');
    expect(el.textContent).toBe(ORG_TEXT);
  });

  it('wears the class that preserves newlines', () => {
    expect(renderSfError(COMPOSED).className).toContain('sfdt-console');
  });

  it('renders the org text and the guidance as SEPARATE nodes', () => {
    // The root cause of PR #308's 16 one-by-one fixes: with the two halves in
    // one text node, whether they stayed apart depended on a `white-space` rule
    // each surface had to remember. Separate element nodes cannot collapse.
    const el = renderSfError(new Error(COMPOSED));
    const parts = [...el.children].map((c) => c.textContent);
    expect(parts).toEqual([ORG_TEXT, NOTE]);
    expect(el.querySelector('.sfdt-sf-error-text')?.textContent).toBe(ORG_TEXT);
    expect(el.querySelector('.sfdt-sf-error-note')?.textContent).toBe(NOTE);
  });

  it('never drops the org’s own text in favour of ours', () => {
    // The other half of what #308 fixed: several surfaces kept the guidance and
    // threw the org's real error away. The org's wording is always node one.
    const el = renderSfError(new Error(COMPOSED), { guidance: 'Check field-level security.' });
    expect(el.firstElementChild?.textContent).toBe(ORG_TEXT);
    expect(el.textContent).toContain('Check field-level security.');
  });

  it('appends caller guidance as its own node, below the org’s', () => {
    const el = renderSfError(ORG_TEXT, { guidance: 'Reload the tab and retry.' });
    expect([...el.children].map((c) => c.textContent)).toEqual([
      ORG_TEXT,
      'Reload the tab and retry.',
    ]);
  });

  it('takes whatever `catch` produced', () => {
    expect(renderSfError('a plain string').textContent).toBe('a plain string');
    expect(renderSfError(new Error('boom')).textContent).toBe('boom');
    expect(renderSfError({ toString: () => 'weird' }).textContent).toBe('weird');
    // null renders nothing rather than the word "null" — the pre-built,
    // still-hidden panels four features mount at open() pass exactly this.
    expect(renderSfError(null).textContent).toBe('');
    expect(renderSfError(null).children).toHaveLength(0);
  });

  it('drops blank lines rather than emitting empty nodes', () => {
    expect(renderSfError('a\n\nb').children).toHaveLength(2);
  });

  it('never interprets the org text as markup', () => {
    const el = renderSfError('<img src=x onerror=alert(1)>');
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('setSfError() / clearSfError()', () => {
  it('turns a plain console pane into a real alert', () => {
    // The debug-log and Execute Anonymous panes are a `<pre class="sfdt-console">`
    // that renders output until it has to render a failure. Re-classing it by
    // hand was the hand-roll; the role was what got left off.
    const pane = document.createElement('pre');
    pane.className = 'sfdt-console';
    setSfError(pane, new Error(COMPOSED));
    expect(pane.getAttribute('role')).toBe('alert');
    expect(pane.classList.contains('sfdt-error')).toBe(true);
    expect([...pane.children].map((c) => c.textContent)).toEqual([ORG_TEXT, NOTE]);
  });

  it('replaces the previous failure rather than appending to it', () => {
    const pane = document.createElement('div');
    setSfError(pane, 'first');
    setSfError(pane, 'second');
    expect(pane.textContent).toBe('second');
  });

  it('clears the alert role with the content', () => {
    // A reused pane that keeps role="alert" announces the NEXT thing rendered
    // into it as a failure — the success path's log body, in three of the four
    // surfaces that reuse a pane.
    const pane = document.createElement('div');
    setSfError(pane, new Error('boom'));
    clearSfError(pane);
    expect(pane.getAttribute('role')).toBeNull();
    expect(pane.classList.contains('sfdt-error')).toBe(false);
    expect(pane.textContent).toBe('');
  });

  it('builds into a `<pre>` without nesting block elements inside it', () => {
    // `<pre>` takes phrasing content; the parts are spans laid out as blocks by
    // the shared sheet, not divs.
    const pane = document.createElement('pre');
    setSfError(pane, new Error(COMPOSED));
    expect([...pane.children].every((c) => c.tagName === 'SPAN')).toBe(true);
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
