// Thin, page-side Salesforce API client. It holds NO sid and makes NO Salesforce
// fetch itself — every REST/Tooling/SOAP call is described and handed to the
// background service worker via the `sfApiFetch` message route (see
// lib/sf-api-proxy.ts + entrypoints/background.ts). The worker reads the sid
// cookie, injects Authorization, does the dual-host fallback + 401 retry, and
// returns only the response *text*. This keeps the sid out of page-adjacent
// memory entirely. As of P0-4 PR2 there are NO exceptions — the Event Streaming
// Monitor's long-poll now runs worker-side too (lib/sf-stream-worker.ts), so no
// page code ever holds a sid.

import { escapeSoql } from './escape.js';
import { SF_API_VERSION } from './api-version.js';
import { SOAP_SID_SENTINEL, type SfApiFetchResponse } from './sf-api-proxy.js';
import { XML } from './xml.js';

const SEND_MESSAGE_TIMEOUT_MS = 5000;

// Lets tests mock messaging without pulling in chrome.runtime / window.location.
export interface MessageBus {
  sendMessage<T = unknown>(message: unknown, timeoutMs?: number): Promise<T | null>;
}

export interface SfApiOptions {
  apiVersion?: string;
  win?: Window;
  messageBus?: MessageBus;
  // Explicit org origin (e.g. "https://acme.lightning.force.com"). App-tab
  // (chrome-extension://) callers set this so the worker can derive candidate
  // hosts; content scripts leave it null and the worker uses the sender origin.
  targetOrigin?: string;
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

type RequestFailure = { baseUrl: string; status: number; errorText: string };

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
  // First arg is a constant literal — operation/endpoint are passed as separate
  // arguments so they are never interpreted as console format-string specifiers.
  console.error(
    '[SFDT] Salesforce request failed:',
    `${operation} ${endpoint}`,
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

function extractFaultString(text: string): string {
  try {
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    return findElementByLocalName(doc, 'faultstring')?.textContent ?? '';
  } catch {
    return '';
  }
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

export class SalesforceApiClient {
  readonly apiVersion: string;
  private readonly win: Window;
  private readonly bus: MessageBus;
  private readonly targetOrigin: string | null;

  constructor(options: SfApiOptions = {}) {
    this.apiVersion = options.apiVersion ?? SF_API_VERSION;
    this.win = options.win ?? window;
    this.bus = options.messageBus ?? defaultMessageBus();
    this.targetOrigin = options.targetOrigin ?? null;
  }

  // The org origin this client is bound to (app-tab callers set it via
  // configureSalesforceApi; content-script callers leave it null and the worker
  // uses the sender origin). Exposed so the streaming Port can tell the worker
  // which org to open the CometD connection against.
  get orgOrigin(): string | null {
    return this.targetOrigin;
  }

  getFlowIdFromUrl(): string | null {
    const params = new URLSearchParams(this.win.location.search);
    return params.get('flowId');
  }

  // Sends a proxied call to the worker and normalises the result:
  //  - bus returns null (timeout / port closed) → no session
  //  - ok:false with no errors → no session (worker couldn't read a sid)
  //  - ok:false with errors → short buildRequestError
  //  - ok:true → the raw response text for the caller to parse
  private async proxyText(
    operation: string,
    endpoint: string,
    message: Record<string, unknown>,
  ): Promise<string> {
    const resp = await this.bus.sendMessage<SfApiFetchResponse>({
      action: 'sfApiFetch',
      targetOrigin: this.targetOrigin ?? undefined,
      ...message,
    });
    if (!resp) throw new Error('No Salesforce session available');
    if (!resp.ok) {
      if (!resp.errors.length) throw new Error('No Salesforce session available');
      throw buildRequestError(operation, endpoint, resp.errors);
    }
    return resp.bodyText;
  }

  async apiGet<T = unknown>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
    if (!endpoint.startsWith('/')) {
      throw new Error(`apiGet: endpoint must start with "/". Got: ${endpoint}`);
    }
    const text = await this.proxyText('GET request', endpoint, {
      kind: 'json',
      method: 'GET',
      endpoint,
      query: params,
      headers: { Accept: 'application/json' },
    });
    return JSON.parse(text) as T;
  }

  // Like apiGet but returns the raw response body as text instead of JSON.
  // Some endpoints serve text/plain — most notably ApexLog/<id>/Body — where
  // JSON.parse would throw.
  async apiGetText(endpoint: string, params: Record<string, string> = {}): Promise<string> {
    if (!endpoint.startsWith('/')) {
      throw new Error(`apiGetText: endpoint must start with "/". Got: ${endpoint}`);
    }
    return this.proxyText('GET request', endpoint, {
      kind: 'text',
      method: 'GET',
      endpoint,
      query: params,
    });
  }

  async apiRequest<T = unknown>(
    method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    endpoint: string,
    body: unknown = null,
  ): Promise<T | null> {
    if (!endpoint.startsWith('/')) {
      throw new Error(`apiRequest: endpoint must start with "/". Got: ${endpoint}`);
    }
    const resp = await this.bus.sendMessage<SfApiFetchResponse>({
      action: 'sfApiFetch',
      kind: 'json',
      method,
      endpoint,
      body: body !== null ? JSON.stringify(body) : undefined,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      targetOrigin: this.targetOrigin ?? undefined,
    });
    if (!resp) throw new Error('No Salesforce session available');
    if (!resp.ok) {
      if (!resp.errors.length) throw new Error('No Salesforce session available');
      throw buildRequestError(`${method} request`, endpoint, resp.errors);
    }
    if (resp.status === 204) return null;
    return resp.bodyText ? (JSON.parse(resp.bodyText) as T) : null;
  }

  apiPatch<T = unknown>(endpoint: string, body: unknown): Promise<T | null> {
    return this.apiRequest<T>('PATCH', endpoint, body);
  }

  async apiSoap<T = unknown>(
    apiName: 'Partner' | 'Metadata' | 'Tooling' | 'Enterprise' | 'Apex',
    method: string,
    args: unknown,
    options: { headers?: Record<string, unknown> } = {},
  ): Promise<T> {
    const wsdls = {
      Enterprise: {
        servicePortAddress: '/services/Soap/c/' + this.apiVersion,
        targetNamespaces:
          ' xmlns="urn:enterprise.soap.sforce.com" xmlns:sf="urn:sobject.enterprise.soap.sforce.com"',
        apiName: 'Enterprise',
      },
      Partner: {
        servicePortAddress: '/services/Soap/u/' + this.apiVersion,
        targetNamespaces:
          ' xmlns="urn:partner.soap.sforce.com" xmlns:sf="urn:sobject.partner.soap.sforce.com"',
        apiName: 'Partner',
      },
      Apex: {
        servicePortAddress: '/services/Soap/s/' + this.apiVersion,
        targetNamespaces: ' xmlns="http://soap.sforce.com/2006/08/apex"',
        apiName: 'Apex',
      },
      Metadata: {
        servicePortAddress: '/services/Soap/m/' + this.apiVersion,
        targetNamespaces: ' xmlns="http://soap.sforce.com/2006/04/metadata"',
        apiName: 'Metadata',
      },
      Tooling: {
        servicePortAddress: '/services/Soap/T/' + this.apiVersion,
        targetNamespaces:
          ' xmlns="urn:tooling.soap.sforce.com" xmlns:sf="urn:sobject.tooling.soap.sforce.com" xmlns:mns="urn:metadata.tooling.soap.sforce.com"',
        apiName: 'Tooling',
      },
    };

    const wsdl = wsdls[apiName];
    const sessionHeaderKey = wsdl.apiName === 'Metadata' ? 'met:SessionHeader' : 'SessionHeader';
    const sessionIdKey = wsdl.apiName === 'Metadata' ? 'met:sessionId' : 'sessionId';
    const requestMethod = wsdl.apiName === 'Metadata' ? `met:${method}` : method;
    const requestAttributes = [
      'xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"',
      'xmlns:xsd="http://www.w3.org/2001/XMLSchema"',
      'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    ];
    if (wsdl.apiName === 'Metadata') {
      requestAttributes.push('xmlns:met="http://soap.sforce.com/2006/04/metadata"');
    }

    // The sessionId carries a sentinel placeholder — the worker swaps it for the
    // real sid inside the SessionHeader before sending. The page never sees it.
    const requestBody = XML.stringify({
      name: 'soapenv:Envelope',
      attributes: ` ${requestAttributes.join(' ')}${wsdl.targetNamespaces}`,
      value: {
        'soapenv:Header': Object.assign(
          {},
          { [sessionHeaderKey]: { [sessionIdKey]: SOAP_SID_SENTINEL } },
          options.headers,
        ),
        'soapenv:Body': { [requestMethod]: args },
      },
    });

    const resp = await this.bus.sendMessage<SfApiFetchResponse>({
      action: 'sfApiFetch',
      kind: 'soap',
      method: 'POST',
      endpoint: `${wsdl.servicePortAddress}?cache=${Math.random()}`,
      headers: {
        'Content-Type': 'text/xml',
        SOAPAction: '""',
        CallOptions: 'client:SalesforceInspectorReloaded',
      },
      body: requestBody,
      soap: { sentinel: SOAP_SID_SENTINEL },
      targetOrigin: this.targetOrigin ?? undefined,
    });

    const soapError = (msgText: string, status: number): Error => {
      const err = new Error(msgText) as Error & { status?: number; detail?: string };
      err.name = 'SalesforceSoapError';
      err.status = status;
      err.detail = msgText;
      return err;
    };

    if (!resp) throw soapError('No Salesforce session available', 0);
    if (!resp.ok) {
      if (!resp.errors.length) throw soapError('No Salesforce session available', 0);
      const primary = resp.errors.find((e) => e.status >= 400 && e.status !== 401) ?? resp.errors[0]!;
      const fault = extractFaultString(primary.errorText);
      const detail = fault || primary.errorText;
      throw soapError(detail || `SOAP error ${primary.status}`, primary.status);
    }

    const doc = new DOMParser().parseFromString(resp.bodyText, 'text/xml');
    const responseBody = findElementByLocalName(doc, method + 'Response');
    if (!responseBody) {
      throw new Error(`Response body missing ${method}Response`);
    }
    return XML.parse(responseBody).result as T;
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
      'Id, Definition.DeveloperName, FullName, Metadata, MasterLabel, Description, ProcessType, Status';

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
let _singletonTargetOrigin: string | null = null;

// Binds the shared singleton to an explicit org origin. The Workspace tab calls
// this once at boot (before any feature registers) so even features that reach
// for getSalesforceApi() directly — bypassing options.api — get an org-bound
// client. Re-callable: the org-switcher invokes it again on org change.
export function configureSalesforceApi(opts: { targetOrigin: string }): void {
  _singletonTargetOrigin = opts.targetOrigin;
  _singleton = new SalesforceApiClient({ targetOrigin: opts.targetOrigin });
}

export function getSalesforceApi(): SalesforceApiClient {
  if (!_singleton) {
    _singleton = new SalesforceApiClient(
      _singletonTargetOrigin ? { targetOrigin: _singletonTargetOrigin } : {},
    );
  }
  return _singleton;
}

export function _resetSalesforceApiSingletonForTests(): void {
  _singleton = null;
  _singletonTargetOrigin = null;
}
