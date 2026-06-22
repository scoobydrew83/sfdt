import { defineBackground } from 'wxt/utils/define-background';
import { dedupeOrgs } from '../lib/org-list.js';

// Only the extension's own content scripts may invoke privileged actions.
// chrome.runtime.id is the canonical id of THIS extension at runtime — a
// message from a different extension would carry a different sender.id.
function isSelfSender(sender: chrome.runtime.MessageSender): boolean {
  return typeof sender?.id === 'string' && sender.id === chrome.runtime.id;
}

// `getSidForUrls` calls chrome.cookies.get(), which honours the cookies
// permission and can read sid cookies from ANY host. Lock the API down to
// Salesforce-hosted URLs so an XSS on a non-Salesforce page that somehow
// reached the service worker can't exfiltrate cross-site credentials. The
// allowlist mirrors the manifest's host_permissions and hostname.ts's suffix
// checks.
const SALESFORCE_HOST_SUFFIXES = [
  '.salesforce.com',
  '.salesforce-setup.com',
  '.lightning.force.com',
  '.force.com',
  '.visualforce.com',
] as const;

function isAllowedCookieUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  return isAllowedSalesforceDomain(parsed.hostname.toLowerCase());
}

function isAllowedSalesforceDomain(hostname: string): boolean {
  return SALESFORCE_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}

// Localhost-only — the bridge ping fetch must target 127.0.0.1, and the port
// must be in the unprivileged range. A compromised content script could
// otherwise drive arbitrary loopback port-scans through the service worker.
function clampBridgePort(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > 65535) {
    return 7654;
  }
  return value;
}

export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
      // Sender gate: every privileged action below assumes the caller is one
      // of THIS extension's own content scripts. External messages (including
      // from other extensions via externally_connectable, even though it's not
      // configured) bypass this guard.
      if (!isSelfSender(sender)) {
        return { ok: false, error: 'Forbidden: sender is not this extension' };
      }
      try {
        switch (message?.action) {
          case 'openSettings':
            await chrome.runtime.openOptionsPage();
            return { ok: true };

          case 'getSidForUrls': {
            const rawUrls: unknown = Array.isArray(message.urls) ? message.urls : [];
            const urls = (rawUrls as unknown[]).filter(
              (u): u is string => typeof u === 'string' && isAllowedCookieUrl(u),
            );
            if (!urls.length) {
              return { ok: false, sids: {}, error: 'No allowed Salesforce URLs provided' };
            }

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

          case 'listSalesforceOrgs': {
            // Enumerate sid cookies to discover which orgs the user is logged
            // in to. Same security posture as getSidForUrls: results are
            // filtered to Salesforce-suffixed hosts and we return ONLY org host
            // names — never the cookie values themselves.
            const cookies = await new Promise<chrome.cookies.Cookie[]>((resolve) => {
              chrome.cookies.getAll({ name: 'sid' }, (c) => resolve(c ?? []));
            });
            const orgs = dedupeOrgs(cookies, isAllowedSalesforceDomain);
            return { ok: true, orgs };
          }

          case 'openApp': {
            // Open the standalone Workspace tab, passing the current org so it
            // can target the right session. The org is validated against the
            // Salesforce host allowlist before it ever reaches the URL.
            const org = typeof message.org === 'string' ? message.org : '';
            const safe = org && isAllowedCookieUrl(`https://${org}/`) ? org : '';
            const url =
              chrome.runtime.getURL('app.html') +
              (safe ? `?org=${encodeURIComponent(safe)}` : '');
            await chrome.tabs.create({ url });
            return { ok: true };
          }

          case 'bridgePing': {
            // Forwarded from content scripts so the HTTP fetch runs in the
            // service worker context — Chrome's Private Network Access
            // preflight blocks HTTPS-page → HTTP-localhost requests from
            // content scripts even with host_permissions set.
            const port = clampBridgePort(message.port);
            const url = `http://127.0.0.1:${port}/api/bridge/ping`;
            const attempt = async (): Promise<{ ok: boolean; body?: unknown; error?: string }> => {
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
            };
            // The ping result feeds the feature kill-switch — retry once so a
            // single slow/failed ping doesn't flip feature state. Ping is
            // idempotent (GET), so the retry is safe.
            const first = await attempt();
            if (first.ok) return first;
            await new Promise((resolve) => setTimeout(resolve, 300));
            return attempt();
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

    return true; // Keep the message channel open for the async sendResponse.
  });
});
