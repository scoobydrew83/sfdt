// sfdt bridge client.
//
// The client side of the contract defined in
// /Users/dkennedy/dev/sfdt/packages/flow-core/src/bridge-contract.ts. The
// extension uses this to talk to the locally-installed sfdt CLI for any
// operation that can't be done from the browser sandbox alone — running a
// deploy, opening a multi-org compare, calling the AI provider, and so on.
//
// Transport selection at runtime:
//
//   1. preferredTransport === 'localhost' — only try the HTTP server.
//   2. preferredTransport === 'native'    — only try the native messaging host.
//   3. preferredTransport === 'auto'      — race both with a 1 second timeout,
//                                            return the first success.
//
// Either transport's failure mode is the same SfdtResponse error shape, so
// callers don't have to special-case the transport. The `code` field on
// errors lets the UI render distinct states ("Start sfdt ui to enable this
// feature" vs. "Token invalid — re-pair in extension settings").

import type {
  SfdtRequest,
  SfdtResponse,
  SfdtErrorResponse,
} from '@sfdt/flow-core/bridge-contract';

const DEFAULT_TIMEOUT_MS = 8000;
const DISCOVERY_TIMEOUT_MS = 1000;

export interface BridgeOptions {
  token: string;
  preferredTransport?: 'auto' | 'localhost' | 'native';
  localhostPort?: number;
  nativeHostName?: string;
  // Test seams.
  fetchImpl?: typeof fetch;
  connectNativeImpl?: typeof chrome.runtime.connectNative;
  timeoutMs?: number;
}

type Transport = 'localhost' | 'native' | 'unknown';

function makeRequestId(): string {
  // crypto.randomUUID is available in MV3 service workers and content scripts.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `r-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function offlineResponse(requestId: string, message: string): SfdtErrorResponse {
  return { ok: false, requestId, error: message, code: 'BRIDGE_OFFLINE' };
}

export interface BridgeClient {
  /**
   * Cheap probe used to pick a transport. Returns 'localhost' / 'native' /
   * 'unknown' depending on what answered first.
   */
  discover(): Promise<Transport>;

  /**
   * Send a typed request and await its response.
   */
  send<R extends SfdtRequest>(request: R): Promise<SfdtResponse>;

  /**
   * Convenience for one-off requests: stamps the requestId so the caller
   * never has to.
   */
  call<R extends Omit<SfdtRequest, 'requestId'>>(request: R): Promise<SfdtResponse>;
}

export function createBridgeClient(options: BridgeOptions): BridgeClient {
  const token = options.token;
  const preferredTransport = options.preferredTransport ?? 'auto';
  const port = options.localhostPort ?? 7654;
  const nativeHostName = options.nativeHostName ?? 'com.sfdt.host';
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const connectNativeImpl = options.connectNativeImpl;

  async function sendOverLocalhost(request: SfdtRequest): Promise<SfdtResponse> {
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
    const timer = setTimeout(() => controller.abort(), timeoutMs);
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

  async function sendOverNative(request: SfdtRequest): Promise<SfdtResponse> {
    if (!connectNativeImpl) {
      // No connectNative available — happens in test environments and any
      // surface that's not the extension itself.
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
        resolve(offlineResponse(request.requestId, `Native host timed out after ${timeoutMs}ms.`));
      }, timeoutMs);

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
    // auto: race both, fastest success wins.
    const localProbe = sendOverLocalhost({ requestId: 'discover-local', kind: 'ping' } as SfdtRequest);
    const nativeProbe = connectNativeImpl
      ? sendOverNative({ requestId: 'discover-native', kind: 'ping' } as SfdtRequest)
      : Promise.resolve(offlineResponse('discover-native', 'no native messaging'));
    const timeout = new Promise<{ transport: Transport }>((resolve) =>
      setTimeout(() => resolve({ transport: 'unknown' }), DISCOVERY_TIMEOUT_MS),
    );
    return Promise.race<{ transport: Transport }>([
      localProbe.then((r) => ({ transport: (r.ok ? 'localhost' : 'unknown') as Transport })),
      nativeProbe.then((r) => ({ transport: (r.ok ? 'native' : 'unknown') as Transport })),
      timeout,
    ]).then((r) => r.transport);
  }

  async function send(request: SfdtRequest): Promise<SfdtResponse> {
    if (preferredTransport === 'localhost') return sendOverLocalhost(request);
    if (preferredTransport === 'native') return sendOverNative(request);

    // auto: try localhost first, fall back to native on offline error.
    const local = await sendOverLocalhost(request);
    if (local.ok) return local;
    const localCode = (local as SfdtErrorResponse).code;
    // If localhost answered with an auth or invalid-request error, the user's
    // sfdt ui is reachable — fall through to surfacing that error rather than
    // shadowing it with a native-host attempt.
    if (localCode && localCode !== 'BRIDGE_OFFLINE') return local;
    if (!connectNativeImpl) return local;
    return sendOverNative(request);
  }

  async function call<R extends Omit<SfdtRequest, 'requestId'>>(req: R): Promise<SfdtResponse> {
    return send({ ...(req as object), requestId: makeRequestId() } as SfdtRequest);
  }

  return { discover, send, call };
}
