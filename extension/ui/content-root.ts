// The mount target for content-script-injected UI (the ⚡ side button + menu,
// present-view page-mode modals, toasts). On a Salesforce page the content
// script sets this to the closed shadow root's content wrapper (see
// ui/shadow-host.ts + entrypoints/content.ts) so all injected UI is isolated
// from the host page's CSS in both directions (CONVENTIONS.md item 13).
//
// Left null on our own full-page surfaces (the Workspace app + options page),
// where UI renders in light DOM as before — those pages are not injected into a
// hostile document, so they need no shadow boundary. When null, the UI helpers
// fall back to `document.body`, preserving the pre-shadow behaviour (and every
// existing unit test, which never sets a content root).

let contentRoot: ParentNode | null = null;

/** Set (or clear, with null) the shared mount for injected content-script UI. */
export function setContentRoot(root: ParentNode | null): void {
  contentRoot = root;
}

/** The shared injected-UI mount, or null when running on a light-DOM surface. */
export function getContentRoot(): ParentNode | null {
  return contentRoot;
}
