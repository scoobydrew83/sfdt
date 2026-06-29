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
    const x = document.querySelector('.sfdt-view-overlay button') as HTMLButtonElement;
    expect(x.textContent).toBe('×');
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
