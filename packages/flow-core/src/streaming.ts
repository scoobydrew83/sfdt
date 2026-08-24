// Salesforce streaming (CometD / Bayeux) client.
//
// Handshake → subscribe (with the replay extension) → `/meta/connect`
// long-poll loop → disconnect, with exponential backoff on a dropped
// connection.
//
// ---------------------------------------------------------------------------
// Why this lives in flow-core
// ---------------------------------------------------------------------------
// It was written for the Chrome extension's background worker and moved here
// verbatim so `sfdt events tail` can use the SAME client rather than a second
// Node implementation of the same protocol. Bayeux is a stateful handshake with
// a replay extension and a reconnect policy; two implementations would drift on
// exactly the parts that only show up against a real org.
//
// Nothing here is browser-specific. It uses `fetch`, `AbortController` and
// `setTimeout` — all Node 22 globals — and `fetchImpl` is injected, so the
// worker passes its own and the CLI passes Node's.
//
// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------
// `sessionId` is a bearer token. In the extension it is the `sid` cookie and is
// read in the background worker, never in page code. In the CLI it comes from
// `sf org display` and lives in memory for the life of the command. This module
// holds it in a private field, sends it only as an `Authorization` header to the
// CometD endpoint it was given, and never logs it — the status callback receives
// prose, never the token or the raw response.

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

  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly baseUrl: string,
    private readonly sessionId: string,
    private readonly apiVersion: string,
    fetchImpl: typeof fetch = fetch,
  ) {
    // BOUND TO THE GLOBAL, deliberately.
    //
    // `fetch` is a WebIDL operation with a brand check on its receiver. Stored
    // as a plain property and called as `this.fetchImpl(url)`, the receiver is
    // this client instance, and Chrome throws:
    //
    //   Failed to execute 'fetch' on 'WorkerGlobalScope': Illegal invocation
    //
    // …which is what the Event Streaming Monitor reported. lib/sf-api-proxy.ts
    // never hit it because it calls its copy BARE — `fetchImpl(url)` — where
    // there is no receiver to fail the check. Same value, same worker, two
    // call shapes, one of them broken.
    //
    // Binding here rather than at the call sites means a future `this.fetchImpl`
    // is safe by construction, and a caller passing an unbound `fetch` (both of
    // ours do) cannot reintroduce it.
    this.fetchImpl = fetchImpl.bind(globalThis);
  }

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

// --------------------------------------------------------------------------
// Channel discovery
// --------------------------------------------------------------------------
//
// What can be subscribed to, and what each channel's Bayeux path is. Shared so
// `sfdt events list` and the extension's channel picker enumerate the same
// things — a channel one surface offers and the other does not is a support
// question nobody can answer.
//
// The four kinds are genuinely different queries against different objects, not
// one query with a filter:

/** The kinds of subscribable channel Salesforce exposes. */
export type EventChannelKind =
  | 'platformEvent'
  | 'standardPlatformEvent'
  | 'customChannel'
  | 'changeEvent';

export interface EventChannelQuery {
  soql: string;
  /** `customChannel` and `changeEvent` live on Tooling objects; the others do not. */
  tooling: boolean;
}

/**
 * SOQL for one channel kind.
 *
 * - **platformEvent** — custom events (`__e`). Identified by `KeyPrefix LIKE 'e%'`
 *   rather than a name suffix, because the key prefix is what Salesforce
 *   actually assigns to an event entity.
 * - **standardPlatformEvent** — platform-supplied events, which end in `Event`
 *   but must exclude `ChangeEvent` or every CDC entity would appear twice.
 * - **customChannel** — `PlatformEventChannel`, for channels you defined.
 * - **changeEvent** — the entities enrolled in CDC, via
 *   `PlatformEventChannelMember`. Enrolment is what makes a CDC channel exist;
 *   listing every object instead would offer channels that produce nothing.
 */
export function eventChannelQuery(kind: EventChannelKind): EventChannelQuery {
  switch (kind) {
    case 'standardPlatformEvent':
      return {
        soql:
          "SELECT Label, QualifiedApiName FROM EntityDefinition WHERE IsCustomizable = FALSE" +
          " AND IsEverCreatable = TRUE AND QualifiedApiName LIKE '%Event'" +
          " AND (NOT QualifiedApiName LIKE '%ChangeEvent') ORDER BY Label ASC LIMIT 200",
        tooling: false,
      };
    case 'platformEvent':
      return {
        soql:
          "SELECT QualifiedApiName, Label FROM EntityDefinition WHERE isCustomizable = TRUE" +
          " AND KeyPrefix LIKE 'e%' ORDER BY Label ASC",
        tooling: false,
      };
    case 'customChannel':
      return {
        soql: 'SELECT FullName, MasterLabel FROM PlatformEventChannel ORDER BY DeveloperName',
        tooling: true,
      };
    case 'changeEvent':
      return {
        soql:
          "SELECT MasterLabel, SelectedEntity FROM PlatformEventChannelMember" +
          " WHERE EventChannel = 'ChangeEvents' ORDER BY MasterLabel",
        tooling: true,
      };
  }
}

/**
 * The Bayeux subscription path for a channel name.
 *
 * CDC channels live under `/data/`, everything else under `/event/`. Getting
 * this wrong does not error — the handshake succeeds and the subscription
 * silently receives nothing, which is the worst possible failure for a tail.
 *
 * A name that already looks like a path is passed through, so a caller can name
 * a channel this function does not model (`/data/ChangeEvents`, a custom
 * channel's own path) without being second-guessed.
 */
export function eventChannelPath(name: string): string {
  const trimmed = name.trim();
  if (trimmed.startsWith('/')) return trimmed;
  const isChangeEvent = /ChangeEvent$/.test(trimmed) || trimmed === 'ChangeEvents';
  return `${isChangeEvent ? '/data/' : '/event/'}${trimmed}`;
}

/**
 * Replay values the streaming API defines.
 *
 * `-1` new events only; `-2` every event still in the retention window (24h on
 * most orgs, 72h for high-volume). `-2` is what makes a tail useful for
 * debugging something that already happened.
 */
export const REPLAY_NEW_ONLY = -1;
export const REPLAY_ALL_RETAINED = -2;
