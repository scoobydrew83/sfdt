// Worker-side Salesforce streaming (CometD/Bayeux) proxy. Like sf-api-proxy.ts,
// this is the ONLY place the `sid` is joined to the streaming connection — it
// runs exclusively in the background service worker (driven by the `sfApiStream`
// Port route in background.ts). The page-side feature (features/event-monitor.ts)
// opens a long-lived Port, sends subscribe/unsubscribe commands, and receives
// only status + event-payload messages — never the sid.
//
// The SalesforceBayeuxClient (handshake / subscribe / /meta/connect long-poll /
// backoff) moved here verbatim from event-monitor.ts as part of P0-4 PR2.

import { mySalesforceHostname } from './hostname.js';
import { SF_API_VERSION } from './api-version.js';

// Bayeux/CometD `ext` field — this client only uses the Salesforce replay
// extension (replayId per channel), but servers may echo arbitrary keys.
interface BayeuxExt {
  replay?: Record<string, number>;
  [key: string]: unknown;
}

export interface BayeuxMessage {
  channel: string;
  clientId?: string;
  version?: string;
  minimumVersion?: string;
  supportedConnectionTypes?: string[];
  connectionType?: string;
  subscription?: string;
  ext?: BayeuxExt;
  id?: string;
  // Event payload shape depends entirely on the subscribed channel; consumers
  // must narrow before use.
  data?: unknown;
  successful?: boolean;
  error?: string;
}

export class SalesforceBayeuxClient {
  private clientId = '';
  private isConnected = false;
  private abortController: AbortController | null = null;
  private messageListener: ((message: unknown) => void) | null = null;
  private statusListener: ((status: string, isError: boolean) => void) | null = null;
  private connectAttempts = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly sessionId: string,
    private readonly apiVersion: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  onMessage(callback: (message: unknown) => void): void {
    this.messageListener = callback;
  }

  onStatus(callback: (status: string, isError: boolean) => void): void {
    this.statusListener = callback;
  }

  private logStatus(status: string, isError = false): void {
    if (this.statusListener) {
      this.statusListener(status, isError);
    }
  }

  async start(channelPath: string, replayId: number): Promise<void> {
    if (this.isConnected) return;
    this.isConnected = true;
    this.connectAttempts = 0;
    this.abortController = new AbortController();

    try {
      this.logStatus('Initiating handshake...');
      const endpoint = `${this.baseUrl}/cometd/${this.apiVersion.replace(/^v/, '')}`;

      // 1. Handshake
      const handshakePayload: BayeuxMessage[] = [
        {
          version: '1.0',
          minimumVersion: '0.9',
          channel: '/meta/handshake',
          supportedConnectionTypes: ['long-polling'],
        },
      ];

      const handshakeRes = await this.post<BayeuxMessage[]>(endpoint, handshakePayload);
      const handshakeData = handshakeRes[0];
      if (!handshakeData || !handshakeData.successful || !handshakeData.clientId) {
        throw new Error(handshakeData?.error || 'Handshake failed');
      }

      this.clientId = handshakeData.clientId;
      this.logStatus('Handshake successful. Subscribing...');

      // 2. Subscribe
      const subscribePayload: BayeuxMessage[] = [
        {
          channel: '/meta/subscribe',
          clientId: this.clientId,
          subscription: channelPath,
          ext: {
            replay: {
              [channelPath]: replayId,
            },
          },
        },
      ];

      const subscribeRes = await this.post<BayeuxMessage[]>(endpoint, subscribePayload);
      const subscribeData = subscribeRes[0];
      if (!subscribeData || !subscribeData.successful) {
        throw new Error(subscribeData?.error || 'Subscription failed');
      }

      this.logStatus(`Listening on ${channelPath}...`);

      // 3. Connect Loop
      void this.connectLoop(endpoint, channelPath);

    } catch (err) {
      this.isConnected = false;
      const message = err instanceof Error ? err.message : String(err);
      this.logStatus(`Connection failed: ${message}`, true);
    }
  }

  private async connectLoop(endpoint: string, channelPath: string): Promise<void> {
    while (this.isConnected) {
      try {
        const connectPayload: BayeuxMessage[] = [
          {
            channel: '/meta/connect',
            clientId: this.clientId,
            connectionType: 'long-polling',
          },
        ];

        const messages = await this.post<BayeuxMessage[]>(endpoint, connectPayload);
        this.connectAttempts = 0;

        for (const msg of messages) {
          if (msg.channel === channelPath && msg.data) {
            if (this.messageListener) {
              this.messageListener(msg.data);
            }
          }
          if (msg.channel === '/meta/connect' && msg.successful === false) {
            this.logStatus(`Connection lost: ${msg.error || 'Unknown error'}`, true);
            void this.stop();
            return;
          }
        }
      } catch (err) {
        if ((err instanceof Error && err.name === 'AbortError') || !this.isConnected) {
          break;
        }
        this.connectAttempts++;
        const message = err instanceof Error ? err.message : String(err);
        this.logStatus(`Connection error (attempt ${this.connectAttempts}): ${message}`, true);

        // Exponential backoff up to 30 seconds
        const delay = Math.min(30000, 1000 * Math.pow(2, this.connectAttempts));
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.isConnected) return;
    this.isConnected = false;
    this.abortController?.abort();

    try {
      const endpoint = `${this.baseUrl}/cometd/${this.apiVersion.replace(/^v/, '')}`;
      const disconnectPayload: BayeuxMessage[] = [
        {
          channel: '/meta/disconnect',
          clientId: this.clientId,
        },
      ];
      await this.post<BayeuxMessage[]>(endpoint, disconnectPayload).catch(() => {});
    } finally {
      this.logStatus('Disconnected');
    }
  }

  private async post<T>(url: string, body: BayeuxMessage[]): Promise<T> {
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.sessionId}`,
      },
      body: JSON.stringify(body),
      signal: this.abortController?.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP Error ${response.status}: ${response.statusText}`);
    }

    return (await response.json()) as T;
  }
}

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

  const sendStatus = (status: string, isError = false): void => {
    try {
      port.postMessage({ type: 'status', status, isError });
    } catch {
      // Port already disconnected — nothing to surface.
    }
  };

  const stop = (): void => {
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
