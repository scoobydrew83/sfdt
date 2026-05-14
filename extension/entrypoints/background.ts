// Background service worker.
//
// Ports the message handlers from
// /Users/dkennedy/dev/2.0.2_0 copy/background.js. Phase 3 implements the two
// handlers the shell needs:
//
//   - openSettings   — opens chrome.runtime.openOptionsPage()
//   - getSidForUrls  — reads the HttpOnly Salesforce session cookie via
//                      chrome.cookies, returning a host → sid map
//
// The v2.0.2 handlers for resolveAppDurableId*, fetchExtensionFile, and
// injectXlsxLib are deferred to Phase 4 when the feature modules that need
// them are ported.

import { defineBackground } from 'wxt/utils/define-background';

export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    (async () => {
      try {
        switch (message?.action) {
          case 'openSettings':
            await chrome.runtime.openOptionsPage();
            return { ok: true };

          case 'getSidForUrls': {
            const urls: string[] = Array.isArray(message.urls) ? message.urls : [];
            if (!urls.length) return { ok: false, sids: {}, error: 'No urls provided' };

            const getSid = (url: string): Promise<string | null> =>
              new Promise((resolve) => {
                chrome.cookies.get({ url, name: 'sid' }, (cookie) => {
                  resolve(cookie?.value ?? null);
                });
              });

            const entries = await Promise.all(
              urls.map(async (url) => [url, await getSid(url)] as const),
            );
            return { ok: true, sids: Object.fromEntries(entries) };
          }

          default:
            return { ok: false, error: `Unknown action: ${message?.action}` };
        }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    })()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));

    return true; // Always async — keep the channel open until sendResponse fires.
  });
});
