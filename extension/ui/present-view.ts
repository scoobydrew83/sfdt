// Shared view presenter. A feature builds its `body` (and optional `footer`)
// and hands it to `presentView()`, which places it in one of two ways:
//
//   • On a Salesforce page (content script) — a centered modal overlay, matching
//     the long-standing look. Clicking the backdrop closes it.
//   • In the Workspace tab — the body is mounted into a persistent tab pane via
//     a registered "sink"; there is NO backdrop and NO click-outside dismiss, so
//     a stray click can never discard the user's work. The tab chrome (title + ×)
//     is supplied by the Workspace, so the in-card header is omitted there.
//
// Features call the same `presentView()` either way and never branch on context.

export interface PresentOpts {
  /** Title shown in the modal header (page) or the tab chip (workspace). */
  title: string;
  /** The feature's content. It owns its own padding/scroll (flex:1 expected). */
  body: HTMLElement;
  /** Optional action bar pinned below the body. */
  footer?: HTMLElement;
  /** Called when the view is closed (modal dismissed or tab closed). */
  onClose?: () => void;
  /** Modal card width (page mode only). Default 860px. */
  width?: string;
  /** Document to build in (defaults to the global document). */
  doc?: Document;
}

export interface ViewHandle {
  /** Close the view (remove the modal, or close the workspace tab). */
  close(): void;
  /** The element the body/footer were mounted into (card in page, pane in workspace). */
  root: HTMLElement;
}

export type ViewSink = (opts: PresentOpts) => ViewHandle;

let workspaceSink: ViewSink | null = null;

/** The Workspace registers a sink so features render into tab panes, not modals. */
export function setWorkspaceViewSink(sink: ViewSink | null): void {
  workspaceSink = sink;
}

/** True when running inside the Workspace tab (a sink is registered). */
export function inWorkspace(): boolean {
  return workspaceSink !== null;
}

/** Present a feature view — workspace tab pane if available, else a modal. */
export function presentView(opts: PresentOpts): ViewHandle {
  if (workspaceSink) return workspaceSink(opts);
  return presentAsModal(opts);
}

/** Build the classic centered modal overlay. Exported for the page context and tests. */
export function presentAsModal(opts: PresentOpts): ViewHandle {
  const doc = opts.doc ?? document;
  const card = doc.createElement('div');
  card.style.cssText = `background: var(--sfdt-color-surface); border-radius: 4px; width: ${opts.width ?? '860px'}; max-width: 95vw; max-height: 90vh; display: flex; flex-direction: column;`;

  let overlay: HTMLDivElement | null = doc.createElement('div');
  overlay.className = 'sfdt-view-overlay';
  overlay.style.cssText =
    'position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 100020; display: flex; align-items: center; justify-content: center; font-family: system-ui, sans-serif;';

  const close = (): void => {
    if (!overlay) return;
    overlay.remove();
    overlay = null;
    opts.onClose?.();
  };
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  const header = doc.createElement('div');
  header.style.cssText =
    'padding: 12px 16px; border-bottom: 1px solid var(--sfdt-color-border); display: flex; justify-content: space-between; align-items: center; font-weight: 600;';
  const label = doc.createElement('span');
  label.textContent = opts.title;
  const closeBtn = doc.createElement('button');
  closeBtn.textContent = '×';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.style.cssText = 'background: none; border: 0; font-size: 22px; cursor: pointer; color: inherit;';
  closeBtn.addEventListener('click', close);
  header.append(label, closeBtn);

  card.append(header, opts.body);
  if (opts.footer) card.append(opts.footer);
  overlay.appendChild(card);
  doc.body.appendChild(overlay);

  return { close, root: card };
}
