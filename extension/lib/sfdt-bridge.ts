// Client for @sfdt/flow-core/bridge-contract. Both transports return the
// same SfdtResponse error shape — callers branch on response.code, not on
// which transport was used.
//   localhost → HTTP only
//   native    → native messaging host only
//   auto      → race both, fastest success wins (1s timeout)

import type {
  SfdtRequest,
  SfdtResponse,
  SfdtErrorResponse,
  PingResponseData,
  ProtocolNegotiation,
} from '@sfdt/flow-core/bridge-contract';
import { negotiateProtocolVersion } from '@sfdt/flow-core/bridge-contract';
import type { BridgeFailureCategory } from './telemetry.js';

const DEFAULT_TIMEOUT_MS = 8000;
const DISCOVERY_TIMEOUT_MS = 1000;
const RETRY_DELAY_MS = 300;

/** Per-call timeout for bridge operations that run real sf CLI work. */
export const LONG_RUNNING_TIMEOUT_MS = 60000;

// Read-only request kinds per the bridge contract — safe to retry once on a
// transport failure. Mutating kinds (deploy, rollback), cost-incurring kinds
// (ai), and write-on-server kinds (telemetry.snapshot) are deliberately
// excluded: a retry there could double-apply the operation.
const IDEMPOTENT_KINDS: ReadonlySet<string> = new Set([
  'ping',
  'version',
  'quality',
  'drift',
  'scan',
  'compare',
]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Emitted once per failed logical bridge call (after any retry), never per attempt. */
export interface BridgeFailureEvent {
  kind: string;
  category: BridgeFailureCategory;
}

export interface BridgeOptions {
  token: string;
  preferredTransport?: 'auto' | 'localhost' | 'native';
  localhostPort?: number;
  nativeHostName?: string;
  fetchImpl?: typeof fetch;
  connectNativeImpl?: typeof chrome.runtime.connectNative;
  sendMessageImpl?: (message: unknown) => Promise<unknown>;
  timeoutMs?: number;
  /**
   * Fire-and-forget transport-health hook (typically telemetry). Invoked
   * synchronously but never awaited; exceptions are swallowed so it can
   * never alter a bridge call's result. NOT invoked for `telemetry.*`
   * request kinds — telemetry ships through this same bridge, and counting
   * its own failures would feed back on itself.
   */
  onBridgeFailure?: (failure: BridgeFailureEvent) => void;
}

type Transport = 'localhost' | 'native' | 'unknown';

function makeRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `r-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function offlineResponse(requestId: string, message: string): SfdtErrorResponse {
  return { ok: false, requestId, error: message, code: 'BRIDGE_OFFLINE' };
}

// Background-worker bridgePing handler wraps the raw bridge response in
// `{ ok, body }` so transport errors stay distinguishable from bridge-level errors.
interface BridgePingResponse {
  ok: boolean;
  body?: unknown;
  error?: string;
}

// Routes fetches that violate Chrome's Private Network Access policy through
// the service worker, which isn't subject to PNA. Returns null when
// chrome.runtime is unavailable (test environments).
async function chromeRuntimeSendMessage<T>(message: unknown): Promise<T | null> {
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return null;
  return new Promise<T | null>((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response: T) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(response ?? null);
      });
    } catch {
      resolve(null);
    }
  });
}

export interface BridgeCallOptions {
  /** Overrides the client-level timeout for this call only. */
  timeoutMs?: number;
}

export interface BridgeClient {
  discover(): Promise<Transport>;

  /** Returns null when no transport answered. */
  getServerInfo(): Promise<{
    serverVersion: string;
    protocolVersion: string | undefined;
    negotiation: ProtocolNegotiation;
    transport: 'localhost' | 'native';
    disabledFeatures: readonly string[];
  } | null>;

  /** Most recent negotiation result, or null if getServerInfo hasn't run. */
  getNegotiation(): ProtocolNegotiation | null;

  /**
   * Returns BRIDGE_OFFLINE with the negotiation message when a prior
   * getServerInfo detected a major protocol mismatch — ping/version are
   * exempt so diagnostics still flow. Idempotent (read-only) kinds are
   * retried once after a short delay on a transport failure; mutating
   * kinds are never retried.
   */
  send<R extends SfdtRequest>(request: R, options?: BridgeCallOptions): Promise<SfdtResponse>;

  /** Stamps the requestId for the caller. */
  call<R extends Omit<SfdtRequest, 'requestId'>>(
    request: R,
    options?: BridgeCallOptions,
  ): Promise<SfdtResponse>;
}

/**
 * Narrow runtime guard for success-response payloads. The contract types
 * `data` as required on `ok: true`, but the wire gives no such guarantee —
 * older or buggy servers can answer `{ ok: true }` with no data. Returns the
 * payload as a Partial so every property access stays optional, or {} when
 * the response failed or `data` is not an object.
 */
export function getBridgeData<T extends object>(response: SfdtResponse): Partial<T> {
  if (!response.ok) return {};
  const data: unknown = (response as { data?: unknown }).data;
  if (data === null || typeof data !== 'object') return {};
  return data as Partial<T>;
}

export function createBridgeClient(options: BridgeOptions): BridgeClient {
  const token = options.token;
  const preferredTransport = options.preferredTransport ?? 'auto';
  const port = options.localhostPort ?? 7654;
  const nativeHostName = options.nativeHostName ?? 'com.sfdt.host';
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const connectNativeImpl = options.connectNativeImpl;
  const sendMessageImpl =
    options.sendMessageImpl ?? ((message: unknown) => chromeRuntimeSendMessage<unknown>(message));

  // send() short-circuits non-ping/version traffic when the bridge is on
  // an incompatible major version; ping/version stay open for diagnostics.
  let cachedNegotiation: ProtocolNegotiation | null = null;

  function categorizeFailure(response: SfdtErrorResponse): BridgeFailureCategory {
    switch (response.code) {
      case 'BRIDGE_OFFLINE':
        return /timed out|abort/i.test(response.error) ? 'timeout' : 'offline';
      case 'BRIDGE_UNAUTHORIZED':
      case 'BRIDGE_FORBIDDEN':
        return 'unauthorized';
      default:
        return 'other';
    }
  }

  // Fire-and-forget: never awaited, never throws into the caller, and never
  // fires for telemetry's own bridge traffic (recursion guard).
  function emitFailure(kind: string, category: BridgeFailureCategory): void {
    if (!options.onBridgeFailure) return;
    if (kind.startsWith('telemetry')) return;
    try {
      options.onBridgeFailure({ kind, category });
    } catch {
      // The hook must never affect bridge call results.
    }
  }

  async function sendOverLocalhost(
    request: SfdtRequest,
    requestTimeoutMs: number = timeoutMs,
  ): Promise<SfdtResponse> {
    if (!token) {
      return {
        ok: false,
        requestId: request.requestId,
        error: 'Bridge token not configured. Open the extension options page to pair with sfdt.',
        code: 'BRIDGE_UNAUTHORIZED',
      };
    }
    const url = `http://127.0.0.1:${port}/api/bridge/exchange`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
      });
      const body = (await res.json().catch(() => null)) as SfdtResponse | null;
      if (body && typeof body === 'object' && 'ok' in body) return body;
      return offlineResponse(
        request.requestId,
        `Localhost bridge returned an unrecognisable response (HTTP ${res.status}).`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return offlineResponse(request.requestId, `Localhost transport failed: ${msg}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async function sendOverNative(
    request: SfdtRequest,
    requestTimeoutMs: number = timeoutMs,
  ): Promise<SfdtResponse> {
    if (!connectNativeImpl) {
      // Tests and non-extension surfaces lack chrome.runtime.connectNative.
      return offlineResponse(request.requestId, 'Native messaging host is not available in this context.');
    }
    return new Promise<SfdtResponse>((resolve) => {
      let port: chrome.runtime.Port;
      try {
        port = connectNativeImpl(nativeHostName);
      } catch (err) {
        resolve(
          offlineResponse(
            request.requestId,
            `Could not connect to native host: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        return;
      }
      const timer = setTimeout(() => {
        try {
          port.disconnect();
        } catch {
          // ignore
        }
        resolve(
          offlineResponse(request.requestId, `Native host timed out after ${requestTimeoutMs}ms.`),
        );
      }, requestTimeoutMs);

      port.onMessage.addListener((msg: SfdtResponse) => {
        clearTimeout(timer);
        try {
          port.disconnect();
        } catch {
          // ignore
        }
        resolve(msg);
      });
      port.onDisconnect.addListener(() => {
        clearTimeout(timer);
        const err = chrome.runtime.lastError?.message ?? 'native host disconnected';
        resolve(offlineResponse(request.requestId, err));
      });
      try {
        port.postMessage(request);
      } catch (err) {
        clearTimeout(timer);
        resolve(
          offlineResponse(
            request.requestId,
            `Native host postMessage failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    });
  }

  async function discover(): Promise<Transport> {
    if (preferredTransport === 'localhost') {
      const probe = await Promise.race([
        sendOverLocalhost({ requestId: 'discover', kind: 'ping' } as SfdtRequest),
        new Promise<SfdtErrorResponse>((resolve) =>
          setTimeout(
            () => resolve(offlineResponse('discover', 'localhost discovery timed out')),
            DISCOVERY_TIMEOUT_MS,
          ),
        ),
      ]);
      return probe.ok ? 'localhost' : 'unknown';
    }
    if (preferredTransport === 'native') {
      const probe = await sendOverNative({ requestId: 'discover', kind: 'ping' } as SfdtRequest);
      return probe.ok ? 'native' : 'unknown';
    }
    // Auto-discovery: prefer "fastest SUCCESS wins" over "fastest response
    // wins" so a localhost probe that fails fast (BRIDGE_OFFLINE) does not
    // mask a healthy native host that needed a few more ms to respond.
    // Promise.any resolves on the first fulfilment and rejects only when ALL
    // inputs reject — reject within each probe when ok=false so unsuccessful
    // probes don't count as the winner.
    const localProbe: Promise<Transport> = sendOverLocalhost({
      requestId: 'discover-local',
      kind: 'ping',
    } as SfdtRequest).then((r) => {
      if (r.ok) return 'localhost' as Transport;
      throw new Error('localhost probe failed');
    });
    const nativeProbe: Promise<Transport> = connectNativeImpl
      ? sendOverNative({ requestId: 'discover-native', kind: 'ping' } as SfdtRequest).then((r) => {
          if (r.ok) return 'native' as Transport;
          throw new Error('native probe failed');
        })
      : Promise.reject(new Error('no native messaging'));
    const timeout = new Promise<Transport>((_resolve, reject) =>
      setTimeout(() => reject(new Error('discovery timed out')), DISCOVERY_TIMEOUT_MS),
    );
    try {
      return await Promise.any<Transport>([localProbe, nativeProbe, timeout]);
    } catch {
      // All probes rejected — neither transport is reachable.
      return 'unknown';
    }
  }

  async function sendOnce(request: SfdtRequest, requestTimeoutMs: number): Promise<SfdtResponse> {
    if (preferredTransport === 'localhost') return sendOverLocalhost(request, requestTimeoutMs);
    if (preferredTransport === 'native') return sendOverNative(request, requestTimeoutMs);

    const local = await sendOverLocalhost(request, requestTimeoutMs);
    if (local.ok) return local;
    const localCode = (local as SfdtErrorResponse).code;
    // Any non-offline error means sfdt ui IS reachable — surface that error
    // rather than shadowing it with a native-host attempt.
    if (localCode && localCode !== 'BRIDGE_OFFLINE') return local;
    if (!connectNativeImpl) return local;
    return sendOverNative(request, requestTimeoutMs);
  }

  async function send(
    request: SfdtRequest,
    callOptions?: BridgeCallOptions,
  ): Promise<SfdtResponse> {
    // Major protocol mismatch → refuse non-diagnostic traffic.
    if (
      cachedNegotiation &&
      !cachedNegotiation.ok &&
      request.kind !== 'ping' &&
      request.kind !== 'version'
    ) {
      emitFailure(request.kind, 'protocol');
      return {
        ok: false,
        requestId: request.requestId,
        error: `Bridge protocol negotiation failed: ${cachedNegotiation.message}`,
        code: 'BRIDGE_OFFLINE',
      };
    }

    const requestTimeoutMs = callOptions?.timeoutMs ?? timeoutMs;
    const final = await sendWithRetry(request, requestTimeoutMs);
    // One failure event per logical send(), emitted after the retry (if any)
    // resolved — never one per attempt.
    if (!final.ok) emitFailure(request.kind, categorizeFailure(final as SfdtErrorResponse));
    return final;
  }

  async function sendWithRetry(
    request: SfdtRequest,
    requestTimeoutMs: number,
  ): Promise<SfdtResponse> {
    const first = await sendOnce(request, requestTimeoutMs);
    if (first.ok) return first;
    // One retry, idempotent kinds only, and only for transport-level failures
    // (timeout / network) — BRIDGE_UNAUTHORIZED etc. won't fix themselves.
    if (!IDEMPOTENT_KINDS.has(request.kind)) return first;
    if ((first as SfdtErrorResponse).code !== 'BRIDGE_OFFLINE') return first;
    await sleep(RETRY_DELAY_MS);
    return sendOnce(request, requestTimeoutMs);
  }

  async function call<R extends Omit<SfdtRequest, 'requestId'>>(
    req: R,
    callOptions?: BridgeCallOptions,
  ): Promise<SfdtResponse> {
    return send({ ...(req as object), requestId: makeRequestId() } as SfdtRequest, callOptions);
  }

  async function getServerInfo(): Promise<{
    serverVersion: string;
    protocolVersion: string | undefined;
    negotiation: ProtocolNegotiation;
    transport: 'localhost' | 'native';
    disabledFeatures: readonly string[];
  } | null> {
    // Route through the service worker — Chrome's PNA blocks
    // HTTPS-content-script → http://127.0.0.1 without server-side preflight;
    // the worker isn't subject to PNA. /api/bridge/ping is also unauthenticated
    // by design so the kill-switch works without a token.
    try {
      const response = (await sendMessageImpl({
        action: 'bridgePing',
        port,
      })) as BridgePingResponse | null;
      if (response?.ok && response.body && typeof response.body === 'object') {
        const envelope = response.body as { ok?: boolean; data?: PingResponseData };
        if (envelope.ok && envelope.data) {
          const negotiation = negotiateProtocolVersion(envelope.data.protocolVersion);
          cachedNegotiation = negotiation;
          return {
            serverVersion: envelope.data.serverVersion,
            protocolVersion: envelope.data.protocolVersion,
            negotiation,
            transport: envelope.data.transport === 'native' ? 'native' : 'localhost',
            disabledFeatures: envelope.data.disabledFeatures ?? [],
          };
        }
      }
    } catch {
      // fall through to native or null
    }
    if (!connectNativeImpl) {
      emitFailure('ping', 'offline');
      return null;
    }
    const native = await sendOverNative({ requestId: makeRequestId(), kind: 'ping' } as SfdtRequest);
    if (native.ok) {
      const data = (native as { data?: PingResponseData }).data;
      if (data) {
        const negotiation = negotiateProtocolVersion(data.protocolVersion);
        cachedNegotiation = negotiation;
        return {
          serverVersion: data.serverVersion,
          protocolVersion: data.protocolVersion,
          negotiation,
          transport: 'native',
          disabledFeatures: data.disabledFeatures ?? [],
        };
      }
    }
    emitFailure('ping', 'offline');
    return null;
  }

  function getNegotiation(): ProtocolNegotiation | null {
    return cachedNegotiation;
  }

  return { discover, getServerInfo, getNegotiation, send, call };
}
