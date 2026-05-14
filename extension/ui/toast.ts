// One shared toast helper. Supersedes the seven near-duplicate _showToast
// implementations across the v2.0.2 extension that the CHANGELOG-v2.0.0.md
// called out at lines 139-145.
//
// Vanilla DOM by design — the toast must work inside any content script,
// including ones that mount before React is available. The CSS lives in
// extension/ui/styles.css (Phase 4 will add it; Phase 3 inlines the bare
// minimum so the side button can show "Initialised" without depending on
// the stylesheet yet).

const TOAST_CONTAINER_ID = 'sfut-toast-container';
const TOAST_BASE_CLASS = 'sfut-toast';

export type ToastKind = 'info' | 'success' | 'warning' | 'error';

export interface ToastOptions {
  kind?: ToastKind;
  durationMs?: number;
  doc?: Document;
}

function ensureContainer(doc: Document): HTMLElement {
  let container = doc.getElementById(TOAST_CONTAINER_ID);
  if (container) return container;
  container = doc.createElement('div');
  container.id = TOAST_CONTAINER_ID;
  // The z-index value of 100010 mirrors the v1.2.3 fix at
  // /Users/dkennedy/dev/2.0.2_0 copy/CHANGELOG-v2.0.0.md:55 — toasts must
  // sit above the Health Modal (100001) but below any browser-native dialog.
  container.style.cssText = [
    'position: fixed',
    'top: 20px',
    'right: 20px',
    'z-index: 100010',
    'display: flex',
    'flex-direction: column',
    'gap: 8px',
    'pointer-events: none',
  ].join('; ');
  doc.body.appendChild(container);
  return container;
}

const KIND_BACKGROUND: Record<ToastKind, string> = {
  info: '#0070d2',
  success: '#04844b',
  warning: '#fe9339',
  error: '#c23934',
};

/**
 * Show a transient toast. Returns a `dismiss()` function so callers can
 * close the toast early (e.g. when a long-running operation finishes).
 */
export function showToast(message: string, options: ToastOptions = {}): () => void {
  const doc = options.doc ?? document;
  const kind = options.kind ?? 'info';
  const durationMs = options.durationMs ?? 3500;

  const container = ensureContainer(doc);
  const toast = doc.createElement('div');
  toast.className = `${TOAST_BASE_CLASS} ${TOAST_BASE_CLASS}--${kind}`;
  toast.setAttribute('role', 'status');
  toast.style.cssText = [
    'background: ' + KIND_BACKGROUND[kind],
    'color: #fff',
    'padding: 10px 14px',
    'border-radius: 4px',
    'box-shadow: 0 2px 6px rgba(0,0,0,0.2)',
    'font-family: system-ui, -apple-system, sans-serif',
    'font-size: 13px',
    'pointer-events: auto',
    'max-width: 360px',
    'word-break: break-word',
  ].join('; ');
  toast.textContent = message;
  container.appendChild(toast);

  let dismissed = false;
  const dismiss = (): void => {
    if (dismissed) return;
    dismissed = true;
    if (toast.parentNode) toast.parentNode.removeChild(toast);
  };
  const timer = setTimeout(dismiss, durationMs);

  return () => {
    clearTimeout(timer);
    dismiss();
  };
}
