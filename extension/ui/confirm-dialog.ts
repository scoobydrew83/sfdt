// Destructive-action confirmation.
//
// Two features had grown their own: features/debug-log-viewer.ts ("Delete 148
// logs?") and features/flow-version-manager.ts ("type DELETE to confirm"). They
// had different a11y — the first trapped focus, wired Esc and restored focus on
// close; the second did none of those and had a type-to-confirm gate the first
// lacked. Merging them means both surfaces get the union, which is the actual
// argument for consolidating: the copies were not equally good, and every user
// was getting whichever version their feature happened to have.
//
// Not `presentAsModal`: that is a document surface with a title bar, a close ×
// and a body the feature owns. This is a blocking question with two answers,
// and it must be able to open ON TOP of a presentView modal — which is why it
// carries its own overlay and its own topmost check.

import { button } from '../lib/ui-controls.js';
import { ensureComponentStyles } from '../lib/ui-styles.js';
import { getContentRoot } from './content-root.js';

export interface ConfirmOpts {
  title: string;
  message: string;
  confirmLabel: string;
  /** Extra context under the message — the specific rows about to be destroyed. */
  details?: readonly string[];
  /**
   * Require the user to type this exact string before Confirm enables.
   * For an action that cannot be undone AND cannot be scoped down, a click is
   * too cheap. Omit for an ordinary confirm.
   */
  requireTyped?: string;
  doc?: Document;
}

/**
 * CALLER CONTRACT — do not disable the control that opens this dialog.
 *
 * On close, focus is restored to whatever was focused when the dialog opened,
 * which is normally the button that opened it. A **disabled** element cannot
 * receive focus, so a caller that does
 *
 *     btn.disabled = true;
 *     await confirmDialog({ … });   // restore lands on <body>
 *
 * silently strands the keyboard user on `document.body`, and nothing in here
 * can fix it: `.focus()` on a disabled element is a no-op by specification, so
 * there is no version of this function that can restore focus to one. The fix
 * belongs at the call site — disable the trigger AFTER the dialog resolves, or
 * guard re-entrancy with a flag instead of `disabled`, which is what
 * features/soql-runner.ts's bulk delete does via its `onConfirmed` hook.
 *
 * Guarding re-entrancy with `disabled` during the dialog is redundant anyway:
 * this dialog is modal, mounts a full-viewport scrim over the trigger, and
 * traps Tab inside itself, so the trigger cannot be reached by mouse or
 * keyboard while it is open.
 *
 * `test/confirm-dialog.test.ts` pins both halves of this, so the next caller
 * learns it from a red test rather than from a code review.
 */
export function confirmDialog(opts: ConfirmOpts): Promise<boolean> {
  const doc = opts.doc ?? document;
  ensureComponentStyles(doc);

  return new Promise((resolve) => {
    const previouslyFocused = doc.activeElement as HTMLElement | null;

    const overlay = doc.createElement('div');
    overlay.className = 'sfdt-confirm-overlay';
    // Positioning only — a fixed full-viewport scrim has no component class
    // because nothing else needs one. z-index sits above presentView's 100020
    // so a confirm raised from inside a modal lands on top of it.
    overlay.style.cssText =
      'position: fixed; inset: 0; background: var(--sfdt-color-scrim); z-index: 100025; display: flex; align-items: center; justify-content: center;';

    const card = doc.createElement('div');
    card.className = 'sfdt-card sfdt-stack sfdt-confirm-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    const titleId = `sfdt-confirm-title-${Math.random().toString(36).slice(2)}`;
    card.setAttribute('aria-labelledby', titleId);

    const title = doc.createElement('h2');
    title.id = titleId;
    title.textContent = opts.title;

    const msg = doc.createElement('p');
    // '.sfdt-msg' keeps newlines: a confirm message can carry a wrapped
    // explanation, and the type-to-confirm copy already does.
    msg.className = 'sfdt-muted sfdt-msg';
    msg.textContent = opts.message;

    card.append(title, msg);

    if (opts.details?.length) {
      const list = doc.createElement('ul');
      list.className = 'sfdt-muted';
      for (const line of opts.details) {
        const li = doc.createElement('li');
        li.textContent = line;
        list.appendChild(li);
      }
      card.appendChild(list);
    }

    const confirmBtn = button({
      label: opts.confirmLabel,
      iconName: 'trash',
      variant: 'danger',
      doc,
    });

    let typedInput: HTMLInputElement | null = null;
    if (opts.requireTyped) {
      const word = opts.requireTyped;
      typedInput = doc.createElement('input');
      typedInput.className = 'sfdt-field';
      typedInput.type = 'text';
      typedInput.placeholder = word;
      typedInput.autocomplete = 'off';
      typedInput.setAttribute('aria-label', `Type ${word} to confirm`);
      confirmBtn.disabled = true;
      typedInput.addEventListener('input', () => {
        confirmBtn.disabled = typedInput!.value.trim() !== word;
      });
      typedInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !confirmBtn.disabled) cleanup(true);
      });
      card.appendChild(typedInput);
    }

    const cancelBtn = button({ label: 'Cancel', doc });
    const footer = doc.createElement('div');
    footer.className = 'sfdt-row';
    footer.append(cancelBtn, confirmBtn);
    card.appendChild(footer);

    const onKeydown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      // Topmost-only, same rule as presentAsModal: two confirms should never
      // both answer one Escape.
      const peers = overlay.parentNode?.querySelectorAll('.sfdt-confirm-overlay');
      if (peers?.length && peers[peers.length - 1] !== overlay) return;
      e.preventDefault();
      // Consume it. ui/present-view.ts also listens for Escape on the document
      // and only defers to other `.sfdt-view-overlay`s — it cannot see this
      // dialog stacked above it, so without this an Escape aimed at the confirm
      // ALSO closed the modal underneath, discarding whatever the user had
      // typed into it (in the SOQL runner, their query). ui/menu.ts already
      // does exactly this from the capture phase, and present-view's own
      // comment names that as the reason it never sees a menu's Escape;
      // this dialog simply never did the same.
      e.stopPropagation();
      e.stopImmediatePropagation();
      // Escape is a CANCEL, never a confirm — a destructive dialog must not be
      // dismissible into the destructive branch.
      cleanup(false);
    };
    // Capture phase so Esc fires even when focus sits in a Salesforce widget,
    // and removed on close so it can't leak across SPA navigations.
    doc.addEventListener('keydown', onKeydown, true);

    // Focus trap across every control in the card (two buttons, or three with
    // the type-to-confirm box) so Tab can never reach the page behind it.
    card.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const focusables = Array.from(
        card.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])'),
      );
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (e.shiftKey && doc.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && doc.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });

    function cleanup(result: boolean): void {
      doc.removeEventListener('keydown', onKeydown, true);
      overlay.remove();
      previouslyFocused?.focus?.();
      resolve(result);
    }

    cancelBtn.addEventListener('click', () => cleanup(false));
    confirmBtn.addEventListener('click', () => {
      if (!confirmBtn.disabled) cleanup(true);
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cleanup(false);
    });

    overlay.appendChild(card);
    (getContentRoot() ?? doc.body).appendChild(overlay);
    // Focus lands on the SAFE control, not the destructive one: a stray Enter
    // arriving right after the dialog opens must not delete anything.
    (typedInput ?? cancelBtn).focus();
  });
}
