export type RouteChangeListener = (info: { url: string; previousUrl: string }) => void | Promise<void>;
export interface SpaRouter {
  start(): void;
  stop(): void;
  currentUrl(): string;
  onChange(listener: RouteChangeListener): () => void;
}
const SALESFORCE_HOST_PATTERN =
  /^https:\/\/[^/]+\.(salesforce\.com|salesforce-setup\.com|my\.salesforce\.com|lightning\.force\.com)\
export function createSpaRouter(options: {
  doc?: Document;
  win?: Window;
  shouldHandle?: (url: string) => boolean;
} = {}): SpaRouter {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  const shouldHandle = options.shouldHandle ?? ((url: string) => SALESFORCE_HOST_PATTERN.test(url));
  const listeners = new Set<RouteChangeListener>();
  let observer: MutationObserver | null = null;
  let lastUrl = win.location.href;
  let started = false;
  function fire(url: string): void {
    if (url === lastUrl) return;
    const previousUrl = lastUrl;
    lastUrl = url;
    if (!shouldHandle(url)) return;
    for (const listener of listeners) {
      try {
        const result = listener({ url, previousUrl });
        if (result && typeof (result as Promise<void>).then === 'function') {
          (result as Promise<void>).catch((err) => {
            console.warn('[SFUT spa-router] listener rejected:', err);
          });
        }
      } catch (err) {
        console.warn('[SFUT spa-router] listener threw:', err);
      }
    }
  }
  return {
    start() {
      if (started) return;
      started = true;
      lastUrl = win.location.href;
      observer = new MutationObserver(() => {
        const url = win.location.href;
        if (url !== lastUrl) fire(url);
      });
      observer.observe(doc.body, { childList: true, subtree: true });
    },
    stop() {
      if (!started) return;
      started = false;
      observer?.disconnect();
      observer = null;
    },
    currentUrl() {
      return win.location.href;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
