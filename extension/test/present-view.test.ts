import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  presentView,
  presentAsModal,
  setWorkspaceViewSink,
  inWorkspace,
} from '../ui/present-view.js';

function body(text = 'content'): HTMLElement {
  const b = document.createElement('div');
  b.textContent = text;
  return b;
}

describe('presentAsModal', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    setWorkspaceViewSink(null);
  });

  it('mounts an overlay + card with the title, body and footer', () => {
    const footer = document.createElement('div');
    footer.id = 'foot';
    const h = presentAsModal({ title: 'My Tool', body: body('hi'), footer });
    const overlay = document.querySelector('.sfdt-view-overlay');
    expect(overlay).not.toBeNull();
    expect(h.root.textContent).toContain('My Tool');
    expect(h.root.textContent).toContain('hi');
    expect(h.root.querySelector('#foot')).not.toBeNull();
  });

  it('closes on backdrop click and fires onClose', () => {
    const onClose = vi.fn();
    presentAsModal({ title: 'T', body: body(), onClose });
    const overlay = document.querySelector('.sfdt-view-overlay') as HTMLElement;
    overlay.click(); // e.target === overlay
    expect(document.querySelector('.sfdt-view-overlay')).toBeNull();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes via the × button and the returned handle', () => {
    const h = presentAsModal({ title: 'T', body: body() });
    const x = document.querySelector('.sfdt-view-overlay button[aria-label="Close"]') as HTMLButtonElement;
    expect(x.querySelector('svg[data-sfdt-icon]')).not.toBeNull();
    x.click();
    expect(document.querySelector('.sfdt-view-overlay')).toBeNull();
    // handle.close() is idempotent after an external close.
    expect(() => h.close()).not.toThrow();
  });

  it('does NOT close when a click lands inside the card', () => {
    presentAsModal({ title: 'T', body: body('keepme') });
    const card = document.querySelector('.sfdt-view-overlay > div') as HTMLElement;
    card.click();
    expect(document.querySelector('.sfdt-view-overlay')).not.toBeNull();
  });

  it('names the dialog for assistive tech', () => {
    presentAsModal({ title: 'My Tool', body: body() });
    const card = document.querySelector('.sfdt-view-overlay > div') as HTMLElement;
    expect(card.getAttribute('role')).toBe('dialog');
    expect(card.getAttribute('aria-modal')).toBe('true');
    // The name comes from aria-label rather than a heading: features put their
    // own <h2>s in the body, and a heading here would outrank them.
    expect(card.getAttribute('aria-label')).toBe('My Tool');
    expect(card.querySelector('h2')).toBeNull();
  });

  it('renders the glyph, subtitle and header actions when supplied', () => {
    const actions = document.createElement('div');
    actions.id = 'acts';
    presentAsModal({
      title: 'Inspect Record',
      subtitle: 'Account · 001800000000001AAA',
      iconName: 'record',
      headerActions: actions,
      body: body(),
    });
    const head = document.querySelector('.sfdt-panel-head') as HTMLElement;
    expect(head.querySelector('.sfdt-glyph svg[data-sfdt-icon]')).not.toBeNull();
    expect(head.querySelector('.sfdt-panel-title')?.textContent).toBe('Inspect Record');
    expect(head.querySelector('.sfdt-panel-sub')?.textContent).toBe('Account · 001800000000001AAA');
    expect(head.querySelector('#acts')).not.toBeNull();
  });

  it('omits the subtitle line entirely when there is none', () => {
    presentAsModal({ title: 'T', body: body() });
    expect(document.querySelector('.sfdt-panel-sub')).toBeNull();
  });

  it('closes on Escape and restores focus to the opener', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    presentAsModal({ title: 'T', body: body() });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(document.querySelector('.sfdt-view-overlay')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('Escape closes ONLY the topmost modal when views are stacked', () => {
    // A feature opening a second view over its own (soql-runner → inspect
    // record, apex-anonymous → log analyzer) leaves two listeners on the same
    // document. Without a topmost check one Escape collapsed the whole stack,
    // discarding the work in the view underneath.
    presentAsModal({ title: 'Under', body: body('under') });
    presentAsModal({ title: 'Over', body: body('over') });
    expect(document.querySelectorAll('.sfdt-view-overlay')).toHaveLength(2);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    const left = document.querySelectorAll('.sfdt-view-overlay');
    expect(left).toHaveLength(1);
    expect(left[0]?.textContent).toContain('under');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelectorAll('.sfdt-view-overlay')).toHaveLength(0);
  });

  it('drops its Escape listener on close, so a dismissed view stays dismissed', () => {
    const h = presentAsModal({ title: 'T', body: body() });
    h.close();
    presentAsModal({ title: 'Second', body: body('second') });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    // Only the live view's listener ran; a leaked one from the closed view
    // would have thrown or double-fired.
    expect(document.querySelectorAll('.sfdt-view-overlay')).toHaveLength(0);
  });
});

describe('presentView routing', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    setWorkspaceViewSink(null);
  });

  it('falls back to a modal when no workspace sink is registered', () => {
    expect(inWorkspace()).toBe(false);
    presentView({ title: 'T', body: body() });
    expect(document.querySelector('.sfdt-view-overlay')).not.toBeNull();
  });

  it('routes to the workspace sink (no modal) when one is registered', () => {
    const handle = { close: vi.fn(), root: document.createElement('div') };
    const sink = vi.fn(() => handle);
    setWorkspaceViewSink(sink);
    expect(inWorkspace()).toBe(true);

    const opts = { title: 'T', body: body() };
    const returned = presentView(opts);

    expect(sink).toHaveBeenCalledWith(opts);
    expect(returned).toBe(handle);
    // No modal overlay was created — the sink owns placement.
    expect(document.querySelector('.sfdt-view-overlay')).toBeNull();
  });
});

describe('presentAsModal — focus trap', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    setWorkspaceViewSink(null);
  });

  function twoButtonBody(): HTMLElement {
    const b = document.createElement('div');
    for (const label of ['one', 'two']) {
      const btn = document.createElement('button');
      btn.textContent = label;
      b.appendChild(btn);
    }
    return b;
  }

  function focusablesOf(card: HTMLElement): HTMLElement[] {
    return Array.from(card.querySelectorAll('button'));
  }

  it('wraps Tab from the last control back to the first', () => {
    // The trap used to be hand-rolled in schema-browser and field-impact and
    // absent from every other presentView caller. It belongs to the shell.
    const handle = presentAsModal({ title: 'T', body: twoButtonBody() });
    const controls = focusablesOf(handle.root);
    const last = controls[controls.length - 1]!;
    last.focus();

    const e = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    last.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(controls[0]);
  });

  it('wraps Shift+Tab from the first control to the last', () => {
    const handle = presentAsModal({ title: 'T', body: twoButtonBody() });
    const controls = focusablesOf(handle.root);
    const first = controls[0]!;
    first.focus();

    const e = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    first.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(controls[controls.length - 1]);
  });

  it('leaves Tab alone in the middle of the ring', () => {
    // A guard that always preventDefaults would break normal tabbing, which is
    // a worse bug than the leak it fixes.
    const handle = presentAsModal({ title: 'T', body: twoButtonBody() });
    const first = focusablesOf(handle.root)[0]!;
    first.focus();
    const e = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    first.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });

  it('only the topmost modal traps — a stacked dialog owns the keyboard', () => {
    // Same last-mounted-wins rule as Escape. Without it the card underneath
    // yanks focus out of the dialog the user is actually looking at.
    const lower = presentAsModal({ title: 'lower', body: twoButtonBody() });
    presentAsModal({ title: 'upper', body: twoButtonBody() });

    const lowerLast = focusablesOf(lower.root).slice(-1)[0]!;
    lowerLast.focus();
    const e = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    lowerLast.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });

  it('Escape closes only the topmost modal', () => {
    // The regression this session fixed for the third time: schema-browser and
    // field-impact each had a CAPTURE-phase document Escape listener, which
    // fired before this check and collapsed the whole stack.
    const closedLower = vi.fn();
    presentAsModal({ title: 'lower', body: body(), onClose: closedLower });
    const closedUpper = vi.fn();
    presentAsModal({ title: 'upper', body: body(), onClose: closedUpper });

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(closedUpper).toHaveBeenCalledTimes(1);
    expect(closedLower).not.toHaveBeenCalled();
    expect(document.querySelectorAll('.sfdt-view-overlay')).toHaveLength(1);
  });
});
