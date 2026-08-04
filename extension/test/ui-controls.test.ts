import { describe, it, expect, beforeEach, vi } from 'vitest';
import { button, glyph, setLabel, field, toolbar } from '../lib/ui-controls.js';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('button()', () => {
  it('builds a .sfdt-btn with the label in its own span', () => {
    const b = button({ label: 'Run' });
    expect(b.tagName).toBe('BUTTON');
    expect(b.type).toBe('button');
    expect(b.className).toBe('sfdt-btn');
    expect(b.textContent).toBe('Run');
    expect(b.querySelector('.sfdt-btn-label')?.textContent).toBe('Run');
  });

  it('applies variant, size and icon-only classes', () => {
    expect(button({ label: 'Go', variant: 'primary' }).className).toContain('sfdt-primary');
    expect(button({ label: 'X', variant: 'danger' }).className).toContain('sfdt-danger');
    expect(button({ label: 'Y', variant: 'ghost' }).className).toContain('sfdt-ghost');
    expect(button({ label: 'Z', small: true }).className).toContain('sfdt-sm');
    // No label ⇒ icon-only, so the sheet can make it square.
    expect(button({ iconName: 'close', ariaLabel: 'Close' }).className).toContain('sfdt-icon');
    expect(button({ label: 'Z' }).className).not.toContain('sfdt-icon');
  });

  it('renders the glyph as inline SVG, hidden from assistive tech', () => {
    const b = button({ label: 'Run', iconName: 'play' });
    const g = b.querySelector('.sfdt-glyph') as HTMLElement;
    expect(g.getAttribute('aria-hidden')).toBe('true');
    // The glyph never carries the meaning — the label beside it does — so
    // announcing it would only repeat the name.
    expect(g.querySelector('svg[data-sfdt-icon]')).not.toBeNull();
  });

  it('REFUSES to build a button with no accessible name', () => {
    // An icon-only button with no name is a screen-reader dead end and the
    // easiest a11y defect to ship by accident — the glyph looks self-evident to
    // whoever just picked it. Failing at construction makes it impossible to
    // render once in a test and stay silent in Chrome.
    expect(() => button({ iconName: 'close' })).toThrow(/label, title or ariaLabel/);
    expect(() => button({})).toThrow();
    // …and the escapes all work.
    expect(() => button({ label: 'Close' })).not.toThrow();
    expect(() => button({ iconName: 'close', title: 'Close' })).not.toThrow();
    expect(() => button({ iconName: 'close', ariaLabel: 'Close' })).not.toThrow();
  });

  it('names an icon-only button from title when no ariaLabel is given', () => {
    const b = button({ iconName: 'refresh', title: 'Refresh results' });
    expect(b.getAttribute('aria-label')).toBe('Refresh results');
    expect(b.title).toBe('Refresh results');
  });

  it('leaves aria-label off a labelled button whose text already names it', () => {
    // A redundant aria-label is noise, and it silently drifts out of sync with
    // the visible text next to it.
    expect(button({ label: 'Run' }).hasAttribute('aria-label')).toBe(false);
    // …but an explicit one wins, for when the visible text is not the name.
    expect(button({ label: 'Copy CSV', ariaLabel: 'Copy Account rows as CSV' })
      .getAttribute('aria-label')).toBe('Copy Account rows as CSV');
  });

  it('wires disabled and onClick', () => {
    const onClick = vi.fn();
    const b = button({ label: 'Go', onClick });
    b.click();
    expect(onClick).toHaveBeenCalledOnce();
    expect(button({ label: 'Nope', disabled: true }).disabled).toBe(true);
  });
});

describe('setLabel()', () => {
  it('changes the text WITHOUT destroying the glyph', () => {
    // The obvious `btn.textContent = 'Running…'` wipes every child including
    // the icon, and the button loses it permanently. Every async action does
    // exactly this, so the setter is what keeps the icon system from eroding on
    // first use.
    const b = button({ label: 'Run', iconName: 'play' });
    setLabel(b, 'Running…');
    expect(b.textContent).toBe('Running…');
    expect(b.querySelector('svg[data-sfdt-icon]')).not.toBeNull();
  });

  it('falls back to textContent for a button not built by the factory', () => {
    // Keeps it safe to call during a partial migration.
    const plain = document.createElement('button');
    plain.textContent = 'Old';
    setLabel(plain, 'New');
    expect(plain.textContent).toBe('New');
  });
});

describe('field() and toolbar()', () => {
  it('builds a named .sfdt-field', () => {
    const f = field({ ariaLabel: 'Filter fields', placeholder: 'Filter…', mono: true });
    expect(f.className).toBe('sfdt-field sfdt-mono');
    expect(f.getAttribute('aria-label')).toBe('Filter fields');
    expect(f.placeholder).toBe('Filter…');
    expect(f.type).toBe('text');
  });

  it('builds toolbar strips, head and foot', () => {
    expect(toolbar().className).toBe('sfdt-toolbar');
    expect(toolbar(document, true).className).toBe('sfdt-toolbar sfdt-toolbar-foot');
  });
});

describe('glyph()', () => {
  it('builds into the passed document, never the global one', () => {
    // Injected UI builds into a shadow root's owner document; defaulting to the
    // global `document` there produces nodes that silently belong elsewhere.
    const other = document.implementation.createHTMLDocument('other');
    const g = glyph('star', 16, other);
    expect(g.ownerDocument).toBe(other);
  });
});
