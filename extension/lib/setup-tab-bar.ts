// The Lightning Setup console tab strip (`ul.tabBarItems`) is the shared
// injection point for setup-nav enhancements (custom tabs + the org release
// badge). Both wait for it the same way, so the waiter lives here once.

export function findTabBar(doc: Document): Element | null {
  return doc.querySelector('ul.tabBarItems');
}

/**
 * Resolve the setup tab bar, waiting up to `timeoutMs` for Lightning to render
 * it. Resolves with the element, or null if it never appears within the window.
 */
export function waitForTabBar(doc: Document, timeoutMs = 10_000): Promise<Element | null> {
  const existing = findTabBar(doc);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      const found = findTabBar(doc);
      if (found) {
        observer.disconnect();
        resolve(found);
      }
    });
    observer.observe(doc.body, { childList: true, subtree: true });

    setTimeout(() => {
      observer.disconnect();
      resolve(findTabBar(doc));
    }, timeoutMs);
  });
}
