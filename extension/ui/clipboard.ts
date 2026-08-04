// Copy-to-clipboard with the confirmation and the failure path.
//
// Twenty-one call sites did this by hand, and twelve of them wrote their own
// try/catch + toast pair. The copies were not identical: several omitted the
// catch entirely, so on a page where the Clipboard API is blocked — an iframe
// without the permission, or a non-secure context — the click did nothing at
// all and said nothing about it.
//
// The `win` parameter exists because the Workspace hands features a synthetic
// window; reading `navigator` off the global would reach the wrong one there.

import { showToast } from './toast.js';

export interface CopyOpts {
  /** What was copied, for the success toast: "Copied 12 rows as CSV". */
  label?: string;
  doc?: Document;
  win?: Window;
}

/**
 * Write `text` to the clipboard and tell the user either way.
 *
 * Returns whether it succeeded, for the rare caller that needs to branch —
 * most should ignore it, because the toast is already the feedback.
 */
export async function copyToClipboard(text: string, opts: CopyOpts = {}): Promise<boolean> {
  const doc = opts.doc ?? document;
  const win = opts.win ?? window;
  try {
    await win.navigator.clipboard.writeText(text);
    showToast(opts.label ? `Copied ${opts.label}` : 'Copied to clipboard', {
      doc,
      kind: 'success',
    });
    return true;
  } catch {
    // The label rides on the FAILURE message too, not just the success one:
    // "Could not copy response" tells you which button did nothing, which
    // matters on a view with several. Callers that had a specific failure
    // message before keep it.
    //
    // Deliberately not surfacing the raw DOMException: it is either
    // NotAllowedError or a permissions-policy string, neither of which tells a
    // user anything they can act on.
    showToast(opts.label ? `Could not copy ${opts.label}` : 'Could not copy to clipboard', {
      doc,
      kind: 'error',
    });
    return false;
  }
}
