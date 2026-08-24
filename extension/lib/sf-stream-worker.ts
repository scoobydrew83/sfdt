// Worker-side Salesforce streaming proxy. Like sf-api-proxy.ts, this is the ONLY
// place the `sid` is joined to the streaming connection — it runs exclusively in
// the background service worker (driven by the `sfApiStream` Port route in
// background.ts). The page-side feature (features/event-monitor.ts) opens a
// long-lived Port, sends subscribe/unsubscribe commands, and receives only
// status + event-payload messages — never the sid.
//
// The Bayeux client itself moved to `@sfdt/flow-core` so `sfdt events tail` uses
// the same protocol implementation rather than a second Node copy. What stays
// here is genuinely Chrome-specific: resolving the sid from cookies, deriving
// the streaming host, and wiring a chrome.runtime.Port.

import { SalesforceBayeuxClient } from '@sfdt/flow-core';
import type { BayeuxMessage } from '@sfdt/flow-core';
import { mySalesforceHostname } from './hostname.js';
import { SF_API_VERSION } from './api-version.js';

// Re-exported so existing importers (and the test suite) keep working unchanged.
export { SalesforceBayeuxClient };
export type { BayeuxMessage };

// --- Port bridge -----------------------------------------------------------

export interface StreamProxyDeps {
  fetchImpl: typeof fetch;
  // Returns the raw `sid` cookie value for a base URL, or null. The caller
  // enforces the Salesforce host allowlist before reading (background.ts wires
  // isAllowedCookieUrl into readSidCookie).
  cookieGet: (url: string) => Promise<string | null>;
  // Origin the Port connected from (sender.origin), already validated against
  // the allowlist. Used when a subscribe command omits targetOrigin.
  senderOrigin?: string | null;
  // Validates a caller-supplied targetOrigin (app-tab callers) against the
  // Salesforce host allowlist. background.ts wires isAllowedCookieUrl here.
  isAllowedOrigin: (url: string) => boolean;
}

// Minimal structural view of a chrome.runtime.Port so this module stays
// unit-testable without the chrome API. chrome.runtime.Port satisfies it.
export interface StreamPort {
  postMessage(message: unknown): void;
  onMessage: { addListener(cb: (message: unknown) => void): void };
  onDisconnect: { addListener(cb: () => void): void };
}

function maybeDecodeSid(sid: string): string {
  try {
    return sid.includes('%') ? decodeURIComponent(sid) : sid;
  } catch {
    return sid;
  }
}

// Mirrors sf-api-proxy.ts deriveBaseUrls: `.my.salesforce.com` first (streaming
// endpoints are reliable there; lightning.force.com often 401s), then the raw
// org origin.
function deriveBaseUrls(originStr: string): string[] {
  const url = new URL(originStr);
  const mySf = mySalesforceHostname(url.hostname);
  const mySfOrigin = mySf ? `https://${mySf}` : null;
  return Array.from(new Set([mySfOrigin, url.origin].filter((v): v is string => !!v)));
}

// Resolves the base URL + sid for a streaming connection. Reads the sid cookie
// worker-side; returns the first candidate host that has one, or null.
export async function resolveStreamSession(
  originStr: string,
  deps: StreamProxyDeps,
): Promise<{ baseUrl: string; sid: string } | null> {
  let baseUrls: string[];
  try {
    baseUrls = deriveBaseUrls(originStr);
  } catch {
    return null;
  }
  for (const baseUrl of baseUrls) {
    const raw = await deps.cookieGet(baseUrl);
    if (raw) return { baseUrl, sid: maybeDecodeSid(raw) };
  }
  return null;
}

interface SubscribeCommand {
  cmd: 'subscribe';
  channelPath: string;
  replayId?: number;
  targetOrigin?: string;
}

// Wires a single sfApiStream Port to a worker-side Bayeux client. The feature
// drives it with {cmd:'subscribe'|'unsubscribe'}; status + event payloads flow
// back as {type:'status'} / {type:'event'}. The sid never crosses the Port.
export function handleStreamPort(port: StreamPort, deps: StreamProxyDeps): void {
  let client: SalesforceBayeuxClient | null = null;
  // Aborts an in-flight subscribe whose async session lookup hasn't resolved
  // yet. Without it, an unsubscribe/onDisconnect that arrives DURING the
  // `await resolveStreamSession(...)` window would run stop() while `client` is
  // still null (a no-op), then the resolved handler would build and start an
  // orphaned, sid-bound long-poll with nothing left holding a reference to stop
  // it. Reset at the start of each fresh subscribe.
  let aborted = false;

  const sendStatus = (status: string, isError = false): void => {
    try {
      port.postMessage({ type: 'status', status, isError });
    } catch {
      // Port already disconnected — nothing to surface.
    }
  };

  const stop = (): void => {
    aborted = true;
    if (client) {
      void client.stop();
      client = null;
    }
  };

  port.onMessage.addListener((raw) => {
    void (async () => {
      if (!raw || typeof raw !== 'object') return;
      const msg = raw as { cmd?: unknown };

      if (msg.cmd === 'unsubscribe') {
        stop();
        return;
      }

      if (msg.cmd !== 'subscribe') return;
      const cmd = raw as SubscribeCommand;
      if (client) return; // Already streaming on this port.
      aborted = false; // Fresh subscribe attempt; clear any prior abort.

      if (typeof cmd.channelPath !== 'string' || !cmd.channelPath) {
        sendStatus('No streaming channel specified.', true);
        return;
      }

      const originStr =
        typeof cmd.targetOrigin === 'string' && deps.isAllowedOrigin(cmd.targetOrigin)
          ? cmd.targetOrigin
          : deps.senderOrigin ?? '';
      if (!originStr) {
        sendStatus('No Salesforce session available.', true);
        return;
      }

      const session = await resolveStreamSession(originStr, deps);
      // Bailed here — an unsubscribe or port disconnect fired while the session
      // lookup was in flight. Do NOT build or start the client (no orphaned
      // long-poll).
      if (aborted) return;
      if (!session) {
        sendStatus('No active Salesforce session found.', true);
        return;
      }

      client = new SalesforceBayeuxClient(
        session.baseUrl,
        session.sid,
        SF_API_VERSION,
        deps.fetchImpl,
      );
      client.onStatus((status, isError) => sendStatus(status, isError));
      client.onMessage((data) => {
        try {
          port.postMessage({ type: 'event', data });
        } catch {
          // Port gone mid-stream — the connect loop will error out and stop.
        }
      });

      void client.start(cmd.channelPath, typeof cmd.replayId === 'number' ? cmd.replayId : -1);
    })();
  });

  // MV3: an active Port + in-flight long-poll keeps the SW alive. On eviction
  // (or tab close / feature teardown) the Port disconnects and we stop the
  // long-poll; the feature surfaces "disconnected" and re-enables Subscribe.
  port.onDisconnect.addListener(stop);
}
