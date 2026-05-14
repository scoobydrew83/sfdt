// SPA router.
//
// Salesforce Lightning is a single-page application. The v2.0.2 extension
// detected URL changes at /Users/dkennedy/dev/2.0.2_0 copy/main.js:169-180
// by polling location.href every 500ms. That's wasteful, racy, and burns
// battery on every Lightning page even when the toolkit has nothing to do.
//
// This implementation uses the same primitives Chrome uses internally for
// the omnibox: chrome.webNavigation.onHistoryStateUpdated fires on every
// history.pushState() / replaceState() inside a Salesforce page, scoped to
// the URL patterns the manifest covers. Falls back to a MutationObserver
// when running in a context that doesn't have webNavigation (popup, options,
// jsdom tests).

export type RouteChangeListener = (info: { url: string; previousUrl: string }) => void | Promise<void>;

export interface SpaRouter {
  start(): void;
  stop(): void;
  currentUrl(): string;
  onChange(listener: RouteChangeListener): () => void;
}

const SALESFORCE_HOST_PATTERN =
  /^https:\/\/[^/]+\.(salesforce\.com|salesforce-setup\.com|my\.salesforce\.com|lightning\.force\.com)\//i;

/**
 * Detects Salesforce SPA navigations.
 *
 * Strategy:
 *   1. In the background service worker, listen for
 *      chrome.webNavigation.onHistoryStateUpdated, filtered to Salesforce
 *      origins. Broadcast a custom event to interested tabs.
 *   2. In the content script (this module), subscribe to:
 *        - the custom event from the background (preferred), or
 *        - a MutationObserver on document.body that watches for any change
 *          and re-reads location.href (fallback).
 *
 * Phase 3 ships only the content-script side. The background broadcast
 * lands in Phase 4 when feature ports actually depend on it; until then
 * the MutationObserver is sufficient and matches v2.0.2 behaviour without
 * the 500 ms timer.
 */
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
      // The same trick the v2.0.2 SideButton used at side-button.js:355: any
      // childList mutation on body could mean Lightning swapped a route.
      // Cheap to check the URL string after each batched mutation; expensive
      // ops only happen inside the listener.
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
