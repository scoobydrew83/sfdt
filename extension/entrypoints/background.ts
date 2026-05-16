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
    return true;
  });
});
