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
import {
  buildUserFacingMessage,
  guidanceForErrorCode,
  guidanceForStatus,
} from './sf-error-guidance.js';
import { parseRestErrorDetails, type SalesforceRestErrorDetail } from './sf-error-body.js';
import { SOAP_SID_SENTINEL, type SfApiFetchResponse } from './sf-api-proxy.js';
import { XML } from './xml.js';

// How long we wait for the background worker to answer an `sfApiFetch`.
//
// READ (GET): a read is safe to abandon and safe to retry, so it gets the
// tighter bound — but the old blanket 5s sat *below* the normal duration of
// several reads we actually make (a describe on a large org, a multi-MB
// ApexLog body, a wide SOQL page over a slow link), so it was cutting off
// healthy requests. 30s clears those with margin while still failing fast
// enough to be actionable.
//
// WRITE (POST/PATCH/PUT/DELETE, plus any SOAP call its caller declares
// `mutating`): cutting a write short is the dangerous case — the request may
// already have committed server-side, so an early give-up produces a false
// failure and invites a duplicate retry. The budget is therefore set at the
// platform's own ceiling for the longest synchronous operation these paths
// trigger: Apex's 120s cumulative callout timeout, which bounds an
// `apex-anonymous` run, a Tooling CustomField create, and a Partner-SOAP
// `create`/`upsert` batch from `data-import`. Anything slower than that is
// genuinely wedged, not merely slow.
//
// SOAP is split per call site rather than treated wholesale — see apiSoap.
// A polled `checkDeployStatus` is a read and must not inherit the write
// framing, or "may have committed" stops meaning anything.
const READ_MESSAGE_TIMEOUT_MS = 30_000;
const WRITE_MESSAGE_TIMEOUT_MS = 120_000;

// A bus timeout is NOT "no session" — it means the worker never answered, which
// says nothing about whether a sid exists. The two are reported differently
// (see buildTimeoutError), so the bus signals a timeout by *rejecting* with an
// error carrying this name, and reserves a `null` resolution for "the worker
// answered, with nothing".
export const WORKER_TIMEOUT_ERROR_NAME = 'SfWorkerTimeoutError';

// Constructor for that signal, exported so an alternative MessageBus (or a test
// double) can produce a timeout the client recognises.
export function workerTimeoutError(timeoutMs: number): Error {
  const err = new Error(`Background worker did not respond within ${timeoutMs}ms`);
  err.name = WORKER_TIMEOUT_ERROR_NAME;
  return err;
}

function isWorkerTimeout(err: unknown): boolean {
  return err instanceof Error && err.name === WORKER_TIMEOUT_ERROR_NAME;
}

// ---------------------------------------------------------------------------
// Machine-readable failure kinds
//
// Every error this client throws carries a stable `sfdtKind` discriminant so a
// caller can branch on *why* a call failed without matching on prose. This is
// purely additive — the `message` text of the no-session and HTTP-error cases
// is unchanged, so callers that only render `err.message` keep working.
//
//  'timeout'    — the background worker never answered inside the budget. The
//                 request's outcome is UNKNOWN. When `mutating` is true it may
//                 already have committed server-side; a blind retry can
//                 duplicate it.
//  'no-session' — the worker answered but could not produce a session (no sid
//                 for any candidate host). The request definitely did not run.
//  'http-error' — Salesforce answered with a failing status. `status` carries
//                 it; the request definitely did not succeed.
// ---------------------------------------------------------------------------
export type SfApiErrorKind = 'timeout' | 'no-session' | 'http-error';

// ---------------------------------------------------------------------------
// Structured REST error bodies
//
// The body SHAPE — the record type and its parser — lives in lib/sf-error-body.ts
// because the worker proxy needs the same knowledge and cannot import this file.
// Both are re-exported here so this stays the one public entry point callers
// already import from.
//
// extractErrorDetail() below flattens a rejection to one human string for the
// `.message`; a caller that wants to render an error against the exact field it
// belongs to reads the records off `SalesforceRestError.details` instead.
// ---------------------------------------------------------------------------
export type { SalesforceRestErrorDetail } from './sf-error-body.js';
export { parseRestErrorDetails } from './sf-error-body.js';

export class SalesforceRestError extends Error {
  readonly sfdtKind: SfApiErrorKind = 'http-error';
  readonly status: number;
  readonly details: SalesforceRestErrorDetail[];

  constructor(message: string, status: number, details: SalesforceRestErrorDetail[]) {
    super(message);
    this.name = 'SalesforceRestError';
    this.status = status;
    this.details = details;
  }
}

export interface SfApiError extends Error {
  readonly sfdtKind: SfApiErrorKind;
  // 'timeout' only: the budget that elapsed, and whether the call could have
  // changed data (the pair a caller needs to decide "failed" vs "unknown").
  readonly timeoutMs?: number;
  readonly mutating?: boolean;
  // 'http-error' (and 0 for 'timeout'/'no-session' on the SOAP path).
  readonly status?: number;
}

// Returns the discriminant for an error thrown by this client, or null for
// anything else (a caller's own error, a JSON.parse failure, …).
export function sfApiErrorKind(err: unknown): SfApiErrorKind | null {
  if (!(err instanceof Error)) return null;
  const kind = (err as Partial<SfApiError>).sfdtKind;
  return kind === 'timeout' || kind === 'no-session' || kind === 'http-error' ? kind : null;
}

function tagError<T extends Record<string, unknown>>(err: Error, fields: T): Error {
  Object.assign(err, fields);
  return err;
}

/**
 * True when Chrome has swapped the extension out from under this tab. The
 * orphaned content script keeps running but every `chrome.*` handle is dead;
 * `chrome.runtime.id` going undefined is the standard tell.
 */
function contextInvalidated(): boolean {
  try {
    return typeof chrome !== 'undefined' && !!chrome.runtime && chrome.runtime.id === undefined;
  } catch {
    // Reading through a dead handle can itself throw — that IS the condition.
    return true;
  }
}

// The single constructor for the no-session diagnosis.
//
// A null reply from the worker has two very different causes and they used to
// report identically. "No Salesforce session available" sends you hunting for a
// login problem when the actual fix is to reload the tab — which is exactly the
// wrong direction, because the session is usually fine. The message text for the
// genuine no-session case is byte-identical to what shipped, so existing UI copy
// and tests are unaffected.
function buildNoSessionError(): Error {
  if (contextInvalidated()) {
    return tagError(
      new Error(
        'SFDT was updated while this tab was open, so the page is running an ' +
          'orphaned copy of the extension. Reload the tab — your Salesforce ' +
          'session is unaffected.',
      ),
      { sfdtKind: 'no-session' as const, status: 0, contextInvalidated: true },
    );
  }
  return tagError(new Error('No Salesforce session available'), {
    sfdtKind: 'no-session' as const,
    status: 0,
  });
}

// Lets tests mock messaging without pulling in chrome.runtime / window.location.
// Contract: resolve the worker's reply, resolve `null` when the worker answered
// with nothing (or the port is gone), and REJECT with workerTimeoutError() when
// `timeoutMs` elapses with no answer at all.
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

// Which of the per-host failures do we headline? The one the ORG explained.
//
// A body that parses into Salesforce error records is the org answering the
// request; a bare 401 or 5xx from a fallback host is the transport failing
// around it. Preferring the explained failure is what keeps a real
// MALFORMED_QUERY from being displaced by another host's session error when
// both are reported. INVALID_SESSION_ID is excluded from the first tier for
// exactly that reason — it is the org describing our plumbing, not the user's
// request. The previous "first non-401" rule is kept as the next tier, so
// nothing that used to be chosen stops being chosen.
function pickPrimary(errors: RequestFailure[]): {
  failure: RequestFailure;
  details: SalesforceRestErrorDetail[];
} {
  const parsed = errors.map((failure) => ({
    failure,
    details: parseRestErrorDetails(failure.errorText),
  }));
  return (
    parsed.find((p) => p.details.some((d) => d.errorCode && d.errorCode !== 'INVALID_SESSION_ID')) ??
    parsed.find((p) => p.failure.status >= 400 && p.failure.status !== 401) ??
    parsed[0]!
  );
}

// Multi-host failures log the full per-host breakdown to the console for
// debugging. The thrown Error's message leads with the org's own text —
// unchanged, and never replaced by ours — then adds the errorCode, the field(s)
// the org blamed, and a short "what to do" line where we have one. Callers
// surface err.message directly in toasts and error panels, so enriching it here
// is what puts the guidance in front of the user everywhere at once; the parsed
// records stay on `.details` for callers that render per-field errors.
function buildRequestError(operation: string, endpoint: string, errors: RequestFailure[]): Error {
  const { failure: primary, details } = pickPrimary(errors);
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
  const headline = `Salesforce ${operation} failed (${summary})${detail ? `: ${detail}` : ''}`;
  return new SalesforceRestError(
    buildUserFacingMessage(headline, details, primary.status),
    primary.status,
    details,
  );
}

// A worker that never answered is a different diagnosis from a worker that
// answered "no session", and the two must never share a message: telling a user
// their session is gone when it is fine sends them off to re-authenticate for
// nothing. For a *mutating* call the message additionally refuses to claim the
// operation failed — we did not hear back, so the request may well have
// committed, and a blind retry is how you end up with two records.
function buildTimeoutError(operation: string, timeoutMs: number, mutating: boolean): Error {
  const seconds = Math.round(timeoutMs / 1000);
  const err = new Error(
    mutating
      ? `Salesforce ${operation} timed out after ${seconds}s — the extension's background worker ` +
        `did not answer, so the result is unknown. This is a timeout, not a lost session: the ` +
        `change may already have been saved in Salesforce, so check before retrying to avoid ` +
        `duplicating it.`
      : `Salesforce ${operation} timed out after ${seconds}s — the extension's background worker ` +
        `did not answer. This is a timeout, not a lost session; retry the request.`,
  );
  err.name = 'SfRequestTimeoutError';
  // `sfdtKind: 'timeout'` + `mutating` is the pair a caller branches on to
  // distinguish "definitely failed" from "outcome unknown". `status`/`detail`
  // keep the shape apiSoap's callers already read off its errors.
  return tagError(err, {
    sfdtKind: 'timeout' as const,
    timeoutMs,
    mutating,
    status: 0,
    detail: err.message,
  });
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

// A SOAP fault carries the same vocabulary as a REST errorCode, just in
// <faultcode> and namespace-prefixed: `sf:INVALID_FIELD`. Stripping the prefix
// lets a fault reuse the one guidance table, so a data-import batch or a
// metadata retrieve explains itself the same way a REST call does.
function extractFaultCode(text: string): string {
  try {
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    const raw = findElementByLocalName(doc, 'faultcode')?.textContent ?? '';
    return raw.includes(':') ? raw.slice(raw.lastIndexOf(':') + 1) : raw;
  } catch {
    return '';
  }
}

function defaultMessageBus(): MessageBus {
  return {
    sendMessage(message, timeoutMs = READ_MESSAGE_TIMEOUT_MS) {
      return new Promise((resolve, reject) => {
        let done = false;
        const settle = (settler: () => void): void => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          settler();
        };
        const finish = (value: unknown): void => settle(() => resolve(value as never));
        // Timeout REJECTS (not resolve-null) so the client can tell "the worker
        // never answered" apart from "the worker answered with nothing".
        const timer = setTimeout(() => settle(() => reject(workerTimeoutError(timeoutMs))), timeoutMs);
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

  // Single choke point for every worker round-trip. It applies the read/write
  // timeout budget (the whole point of `mutating`) and translates a bus timeout
  // into a message that says what actually happened, instead of letting it fall
  // through to the `!resp` branch and be misreported as a lost session.
  private async sendProxied<T>(
    message: Record<string, unknown>,
    ctx: { operation: string; mutating: boolean },
  ): Promise<T | null> {
    const timeoutMs = ctx.mutating ? WRITE_MESSAGE_TIMEOUT_MS : READ_MESSAGE_TIMEOUT_MS;
    try {
      return await this.bus.sendMessage<T>(message, timeoutMs);
    } catch (err) {
      if (isWorkerTimeout(err)) throw buildTimeoutError(ctx.operation, timeoutMs, ctx.mutating);
      throw err;
    }
  }

  // Sends a proxied call to the worker and normalises the result:
  //  - bus returns null (worker answered with nothing / port closed) → no session
  //  - ok:false with no errors → no session (worker couldn't read a sid)
  //  - ok:false with errors → short buildRequestError
  //  - ok:true → the raw response text for the caller to parse
  private async proxyText(
    operation: string,
    endpoint: string,
    message: Record<string, unknown>,
  ): Promise<string> {
    const resp = await this.sendProxied<SfApiFetchResponse>(
      {
        action: 'sfApiFetch',
        targetOrigin: this.targetOrigin ?? undefined,
        ...message,
      },
      { operation, mutating: false },
    );
    if (!resp) throw buildNoSessionError();
    if (!resp.ok) {
      if (!resp.errors.length) throw buildNoSessionError();
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
    // Every method that reaches here mutates, so this is always the write budget.
    const resp = await this.sendProxied<SfApiFetchResponse>(
      {
        action: 'sfApiFetch',
        kind: 'json',
        method,
        endpoint,
        body: body !== null ? JSON.stringify(body) : undefined,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        targetOrigin: this.targetOrigin ?? undefined,
      },
      { operation: `${method} request`, mutating: true },
    );
    if (!resp) throw buildNoSessionError();
    if (!resp.ok) {
      if (!resp.errors.length) throw buildNoSessionError();
      throw buildRequestError(`${method} request`, endpoint, resp.errors);
    }
    if (resp.status === 204) return null;
    return resp.bodyText ? (JSON.parse(resp.bodyText) as T) : null;
  }

  apiPatch<T = unknown>(endpoint: string, body: unknown): Promise<T | null> {
    return this.apiRequest<T>('PATCH', endpoint, body);
  }

  // `mutating` declares whether this SOAP operation can change data. Unlike
  // apiRequest — where the HTTP method decides it — SOAP tunnels reads and
  // writes through one POST, so only the caller knows. It selects the timeout
  // budget AND the `mutating` flag on a timeout error, which is the sole signal
  // that says "this may have committed". Declaring a read/poll as mutating is
  // not merely noisy: it makes `sfdtKind === 'timeout' && mutating === true`
  // mean "or a status poll was slow", which destroys the discriminant for the
  // callers that need it.
  //
  // Undeclared defaults to `true` — the safe direction. A new call site that
  // forgets to declare over-warns (a retry the user didn't need to think twice
  // about) rather than under-warns (a duplicate record). soap-explore is the
  // one deliberate user of the default: it sends an arbitrary user-chosen
  // operation, so it genuinely cannot know.
  async apiSoap<T = unknown>(
    apiName: 'Partner' | 'Metadata' | 'Tooling' | 'Enterprise' | 'Apex',
    method: string,
    args: unknown,
    options: { headers?: Record<string, unknown>; mutating?: boolean } = {},
  ): Promise<T> {
    const mutating = options.mutating ?? true;
    // SOAP service paths take a BARE version ("62.0"); only REST paths carry the
    // `v` prefix that SF_API_VERSION ships with. Concatenating apiVersion raw
    // yields /services/Soap/m/v62.0, which SF rejects with
    // "Invalid Api version specified on URL".
    const soapVersion = this.apiVersion.replace(/^v/i, '');
    const wsdls = {
      Enterprise: {
        servicePortAddress: '/services/Soap/c/' + soapVersion,
        targetNamespaces:
          ' xmlns="urn:enterprise.soap.sforce.com" xmlns:sf="urn:sobject.enterprise.soap.sforce.com"',
        apiName: 'Enterprise',
      },
      Partner: {
        servicePortAddress: '/services/Soap/u/' + soapVersion,
        targetNamespaces:
          ' xmlns="urn:partner.soap.sforce.com" xmlns:sf="urn:sobject.partner.soap.sforce.com"',
        apiName: 'Partner',
      },
      Apex: {
        servicePortAddress: '/services/Soap/s/' + soapVersion,
        targetNamespaces: ' xmlns="http://soap.sforce.com/2006/08/apex"',
        apiName: 'Apex',
      },
      Metadata: {
        servicePortAddress: '/services/Soap/m/' + soapVersion,
        targetNamespaces: ' xmlns="http://soap.sforce.com/2006/04/metadata"',
        apiName: 'Metadata',
      },
      Tooling: {
        servicePortAddress: '/services/Soap/T/' + soapVersion,
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

    const resp = await this.sendProxied<SfApiFetchResponse>(
      {
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
      },
      { operation: `${apiName} ${method} SOAP call`, mutating },
    );

    const soapError = (msgText: string, status: number, kind: SfApiErrorKind): Error => {
      const err = new Error(msgText) as Error & { status?: number; detail?: string };
      err.name = 'SalesforceSoapError';
      err.status = status;
      err.detail = msgText;
      return tagError(err, { sfdtKind: kind });
    };

    if (!resp) throw soapError('No Salesforce session available', 0, 'no-session');
    if (!resp.ok) {
      if (!resp.errors.length) throw soapError('No Salesforce session available', 0, 'no-session');
      // Same precedence as the REST path: a host that returned an actual SOAP
      // fault explained the request, so it wins over one that merely 401'd or
      // 5xx'd alongside it.
      const primary =
        resp.errors.find((e) => extractFaultString(e.errorText)) ??
        resp.errors.find((e) => e.status >= 400 && e.status !== 401) ??
        resp.errors[0]!;
      const fault = extractFaultString(primary.errorText);
      const detail = fault || primary.errorText;
      const headline = detail || `SOAP error ${primary.status}`;
      const faultCode = extractFaultCode(primary.errorText);
      // The fault string usually already begins with the code, so only the
      // guidance is appended — never a restatement of what the org just said.
      // An UNRECOGNISED faultcode falls back to the status advice rather than
      // yielding nothing, matching the REST path: not knowing the code is not a
      // reason to leave the user with no next step.
      const advice =
        (faultCode ? guidanceForErrorCode(faultCode) : '') || guidanceForStatus(primary.status);
      throw soapError(advice ? `${headline}\n${advice}` : headline, primary.status, 'http-error');
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
