// HttpOnly `sid` cookies are unreachable from a content script — the
// background service worker holds the `cookies` permission and is queried
// via chrome.runtime.sendMessage. Two candidate hostnames are tried in
// priority order: <org>.my.salesforce.com (REST/Tooling reliable) then the
// page origin (Lightning often 401s on REST). A 401 on every candidate
// clears the session cache and retries once.

import { escapeSoql } from './escape.js';
import { mySalesforceHostname } from './hostname.js';
import { XML } from './xml.js';


const DEFAULT_API_VERSION = 'v62.0';
const SEND_MESSAGE_TIMEOUT_MS = 5000;

// Lets tests mock messaging without pulling in chrome.runtime / window.location.
export interface MessageBus {
  sendMessage<T = unknown>(message: unknown, timeoutMs?: number): Promise<T | null>;
}

export interface SfApiOptions {
  apiVersion?: string;
  win?: Window;
  messageBus?: MessageBus;
  // Custom fetch only used in tests.
  fetchImpl?: typeof fetch;
}

// REST query() returns `totalSize`; Tooling toolingQuery() returns `size`.
// Optional on both so a single shape covers both endpoints.
export interface QueryEnvelope<T = unknown> {
  records: T[];
  done: boolean;
  totalSize?: number;
  size?: number;
  nextRecordsUrl?: string;
}

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

interface SessionCandidate {
  baseUrl: string;
  sid: string;
}

interface Session {
  candidates: SessionCandidate[];
}

interface RequestFailure {
  baseUrl: string;
  status: number;
  errorText: string;
}

// Salesforce REST error bodies are usually JSON like
// [{"message":"...","errorCode":"..."}]; pull out the human-readable message
// so user-facing errors stay short instead of dumping raw JSON.
function extractErrorDetail(errorText: string): string {
  if (!errorText) return '';
  try {
    const parsed = JSON.parse(errorText) as unknown;
    const first = Array.isArray(parsed) ? (parsed[0] as unknown) : parsed;
    if (
      first &&
      typeof first === 'object' &&
      'message' in first &&
      typeof (first as { message: unknown }).message === 'string'
    ) {
      return (first as { message: string }).message;
    }
  } catch {
    // not JSON — fall through to the raw text
  }
  return errorText.length > 200 ? `${errorText.slice(0, 200)}…` : errorText;
}

// Multi-host failures log the full per-host breakdown to the console for
// debugging; the thrown Error stays short because callers surface
// err.message directly in user-facing toasts and error panels.
function buildRequestError(operation: string, endpoint: string, errors: RequestFailure[]): Error {
  const primary = errors.find((e) => e.status >= 400 && e.status !== 401) ?? errors[0]!;
  console.error(
    `[SFDT] Salesforce ${operation} ${endpoint} failed:`,
    errors
      .map((e) => `${e.baseUrl} -> ${e.status || 'network error'}${e.errorText ? ` (${e.errorText})` : ''}`)
      .join('; '),
  );
  const detail = extractErrorDetail(primary.errorText);
  const summary = primary.status > 0 ? `HTTP ${primary.status}` : 'network error';
  return new Error(`Salesforce ${operation} failed (${summary})${detail ? `: ${detail}` : ''}`);
}

// SOAP responses may namespace-prefix every element (<soapenv:Envelope>
// wrapping <ns:queryResponse xmlns:ns="...">). CSS selectors cannot express
// namespace prefixes, so match on localName instead of querySelector().
function findElementByLocalName(doc: Document, localName: string): Element | null {
  for (const el of Array.from(doc.getElementsByTagName('*'))) {
    if (el.localName === localName) return el;
  }
  return null;
}

function defaultMessageBus(): MessageBus {
  return {
    sendMessage(message, timeoutMs = SEND_MESSAGE_TIMEOUT_MS) {
      return new Promise((resolve) => {
        let done = false;
        const finish = (value: unknown): void => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(value as never);
        };
        const timer = setTimeout(() => finish(null), timeoutMs);
        try {
          chrome.runtime.sendMessage(message, (resp) => {
            if (chrome.runtime.lastError) {
              finish(null);
              return;
            }
            finish(resp ?? null);
          });
        } catch {
          finish(null);
        }
      });
    },
  };
}

function maybeDecodeSid(sid: string): string {
  try {
    return sid.includes('%') ? decodeURIComponent(sid) : sid;
  } catch {
    return sid;
  }
}

export class SalesforceApiClient {
  readonly apiVersion: string;
  private readonly win: Window;
  private readonly bus: MessageBus;
  private readonly fetchImpl: typeof fetch;
  private session: Session | null = null;

  constructor(options: SfApiOptions = {}) {
    this.apiVersion = options.apiVersion ?? DEFAULT_API_VERSION;
    this.win = options.win ?? window;
    this.bus = options.messageBus ?? defaultMessageBus();
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  clearSession(): void {
    this.session = null;
  }

  getFlowIdFromUrl(): string | null {
    const params = new URLSearchParams(this.win.location.search);
    return params.get('flowId');
  }

  private async getSession(): Promise<Session | null> {
    if (this.session?.candidates.length) return this.session;

    const hostname = this.win.location.hostname;
    const currentOrigin = this.win.location.origin;
    const mySf = mySalesforceHostname(hostname);
    const mySfOrigin = mySf ? `https://${mySf}` : null;

    // `.my.salesforce.com` first — REST/Tooling reliable. lightning.force.com often 401s.
    const baseUrls = Array.from(new Set([mySfOrigin, currentOrigin].filter((v): v is string => !!v)));

    const response = await this.bus.sendMessage<{
      ok: boolean;
      sids?: Record<string, string | null>;
    }>({ action: 'getSidForUrls', urls: baseUrls });
    if (!response?.ok) return null;
    const sidMap = response.sids ?? {};

    const candidates: SessionCandidate[] = [];
    for (const baseUrl of baseUrls) {
      const sid = sidMap[baseUrl];
      if (sid) candidates.push({ baseUrl, sid: maybeDecodeSid(sid) });
    }
    if (candidates.length === 0) return null;

    this.session = { candidates };
    return this.session;
  }

  async getSessionDetails(): Promise<{ baseUrl: string; sid: string } | null> {
    const session = await this.getSession();
    if (!session || !session.candidates.length) return null;
    return session.candidates[0]!;
  }

  async apiGet<T = unknown>(
    endpoint: string,
    params: Record<string, string> = {},
    options: { retryOn401?: boolean } = {},
  ): Promise<T> {
    if (!endpoint.startsWith('/')) {
      throw new Error(`apiGet: endpoint must start with "/". Got: ${endpoint}`);
    }
    const retryOn401 = options.retryOn401 ?? true;
    const session = await this.getSession();
    if (!session) throw new Error('No Salesforce session available');

    const queryString =
      Object.keys(params).length > 0 ? `?${new URLSearchParams(params).toString()}` : '';
    const errors: RequestFailure[] = [];

    for (const { baseUrl, sid } of session.candidates) {
      try {
        const res = await this.fetchImpl(`${baseUrl}${endpoint}${queryString}`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${sid}`, Accept: 'application/json' },
        });
        if (res.ok) return (await res.json()) as T;
        const errorText = await res.text().catch(() => '');
        errors.push({ baseUrl, status: res.status, errorText });
      } catch (err) {
        errors.push({
          baseUrl,
          status: 0,
          errorText: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const hasNon401 = errors.some((e) => e.status >= 400 && e.status !== 401);
    if (retryOn401 && errors.some((e) => e.status === 401) && !hasNon401) {
      this.clearSession();
      return this.apiGet<T>(endpoint, params, { retryOn401: false });
    }

    throw buildRequestError('GET request', endpoint, errors);
  }

  async apiRequest<T = unknown>(
    method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    endpoint: string,
    body: unknown = null,
    options: { retryOn401?: boolean } = {},
  ): Promise<T | null> {
    if (!endpoint.startsWith('/')) {
      throw new Error(`apiRequest: endpoint must start with "/". Got: ${endpoint}`);
    }
    const retryOn401 = options.retryOn401 ?? true;
    const session = await this.getSession();
    if (!session) throw new Error('No Salesforce session available');

    const errors: RequestFailure[] = [];

    for (const { baseUrl, sid } of session.candidates) {
      try {
        const res = await this.fetchImpl(`${baseUrl}${endpoint}`, {
          method,
          headers: {
            Authorization: `Bearer ${sid}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: body !== null ? JSON.stringify(body) : undefined,
        });
        if (res.ok) {
          if (res.status === 204) return null;
          const text = await res.text();
          return text ? (JSON.parse(text) as T) : null;
        }
        const errorText = await res.text().catch(() => '');
        errors.push({ baseUrl, status: res.status, errorText });
      } catch (err) {
        errors.push({
          baseUrl,
          status: 0,
          errorText: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const hasNon401 = errors.some((e) => e.status >= 400 && e.status !== 401);
    if (retryOn401 && errors.some((e) => e.status === 401) && !hasNon401) {
      this.clearSession();
      return this.apiRequest<T>(method, endpoint, body, { retryOn401: false });
    }

    throw buildRequestError(`${method} request`, endpoint, errors);
  }

  apiPatch<T = unknown>(endpoint: string, body: unknown): Promise<T | null> {
    return this.apiRequest<T>('PATCH', endpoint, body);
  }

  async apiSoap<T = unknown>(
    apiName: 'Partner' | 'Metadata' | 'Tooling' | 'Enterprise' | 'Apex',
    method: string,
    args: unknown,
    options: { retryOn401?: boolean; headers?: Record<string, unknown> } = {},
  ): Promise<T> {
    const retryOn401 = options.retryOn401 ?? true;
    const session = await this.getSession();
    if (!session) throw new Error('No Salesforce session available');

    const wsdls = {
      Enterprise: {
        servicePortAddress: "/services/Soap/c/" + this.apiVersion,
        targetNamespaces: ' xmlns="urn:enterprise.soap.sforce.com" xmlns:sf="urn:sobject.enterprise.soap.sforce.com"',
        apiName: "Enterprise"
      },
      Partner: {
        servicePortAddress: "/services/Soap/u/" + this.apiVersion,
        targetNamespaces: ' xmlns="urn:partner.soap.sforce.com" xmlns:sf="urn:sobject.partner.soap.sforce.com"',
        apiName: "Partner"
      },
      Apex: {
        servicePortAddress: "/services/Soap/s/" + this.apiVersion,
        targetNamespaces: ' xmlns="http://soap.sforce.com/2006/08/apex"',
        apiName: "Apex"
      },
      Metadata: {
        servicePortAddress: "/services/Soap/m/" + this.apiVersion,
        targetNamespaces: ' xmlns="http://soap.sforce.com/2006/04/metadata"',
        apiName: "Metadata"
      },
      Tooling: {
        servicePortAddress: "/services/Soap/T/" + this.apiVersion,
        targetNamespaces: ' xmlns="urn:tooling.soap.sforce.com" xmlns:sf="urn:sobject.tooling.soap.sforce.com" xmlns:mns="urn:metadata.tooling.soap.sforce.com"',
        apiName: "Tooling"
      }
    };

    const wsdl = wsdls[apiName];
    const errors: RequestFailure[] = [];

    for (const { baseUrl, sid } of session.candidates) {
      try {
        const sessionHeaderKey = wsdl.apiName === "Metadata" ? "met:SessionHeader" : "SessionHeader";
        const sessionIdKey = wsdl.apiName === "Metadata" ? "met:sessionId" : "sessionId";
        const requestMethod = wsdl.apiName === "Metadata" ? `met:${method}` : method;
        const requestAttributes = [
          'xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"',
          'xmlns:xsd="http://www.w3.org/2001/XMLSchema"',
          'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
        ];
        if (wsdl.apiName === "Metadata") {
          requestAttributes.push('xmlns:met="http://soap.sforce.com/2006/04/metadata"');
        }

        const requestBody = XML.stringify({
          name: "soapenv:Envelope",
          attributes: ` ${requestAttributes.join(" ")}${wsdl.targetNamespaces}`,
          value: {
            "soapenv:Header": Object.assign({}, { [sessionHeaderKey]: { [sessionIdKey]: sid } }, options.headers),
            "soapenv:Body": { [requestMethod]: args }
          }
        });

        const res = await this.fetchImpl(`${baseUrl}${wsdl.servicePortAddress}?cache=${Math.random()}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'text/xml',
            'SOAPAction': '""',
            'CallOptions': 'client:SalesforceInspectorReloaded'
          },
          body: requestBody
        });

        if (res.ok) {
          const text = await res.text();
          const doc = new DOMParser().parseFromString(text, "text/xml");
          const responseBody = findElementByLocalName(doc, method + "Response");
          if (!responseBody) {
            throw new Error(`Response body missing ${method}Response`);
          }
          const parsed = XML.parse(responseBody).result;
          return parsed as T;
        }

        const errorText = await res.text().catch(() => '');
        let faultString = '';
        try {
          const doc = new DOMParser().parseFromString(errorText, "text/xml");
          faultString = findElementByLocalName(doc, "faultstring")?.textContent ?? '';
        } catch {}
        errors.push({ baseUrl, status: res.status, errorText: faultString || errorText });
      } catch (err) {
        errors.push({
          baseUrl,
          status: 0,
          errorText: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const has401 = errors.some((e) => e.status === 401);
    const hasNon401 = errors.some((e) => e.status >= 400 && e.status !== 401);
    if (retryOn401 && has401 && !hasNon401) {
      this.clearSession();
      return this.apiSoap<T>(apiName, method, args, { retryOn401: false, headers: options.headers });
    }

    const primary = errors.find((e) => e.status >= 400 && e.status !== 401) ?? errors[0]!;
    const err = new Error(primary.errorText || `SOAP error ${primary.status}`) as Error & {
      status?: number;
      detail?: string;
    };
    err.name = "SalesforceSoapError";
    err.status = primary.status;
    err.detail = primary.errorText;
    throw err;
  }


  toolingQuery<T = unknown>(soql: string): Promise<{ records: T[]; size: number; done: boolean }> {
    return this.apiGet(`/services/data/${this.apiVersion}/tooling/query`, { q: soql });
  }

  query<T = unknown>(soql: string): Promise<QueryEnvelope<T>> {
    return this.apiGet(`/services/data/${this.apiVersion}/query`, { q: soql });
  }

  // nextRecordsUrl is a fully-formed path like /services/data/v62.0/query/01gxx-2000;
  // pass it straight to apiGet without re-prepending the api version.
  queryMore<T = unknown>(nextRecordsUrl: string): Promise<QueryEnvelope<T>> {
    return this.apiGet(nextRecordsUrl);
  }

  limits(): Promise<Record<string, { Max: number; Remaining: number }>> {
    return this.apiGet(`/services/data/${this.apiVersion}/limits/`);
  }

  // Method-agnostic passthrough for the REST Explorer. Composes on top of
  // apiGet/apiRequest so the dual-host fallback + 401 retry stay in play.
  rawRequest(method: HttpMethod, endpoint: string, body?: unknown): Promise<unknown> {
    if (method === 'GET') return this.apiGet(endpoint);
    return this.apiRequest(method, endpoint, body ?? null);
  }

  // Flow Builder's `?flowId=` uses two shapes:
  //   1. Salesforce Id (15/18 chars) — try DefinitionId first (URL usually
  //      gives the DefinitionId), fall back to Id for version-id callers.
  //   2. Managed-package developer-name path `<namespace>__<devname>-<version>`
  //      (e.g. `runtime_appointmentbooking__AddAttnd-1`). Look up via
  //      Definition.DeveloperName + Definition.NamespacePrefix.
  async getFlowMetadata(flowId: string): Promise<Record<string, unknown>> {
    const COMMON_FIELDS =
      "Id, Definition.DeveloperName, FullName, Metadata, MasterLabel, Description, ProcessType, Status";

    if (/^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(flowId)) {
      const byDefinition = await this.toolingQuery<Record<string, unknown>>(
        `SELECT ${COMMON_FIELDS} FROM Flow WHERE DefinitionId = '${flowId}' ORDER BY VersionNumber DESC LIMIT 1`,
      );
      if (byDefinition.records.length > 0) return byDefinition.records[0]!;

      const byId = await this.toolingQuery<Record<string, unknown>>(
        `SELECT ${COMMON_FIELDS} FROM Flow WHERE Id = '${flowId}' LIMIT 1`,
      );
      if (byId.records.length > 0) return byId.records[0]!;

      throw new Error(`No flow found for ID: ${flowId}`);
    }

    // The trailing `-<digit>` is sometimes a version, sometimes a draft/runtime
    // suffix — don't filter on it; just grab the latest matching version.
    const stripped = flowId.replace(/-\d+$/, '');
    const namespaceMatch = stripped.match(/^(.+?)__(.+)$/);
    const namespace = namespaceMatch ? namespaceMatch[1]! : '';
    const developerName = namespaceMatch ? namespaceMatch[2]! : stripped;

    const escDev = escapeSoql(developerName);
    const escNs = escapeSoql(namespace);
    const nsClause = namespace
      ? ` AND Definition.NamespacePrefix = '${escNs}'`
      : ` AND Definition.NamespacePrefix = null`;

    const result = await this.toolingQuery<Record<string, unknown>>(
      `SELECT ${COMMON_FIELDS} FROM Flow WHERE Definition.DeveloperName = '${escDev}'${nsClause} ORDER BY VersionNumber DESC LIMIT 1`,
    );
    if (result.records.length > 0) return result.records[0]!;

    // Last-ditch fallback for unusual managed-package URLs: drop the namespace filter.
    if (namespace) {
      const fallback = await this.toolingQuery<Record<string, unknown>>(
        `SELECT ${COMMON_FIELDS} FROM Flow WHERE Definition.DeveloperName = '${escDev}' ORDER BY VersionNumber DESC LIMIT 1`,
      );
      if (fallback.records.length > 0) return fallback.records[0]!;
    }

    throw new Error(
      `No flow found for: ${flowId}. ` +
        `Some managed-package or runtime flows (like the runtime_appointmentbooking_* family) ` +
        `aren't queryable via the Tooling API — try one of your own flows.`,
    );
  }
}

let _singleton: SalesforceApiClient | null = null;
export function getSalesforceApi(): SalesforceApiClient {
  if (!_singleton) _singleton = new SalesforceApiClient();
  return _singleton;
}

export function _resetSalesforceApiSingletonForTests(): void {
  _singleton = null;
}
