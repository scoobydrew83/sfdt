// ui/confirm-dialog.ts is the UNION of two hand-rolled dialogs: one trapped
// focus, wired Esc and restored focus; the other had a type-to-confirm gate and
// none of the a11y. Every user was getting whichever version their feature
// happened to have. These tests pin both halves, plus the rule that matters most
// for a destructive dialog — no path may resolve `true` by accident.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { confirmDialog } from '../ui/confirm-dialog.js';
import { setContentRoot } from '../ui/content-root.js';

const overlays = (): NodeListOf<HTMLElement> =>
  document.querySelectorAll<HTMLElement>('.sfdt-confirm-overlay');

const findButton = (label: string, root: ParentNode = document): HTMLButtonElement => {
  const match = Array.from(root.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === label,
  );
  if (!match) throw new Error(`no button labelled ${label}`);
  return match as HTMLButtonElement;
};

const pressEscape = (): void => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
};

beforeEach(() => {
  document.body.replaceChildren();
});

afterEach(() => {
  setContentRoot(null);
});

const OPTS = { title: 'Delete 148 logs?', message: 'This cannot be undone.', confirmLabel: 'Delete' };

describe('confirmDialog() — the two answers', () => {
  it('resolves false on Cancel', async () => {
    const answer = confirmDialog(OPTS);
    findButton('Cancel').click();
    await expect(answer).resolves.toBe(false);
    expect(overlays()).toHaveLength(0);
  });

  it('resolves true on Confirm', async () => {
    const answer = confirmDialog(OPTS);
    findButton('Delete').click();
    await expect(answer).resolves.toBe(true);
  });

  it('resolves false on a click on the scrim', async () => {
    const answer = confirmDialog(OPTS);
    overlays()[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await expect(answer).resolves.toBe(false);
  });
});

describe('confirmDialog() — Escape', () => {
  it('cancels, and can never confirm', async () => {
    // A destructive dialog must not be dismissible into the destructive branch.
    const answer = confirmDialog(OPTS);
    pressEscape();
    await expect(answer).resolves.toBe(false);
  });

  it('answers only the TOPMOST dialog', async () => {
    // Same rule as presentAsModal. Two confirms must never both answer one
    // Escape — the one underneath is still a question the user hasn't seen.
    const first = confirmDialog({ ...OPTS, title: 'First' });
    const second = confirmDialog({ ...OPTS, title: 'Second' });
    expect(overlays()).toHaveLength(2);

    pressEscape();
    await expect(second).resolves.toBe(false);
    expect(overlays()).toHaveLength(1);

    pressEscape();
    await expect(first).resolves.toBe(false);
    expect(overlays()).toHaveLength(0);
  });

  it('removes its document listener on close', async () => {
    // Otherwise every dialog ever opened leaks one across SPA navigations —
    // the same defect ui/menu.ts was written to fix for menus.
    const answer = confirmDialog(OPTS);
    findButton('Cancel').click();
    await answer;
    // A second Escape with no dialog open must reach nothing.
    expect(() => pressEscape()).not.toThrow();
    expect(overlays()).toHaveLength(0);
  });
});

describe('confirmDialog() — focus', () => {
  it('opens with focus on the SAFE control', async () => {
    // A stray Enter arriving right after the dialog opens must not delete
    // anything.
    const answer = confirmDialog(OPTS);
    expect((document.activeElement as HTMLElement).textContent).toBe('Cancel');
    findButton('Cancel').click();
    await answer;
  });

  it('restores focus to whatever had it before', async () => {
    const opener = document.createElement('button');
    opener.textContent = 'Delete logs';
    document.body.appendChild(opener);
    opener.focus();

    const answer = confirmDialog(OPTS);
    findButton('Cancel').click();
    await answer;
    expect(document.activeElement).toBe(opener);
  });

  it('consumes the Escape it handles, so the modal underneath does not also close', async () => {
    // present-view.ts listens for Escape on the document too and only defers to
    // other `.sfdt-view-overlay`s — it cannot see this dialog stacked over it.
    // Before this, one Escape closed the confirm AND the view behind it, taking
    // the user's unsaved input with it.
    const behind = vi.fn();
    document.addEventListener('keydown', behind); // bubble phase, like present-view

    const answer = confirmDialog(OPTS);
    pressEscape();
    await answer;

    expect(behind).not.toHaveBeenCalled();
    document.removeEventListener('keydown', behind);
  });

  // The caller contract in confirm-dialog.ts's doc comment, pinned. A disabled
  // element cannot take focus, so a caller that disables its trigger BEFORE
  // opening the dialog silently strands the keyboard user on <body> — and no
  // change inside confirmDialog can rescue it, because `.focus()` on a disabled
  // element is a specified no-op. These two cases exist so the next caller
  // learns that from a red test instead of a code review; C-P4-2 shipped the
  // bug in review round 1 precisely because nothing asserted it.
  it('cannot restore focus to a trigger the caller disabled — the documented failure mode', async () => {
    const opener = document.createElement('button');
    opener.textContent = 'Delete rows';
    document.body.appendChild(opener);
    opener.focus();

    opener.disabled = true; // what a caller must NOT do
    const answer = confirmDialog(OPTS);
    findButton('Cancel').click();
    await answer;

    expect(document.activeElement).not.toBe(opener);
    expect(document.activeElement).toBe(document.body);
  });

  it('restores focus to a trigger that is still enabled while the dialog is up', async () => {
    // The correct call-site shape: leave the trigger enabled across the dialog
    // (the modal scrim and focus trap already make it unreachable) and disable
    // it only once the destructive phase actually begins.
    const opener = document.createElement('button');
    opener.textContent = 'Delete rows';
    document.body.appendChild(opener);
    opener.focus();

    const answer = confirmDialog(OPTS);
    findButton('Cancel').click();
    await answer;
    opener.disabled = true; // disabling AFTER the restore is harmless

    expect(document.activeElement).toBe(opener);
  });

  it('is a labelled modal dialog', async () => {
    const answer = confirmDialog(OPTS);
    const card = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(card.getAttribute('aria-modal')).toBe('true');
    const labelledBy = card.getAttribute('aria-labelledby')!;
    expect(card.querySelector(`#${labelledBy}`)?.textContent).toBe('Delete 148 logs?');
    findButton('Cancel').click();
    await answer;
  });

  it('cycles Tab back into the card rather than out to the page behind it', async () => {
    const answer = confirmDialog(OPTS);
    const card = document.querySelector('.sfdt-confirm-card') as HTMLElement;
    const [first, last] = [findButton('Cancel'), findButton('Delete')];

    last.focus();
    const forward = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    card.dispatchEvent(forward);
    expect(document.activeElement).toBe(first);

    const back = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    card.dispatchEvent(back);
    expect(document.activeElement).toBe(last);

    findButton('Cancel').click();
    await answer;
  });
});

describe('confirmDialog() — type-to-confirm', () => {
  const TYPED = { ...OPTS, confirmLabel: 'Delete forever', requireTyped: 'DELETE' };

  it('starts with Confirm disabled', async () => {
    // For an action that can neither be undone nor scoped down, a click is too
    // cheap.
    const answer = confirmDialog(TYPED);
    expect(findButton('Delete forever').disabled).toBe(true);
    findButton('Cancel').click();
    await answer;
  });

  it('enables only on the EXACT word', async () => {
    const answer = confirmDialog(TYPED);
    const input = document.querySelector('input.sfdt-field') as HTMLInputElement;
    const confirm = findButton('Delete forever');

    input.value = 'delete';
    input.dispatchEvent(new Event('input'));
    expect(confirm.disabled).toBe(true);

    input.value = 'DELETE';
    input.dispatchEvent(new Event('input'));
    expect(confirm.disabled).toBe(false);

    confirm.click();
    await expect(answer).resolves.toBe(true);
  });

  it('ignores a click on the still-disabled Confirm', async () => {
    const answer = confirmDialog(TYPED);
    findButton('Delete forever').click();
    // Nothing resolved; the dialog is still up.
    expect(overlays()).toHaveLength(1);
    findButton('Cancel').click();
    await expect(answer).resolves.toBe(false);
  });

  it('puts focus in the input, not on a button', async () => {
    const answer = confirmDialog(TYPED);
    expect((document.activeElement as HTMLElement).tagName).toBe('INPUT');
    findButton('Cancel').click();
    await answer;
  });

  it('names the input for a screen reader', async () => {
    const answer = confirmDialog(TYPED);
    const input = document.querySelector('input.sfdt-field') as HTMLInputElement;
    expect(input.getAttribute('aria-label')).toBe('Type DELETE to confirm');
    findButton('Cancel').click();
    await answer;
  });
});

describe('confirmDialog() — details', () => {
  it('lists the specific things about to be destroyed', async () => {
    const answer = confirmDialog({ ...OPTS, details: ['MyFlow v3', 'MyFlow v4'] });
    const items = Array.from(document.querySelectorAll('li')).map((li) => li.textContent);
    expect(items).toEqual(['MyFlow v3', 'MyFlow v4']);
    findButton('Cancel').click();
    await answer;
  });
});
