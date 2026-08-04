// ui/clipboard.ts replaced 20 hand-rolled copy sites, several of which had NO
// catch at all — in a blocked context (an iframe without the permission, a
// non-secure context) the click did nothing and said nothing. The failure path
// is therefore the important test here, not the success one.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { copyToClipboard } from '../ui/clipboard.js';

function fakeWin(writeText: () => Promise<void>): Window {
  return { navigator: { clipboard: { writeText } } } as unknown as Window;
}

const toastText = (): string => document.body.textContent ?? '';

beforeEach(() => {
  document.body.replaceChildren();
});

describe('copyToClipboard() — success', () => {
  it('writes the text and confirms it', async () => {
    const writeText = vi.fn(async () => {});
    await expect(copyToClipboard('SELECT Id FROM Account', { win: fakeWin(writeText) })).resolves.toBe(
      true,
    );
    expect(writeText).toHaveBeenCalledWith('SELECT Id FROM Account');
    expect(toastText()).toContain('Copied to clipboard');
  });

  it('names what was copied when the caller says', async () => {
    await copyToClipboard('a,b', { label: '12 rows as CSV', win: fakeWin(async () => {}) });
    expect(toastText()).toContain('Copied 12 rows as CSV');
  });
});

describe('copyToClipboard() — failure', () => {
  const blocked = (): Window =>
    fakeWin(async () => {
      throw new DOMException('Write permission denied.', 'NotAllowedError');
    });

  it('does not throw — the whole reason this is centralised', async () => {
    await expect(copyToClipboard('x', { win: blocked() })).resolves.toBe(false);
  });

  it('SAYS something, instead of the click silently doing nothing', async () => {
    await copyToClipboard('x', { win: blocked() });
    expect(toastText()).toContain('Could not copy to clipboard');
  });

  it('carries the label on the failure message too', async () => {
    // Folding 12 hand-written failure toasts into one helper initially LOST
    // this: "Could not copy response" became a generic message, and on a view
    // with several copy buttons you could no longer tell which one did nothing.
    await copyToClipboard('x', { label: 'response', win: blocked() });
    expect(toastText()).toContain('Could not copy response');
  });

  it('does not surface the raw DOMException', async () => {
    // NotAllowedError / a permissions-policy string tells a user nothing they
    // can act on.
    await copyToClipboard('x', { label: 'response', win: blocked() });
    expect(toastText()).not.toContain('NotAllowedError');
  });
});

describe('copyToClipboard() — which window', () => {
  it('uses the passed window, never the global one', async () => {
    // The Workspace hands features a SYNTHETIC window; reading `navigator` off
    // the global there reaches the wrong one.
    const writeText = vi.fn(async () => {});
    await copyToClipboard('x', { win: fakeWin(writeText) });
    expect(writeText).toHaveBeenCalledOnce();
  });
});
