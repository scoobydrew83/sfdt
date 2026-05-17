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

          case 'bridgePing': {
            // Forwarded by content scripts so the HTTP fetch happens in the
            // service worker context, bypassing Chrome's Private Network
            // Access preflight enforcement that blocks HTTPS-page → HTTP-
            // localhost requests. host_permissions for http://127.0.0.1/*
            // gives the service worker permission to make this call.
            const port: number =
              typeof message.port === 'number' && message.port > 0 ? message.port : 7654;
            const url = `http://127.0.0.1:${port}/api/bridge/ping`;
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 1500);
            try {
              const res = await fetch(url, { method: 'GET', signal: controller.signal });
              const body = (await res.json().catch(() => null)) as unknown;
              return { ok: true, body };
            } catch (err) {
              return {
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              };
            } finally {
              clearTimeout(timer);
            }
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
