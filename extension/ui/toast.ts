// Vanilla DOM by design — must work in content scripts that mount before
// React is available. CSS is inlined so the toast renders without depending
// on extension/ui/styles.css.

const TOAST_CONTAINER_ID = 'sfdt-toast-container';
const TOAST_BASE_CLASS = 'sfdt-toast';

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
  // z-index 100030: above presentView modals (100020, ui/present-view.ts) so a
  // toast fired while a modal is open stays visible on top of its backdrop.
  // Kept below browser-native dialogs.
  container.style.cssText = [
    'position: fixed',
    'top: 20px',
    'right: 20px',
    'z-index: 100030',
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

// Returns a dismiss() so callers can close the toast early.
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
