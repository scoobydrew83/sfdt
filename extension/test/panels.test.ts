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
import { SalesforceRestError } from '../lib/salesforce-api.js';

beforeEach(() => {
  document.body.replaceChildren();
});

afterEach(() => {
  setContentRoot(null);
});

// The org's own wording, and the line lib/sf-error-guidance.ts appends beside
// it. They travel SEPARATELY on a SalesforceRestError's `.userFacing`; the
// flattened `.message` is what a toast shows.
const ORG_TEXT = "No such column 'Invoice_Statuss__c' on entity 'Invoice__c'.";
const NOTE = 'INVALID_FIELD · field: Invoice_Statuss__c — That field is not on the object.';

function orgError(orgText = ORG_TEXT, notes: string[] = [NOTE]): SalesforceRestError {
  return new SalesforceRestError([orgText, ...notes].join('\n'), 400, [], { orgText, notes });
}

describe('renderSfError()', () => {
  it('announces itself as an alert', () => {
    // The a11y half of the item: fifteen hand-rolled copies of this block set
    // the classes and forgot the role, so a screen reader never announced a
    // failure. A builder cannot forget.
    const el = renderSfError(new Error(ORG_TEXT));
    expect(el.getAttribute('role')).toBe('alert');
    expect(el.textContent).toBe(ORG_TEXT);
  });

  it('wears the class that preserves newlines', () => {
    expect(renderSfError(orgError()).className).toContain('sfdt-console');
  });

  it('renders the org text and the guidance as SEPARATE nodes', () => {
    // The root cause of PR #308's sixteen one-by-one fixes: with the two halves
    // in one text node, whether they stayed apart depended on a `white-space`
    // rule each surface had to remember. Separate element nodes cannot collapse.
    const el = renderSfError(orgError());
    expect([...el.children].map((c) => c.textContent)).toEqual([ORG_TEXT, NOTE]);
    expect(el.querySelector('.sfdt-sf-error-text')?.textContent).toBe(ORG_TEXT);
    expect(el.querySelector('.sfdt-sf-error-note')?.textContent).toBe(NOTE);
  });

  it('never drops the org’s own text in favour of ours', () => {
    // The other half of what #308 fixed: several surfaces kept the guidance and
    // threw the org's real error away. The org's wording is always node one.
    const el = renderSfError(orgError(), { guidance: 'Check field-level security.' });
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

  // ── The part that must NOT be clever ──────────────────────────────────────
  //
  // A first draft split on newlines: line one was the org, everything after it
  // was ours. That is right for a single-line org message and WRONG for a
  // multi-line one — an Apex compile error or a stack trace arrives with real
  // newlines inside ONE record, and the split re-labelled the org's own
  // continuation lines as our advice and painted them in our colour. That is
  // the #308 defect inverted. The renderer now uses the structure the error
  // carried, and declines to guess when there is none.
  it('keeps a multi-line ORG message in one node', () => {
    const stack = 'System.NullPointerException: Attempt to de-reference a null object\n\nClass.Foo.bar: line 12, column 1\nClass.Foo.baz: line 40, column 3';
    const el = renderSfError(orgError(stack, []));
    expect(el.children).toHaveLength(1);
    expect(el.querySelector('.sfdt-sf-error-note')).toBeNull();
    expect(el.textContent).toBe(stack);
  });

  it('does not guess where our words start in an unstructured message', () => {
    // A plain string — a feature-composed message, a TypeError, a bridge reply.
    // Nothing here is ours, so nothing is styled as ours; the single node is
    // `pre-wrap`, so the newlines it already had survive.
    const el = renderSfError('Could not load Account — boom\nsecond line of the org text');
    expect(el.children).toHaveLength(1);
    expect(el.firstElementChild?.className).toBe('sfdt-sf-error-text');
  });

  it('splits a structured error even when its org text is itself multi-line', () => {
    const el = renderSfError(orgError('line one\nline two', [NOTE]));
    expect([...el.children].map((c) => c.textContent)).toEqual(['line one\nline two', NOTE]);
  });

  it('takes whatever `catch` produced', () => {
    expect(renderSfError('a plain string').textContent).toBe('a plain string');
    expect(renderSfError(new Error('boom')).textContent).toBe('boom');
    expect(renderSfError({ toString: () => 'weird' }).textContent).toBe('weird');
  });

  it('is total over a hostile `.userFacing`', () => {
    // The parts arrive on an object, and an object can be anything.
    const hostile = [
      Object.assign(new Error('m'), { userFacing: 'nope' }),
      Object.assign(new Error('m'), { userFacing: { orgText: 7, notes: [] } }),
      Object.assign(new Error('m'), { userFacing: { orgText: 'ok', notes: 'nope' } }),
      Object.assign(new Error('m'), { userFacing: { orgText: 'ok', notes: [null, 1, '', 'real'] } }),
    ];
    for (const err of hostile) expect(() => renderSfError(err)).not.toThrow();
    expect(renderSfError(hostile[3]!).textContent).toBe('okreal');
  });

  it('builds nothing at all — including the role — for an empty panel', () => {
    // Four surfaces mount a hidden panel at open() and fill it later. An empty
    // `role="alert"` region parked in the tree is a live announcement point for
    // whatever lands in it next, which is the same defect `clearSfError` takes
    // the role back off to avoid.
    const el = renderSfError(null);
    expect(el.children).toHaveLength(0);
    expect(el.getAttribute('role')).toBeNull();
    expect(el.classList.contains('sfdt-error')).toBe(false);
  });

  it('still renders a panel for a thrown error with no message', () => {
    // N5 of the #327 review, and the sharp edge of the null contract above.
    // `sfErrorParts()` falls back to `errorText()`, which is `''` for
    // `new Error('')` — so `parts.length === 0` and the empty-panel branch
    // swallowed the failure whole: no panel, no `role="alert"`, no text, from
    // every call site that forwards a caught error. That is #308 itself (a
    // failure the user never sees), reached through the helper this PR line
    // exists to centralise, and the sweep cannot see it because every call
    // site is CORRECT.
    //
    // `null`/`undefined` still render nothing — that is a caller saying "there
    // is no error", which is a different statement from an error saying
    // nothing.
    for (const thrown of [new Error(''), new Error(), '']) {
      const el = renderSfError(thrown);
      expect(el.getAttribute('role'), String(thrown)).toBe('alert');
      expect(el.classList.contains('sfdt-error'), String(thrown)).toBe(true);
      expect(el.textContent, String(thrown)).toMatch(/no message/);
    }
    // …and into a pane the caller owns, which is the path the funnels take.
    const pane = document.createElement('pre');
    pane.className = 'sfdt-console';
    setSfError(pane, new Error(''));
    expect(pane.getAttribute('role')).toBe('alert');
    expect(pane.textContent).toMatch(/no message/);

    for (const nothing of [null, undefined]) {
      const el = renderSfError(nothing);
      expect(el.getAttribute('role'), String(nothing)).toBeNull();
      expect(el.textContent, String(nothing)).toBe('');
    }
  });

  it('drops blank notes rather than emitting empty nodes', () => {
    expect(renderSfError(orgError(ORG_TEXT, ['', '   ', NOTE])).children).toHaveLength(2);
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
    setSfError(pane, orgError());
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
    // into it as a failure — the success path's log body, in the three surfaces
    // that reuse a pane.
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
    setSfError(pane, orgError());
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
