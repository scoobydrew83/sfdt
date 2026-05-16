import type {
  SfdtRequest,
  SfdtResponse,
  SfdtErrorResponse,
  PingResponseData,
} from '@sfdt/flow-core/bridge-contract';
const DEFAULT_TIMEOUT_MS = 8000;
const DISCOVERY_TIMEOUT_MS = 1000;
export interface BridgeOptions {
  token: string;
  preferredTransport?: 'auto' | 'localhost' | 'native';
  localhostPort?: number;
  nativeHostName?: string;
  fetchImpl?: typeof fetch;
  connectNativeImpl?: typeof chrome.runtime.connectNative;
  sendMessageImpl?: (message: unknown) => Promise<unknown>;
  timeoutMs?: number;
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
interface BridgePingResponse {
  ok: boolean;
  body?: unknown;
  error?: string;
}
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
export interface BridgeClient {
  discover(): Promise<Transport>;
  getServerInfo(): Promise<{
    serverVersion: string;
    transport: 'localhost' | 'native';
    disabledFeatures: readonly string[];
  } | null>;
  send<R extends SfdtRequest>(request: R): Promise<SfdtResponse>;
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
  const sendMessageImpl =
    options.sendMessageImpl ?? ((message: unknown) => chromeRuntimeSendMessage<unknown>(message));
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
        }
        resolve(offlineResponse(request.requestId, `Native host timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      port.onMessage.addListener((msg: SfdtResponse) => {
        clearTimeout(timer);
        try {
          port.disconnect();
        } catch {
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
    const local = await sendOverLocalhost(request);
    if (local.ok) return local;
    const localCode = (local as SfdtErrorResponse).code;
    if (localCode && localCode !== 'BRIDGE_OFFLINE') return local;
    if (!connectNativeImpl) return local;
    return sendOverNative(request);
  }
  async function call<R extends Omit<SfdtRequest, 'requestId'>>(req: R): Promise<SfdtResponse> {
    return send({ ...(req as object), requestId: makeRequestId() } as SfdtRequest);
  }
  async function getServerInfo(): Promise<{
    serverVersion: string;
    transport: 'localhost' | 'native';
    disabledFeatures: readonly string[];
  } | null> {
    try {
      const response = (await sendMessageImpl({
        action: 'bridgePing',
        port,
      })) as BridgePingResponse | null;
      if (response?.ok && response.body && typeof response.body === 'object') {
        const envelope = response.body as { ok?: boolean; data?: PingResponseData };
        if (envelope.ok && envelope.data) {
          return {
            serverVersion: envelope.data.serverVersion,
            transport: envelope.data.transport === 'native' ? 'native' : 'localhost',
            disabledFeatures: envelope.data.disabledFeatures ?? [],
          };
        }
      }
    } catch {
    }
    if (!connectNativeImpl) return null;
    const native = await sendOverNative({ requestId: makeRequestId(), kind: 'ping' } as SfdtRequest);
    if (native.ok) {
      const data = (native as { data?: PingResponseData }).data;
      if (data) {
        return {
          serverVersion: data.serverVersion,
          transport: 'native',
          disabledFeatures: data.disabledFeatures ?? [],
        };
      }
    }
    return null;
  }
  return { discover, getServerInfo, send, call };
}
