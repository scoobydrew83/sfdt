import { defineBackground } from 'wxt/utils/define-background';
import { dedupeOrgs } from '../lib/org-list.js';
import { planCommand } from '../lib/commands.js';
import { sfApiFetch } from '../lib/sf-api-proxy.js';
import { createSessionCache } from '../lib/sf-session-cache.js';
import { handleStreamPort } from '../lib/sf-stream-worker.js';
import { loadSettings, onSettingsChange } from '../lib/settings.js';
import { readKillSwitchCache } from '../lib/killswitch-cache.js';
import {
  INSPECT_MENU_ITEM_ID,
  INSPECT_MENU_TITLE,
  INSPECT_MENU_URL_PATTERNS,
  buildInspectMenuMessage,
  isInspectMenuEnabled,
} from '../features/context-menu-inspect.js';

// Per-host session-resolution cache. Backed by chrome.storage.session (NOT
// chrome.storage.local): memory-only, cleared when the browser closes, and at
// its default TRUSTED_CONTEXTS access level invisible to content scripts. It
// stores only the resolved API base URL + org id — never the sid.
const sessionCache = createSessionCache(chrome.storage.session);

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
  // P0-5 host coverage (ledgered): US gov-cloud (GovCloud), China (Alibaba-
  // operated), and Microsoft Defender for Cloud Apps reverse-proxied sessions.
  '.my.salesforce.mil',
  '.lightning.force.mil',
  '.sfcrmapps.cn',
  '.mcas.ms',
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

// The sfApiFetch proxy derives candidate hosts from the caller's org origin. For
// content scripts that's the sender's own page origin; app-tab callers pass it
// explicitly. Either way it's validated against the Salesforce host allowlist
// before it can seed a cookie read.
function resolveSenderOrigin(sender: chrome.runtime.MessageSender): string | null {
  const raw = sender?.origin ?? sender?.tab?.url ?? sender?.url;
  if (typeof raw !== 'string') return null;
  try {
    const { origin } = new URL(raw);
    return isAllowedCookieUrl(origin) ? origin : null;
  } catch {
    return null;
  }
}

// Reads the `sid` cookie for a base URL, enforcing the Salesforce host
// allowlist. Passed into the sfApiFetch proxy so the sid is joined to the
// request only inside the worker — it never crosses back to the page.
function readSidCookie(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (!isAllowedCookieUrl(url)) {
      resolve(null);
      return;
    }
    chrome.cookies.get({ url, name: 'sid' }, (cookie) => resolve(cookie?.value ?? null));
  });
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

// Build the Workspace tab URL, seeded with an org only when it's a valid,
// allowlisted Salesforce host. Shared by the openApp message and the
// open-workspace keyboard command.
function workspaceUrl(org: unknown): string {
  const host = typeof org === 'string' ? org : '';
  const safe = host && isAllowedCookieUrl(`https://${host}/`) ? host : '';
  return chrome.runtime.getURL('app.html') + (safe ? `?org=${encodeURIComponent(safe)}` : '');
}

// Forward a message to the active tab's content script. Used by the popup's
// "Quick menu" button and the open-palette command so tab messaging (and the
// tab lookup) stays in the worker. Best-effort: a tab with no content script
// (e.g. a non-Salesforce page) simply has no receiver.
async function sendToActiveTab(message: { action: string }): Promise<void> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tabs[0]?.id;
  if (typeof tabId !== 'number') return;
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // No content script on the active tab — nothing to open.
  }
}

// P1-8 context menu is gated on the user's opt-in toggle AND the remote
// kill-switch (read from the same cache content.ts writes — no bridge needed
// here). `loadSettings()` memoises per module instance; this worker keeps its
// copy fresh by registering `onSettingsChange` in defineBackground (unlike
// content.ts, the worker otherwise never refreshes it), so a toggle change is
// honoured without a worker restart. `readKillSwitchCache()` reads storage
// directly (uncached), so the kill-switch is always current.
async function inspectMenuEnabled(): Promise<boolean> {
  const [settings, disabledRemote] = await Promise.all([loadSettings(), readKillSwitchCache()]);
  return isInspectMenuEnabled(settings, disabledRemote);
}

// Idempotent: clear our menu item and recreate it only when the feature is on.
// removeAll (rather than remove by id) tolerates a missing item and never
// throws a duplicate-id error on recreate.
async function runInspectMenuSync(): Promise<void> {
  if (!chrome.contextMenus?.create) return;
  const enabled = await inspectMenuEnabled();
  await new Promise<void>((resolve) => chrome.contextMenus.removeAll(() => resolve()));
  if (!enabled) return;
  chrome.contextMenus.create(
    {
      id: INSPECT_MENU_ITEM_ID,
      title: INSPECT_MENU_TITLE,
      // `page` covers a right-click anywhere on a record page (uses the page URL);
      // `link` covers right-clicking a link to a record (uses the link's href).
      contexts: ['page', 'link'],
      documentUrlPatterns: [...INSPECT_MENU_URL_PATTERNS],
      targetUrlPatterns: [...INSPECT_MENU_URL_PATTERNS],
    },
    // A racing removeAll/create from a near-simultaneous trigger can make this
    // create fail (e.g. duplicate id); reading lastError consumes it so it isn't
    // logged as an unchecked runtime error. The coalescing wrapper re-runs to
    // reconcile the final state.
    () => void chrome.runtime.lastError,
  );
}

// Coalesce overlapping triggers (boot + onInstalled + storage.onChanged can
// fire near-simultaneously): only one sync runs at a time; triggers arriving
// mid-run set a flag so exactly one more reconciling run follows.
let syncInFlight: Promise<void> | null = null;
let syncQueued = false;
function syncInspectContextMenu(): Promise<void> {
  if (syncInFlight) {
    syncQueued = true;
    return syncInFlight;
  }
  syncInFlight = (async () => {
    try {
      do {
        syncQueued = false;
        await runInspectMenuSync();
      } while (syncQueued);
    } finally {
      syncInFlight = null;
    }
  })();
  return syncInFlight;
}

export default defineBackground(() => {
  // P1-8 — right-click "Inspect this record". Keep the menu in sync with the
  // feature toggle + kill-switch on boot, on install/update, and whenever
  // storage changes. `onSettingsChange` refreshes THIS worker's memoised
  // settings cache on every write (the fix for the toggle silently not taking
  // effect until a worker restart) and re-syncs; the broad storage listener
  // additionally reacts to the kill-switch cache (a different storage key that
  // onSettingsChange ignores). Overlapping triggers coalesce in
  // syncInspectContextMenu().
  void syncInspectContextMenu();
  chrome.runtime.onInstalled.addListener(() => void syncInspectContextMenu());
  onSettingsChange(() => void syncInspectContextMenu());
  chrome.storage.onChanged.addListener((_changes, namespace) => {
    if (namespace === 'local') void syncInspectContextMenu();
  });

  chrome.contextMenus?.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== INSPECT_MENU_ITEM_ID) return;
    void (async () => {
      // Re-check the gate at click time — the menu could be stale if a toggle
      // change and the click race.
      if (!(await inspectMenuEnabled())) return;
      const inspectMessage = buildInspectMenuMessage({
        linkUrl: info.linkUrl,
        pageUrl: info.pageUrl,
      });
      if (!inspectMessage) return; // No record Id in the URL/link — do nothing (AC2).
      const tabId = tab?.id;
      if (typeof tabId !== 'number') return;
      try {
        await chrome.tabs.sendMessage(tabId, inspectMessage);
      } catch {
        // No content script on the tab (e.g. a not-yet-loaded page) — nothing to open.
      }
    })();
  });

  // Long-lived Port for the Event Streaming Monitor. The CometD/Bayeux
  // long-poll runs entirely in the worker (sf-stream-worker.ts): the sid is
  // read from the cookie here and never crosses back to the page. Only this
  // extension's own content scripts may open the Port.
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'sfApiStream') return;
    if (!port.sender || !isSelfSender(port.sender)) {
      port.disconnect();
      return;
    }
    handleStreamPort(port, {
      fetchImpl: fetch,
      cookieGet: readSidCookie,
      senderOrigin: resolveSenderOrigin(port.sender),
      isAllowedOrigin: isAllowedCookieUrl,
    });
  });

  // Keyboard commands. Registered at the top level of the service worker, so
  // they fire regardless of whether the active tab's content script has settled
  // — the whole point of declared `commands` over per-feature keydown handlers.
  chrome.commands?.onCommand.addListener((command) => {
    void (async () => {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const plan = planCommand(command, tabs[0]);
      switch (plan.kind) {
        case 'open-workspace':
          await chrome.tabs.create({ url: workspaceUrl(plan.org) });
          break;
        case 'message-tab':
          try {
            await chrome.tabs.sendMessage(plan.tabId, plan.message);
          } catch {
            // No content script on the target tab — nothing to do.
          }
          break;
        case 'noop':
          break;
      }
    })();
  });

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

          case 'sfApiFetch': {
            // Salesforce REST/Tooling/SOAP call executed entirely in the worker:
            // the sid is read from the cookie here, injected as Authorization,
            // and only the response *text* is returned. The response NEVER
            // carries a sid. Content scripts omit targetOrigin (we fall back to
            // their validated sender origin); app-tab callers pass it explicitly.
            const targetOrigin =
              typeof message.targetOrigin === 'string' && isAllowedCookieUrl(message.targetOrigin)
                ? message.targetOrigin
                : undefined;
            return sfApiFetch(
              {
                kind: message.kind,
                method: typeof message.method === 'string' ? message.method : 'GET',
                endpoint: message.endpoint,
                query: message.query,
                body: message.body,
                headers: message.headers,
                soap: message.soap,
                targetOrigin,
              },
              {
                fetchImpl: fetch,
                cookieGet: readSidCookie,
                senderOrigin: resolveSenderOrigin(sender),
                cache: sessionCache,
              },
            );
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
            await chrome.tabs.create({ url: workspaceUrl(message.org) });
            return { ok: true };
          }

          case 'openPaletteOnActiveTab': {
            // Fired by the popup's "Quick menu" button — open the ⚡ side menu
            // on the active Salesforce tab.
            await sendToActiveTab({ action: 'openPalette' });
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
