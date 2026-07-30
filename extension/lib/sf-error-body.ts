// The shape of a Salesforce error body, and nothing else.
//
// This lives on its own because BOTH sides of the worker boundary need it and
// they cannot import each other. The worker proxy (lib/sf-api-proxy.ts) needs to
// ask "did the ORG produce this body, or did something in front of it?" before
// deciding whether a failure is the org's final answer; the page-side client
// (lib/salesforce-api.ts) needs to parse the same body into records for display.
// salesforce-api.ts already imports sf-api-proxy.ts, so putting the parser in
// either would mean a runtime cycle — and the worker bundle must not pull in the
// page-side client to answer a question about a string.
//
// Deliberately DOM-free: MV3 service workers have no DOMParser, which is why the
// SOAP check here is a text probe and the real fault EXTRACTION stays in
// salesforce-api.ts where a DOM exists.

// A Salesforce REST rejection body is an array of records like
//   [{ "message": "…", "errorCode": "FIELD_CUSTOM_VALIDATION_EXCEPTION",
//      "fields": ["Foo__c"] }]
// and `fields` is the only thing that says *which field* the org rejected.
export interface SalesforceRestErrorDetail {
  message: string;
  // '' when the body did not carry one — never undefined, so a consumer can
  // render it without a null check.
  errorCode: string;
  // Field API names the org attributed the failure to. Empty for object-level
  // failures (validation rules with no field binding, row locks, trigger
  // addError() on the record itself).
  fields: string[];
}

function toErrorDetail(entry: unknown): SalesforceRestErrorDetail | null {
  if (!entry || typeof entry !== 'object') return null;
  const rec = entry as Record<string, unknown>;
  if (typeof rec.message !== 'string') return null;
  return {
    message: rec.message,
    errorCode: typeof rec.errorCode === 'string' ? rec.errorCode : '',
    fields: Array.isArray(rec.fields) ? rec.fields.filter((f): f is string => typeof f === 'string') : [],
  };
}

// Parses a REST rejection body into its records. Returns [] for anything that
// is not the documented shape (HTML error pages, empty bodies, plain text) —
// the caller falls back to `.message`, which is unaffected.
export function parseRestErrorDetails(errorText: string): SalesforceRestErrorDetail[] {
  if (!errorText) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(errorText);
  } catch {
    return [];
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const details: SalesforceRestErrorDetail[] = [];
  for (const entry of entries) {
    const detail = toErrorDetail(entry);
    if (detail) details.push(detail);
  }
  return details;
}

// A SOAP fault, detected without a DOM. This is a PROBE, not a parser: it only
// answers "is this Salesforce's own fault document?" so the proxy can classify
// the failure. Namespace prefixes vary (<soapenv:Fault>, <faultstring>,
// <sf:faultcode>), so match on the local name.
const SOAP_FAULT_PATTERN = /<(?:\w+:)?fault(?:string|code)\b/i;

export function looksLikeSoapFault(errorText: string): boolean {
  return !!errorText && SOAP_FAULT_PATTERN.test(errorText);
}

// Did SALESFORCE produce this error body, or did something in front of it?
//
// This is the question that decides whether a failing response is the org's
// final answer on the request. A body that parses into Salesforce error records
// — or that is a SOAP fault — came from the org. An HTML block page from a
// corporate proxy, a CDN's 404, an empty body: those are intermediaries, and
// they say nothing about whether the org would have accepted the request.
//
// Status codes cannot answer this. A 403 is `MALFORMED_QUERY`-adjacent when
// Salesforce sends it and a WAF block when zScaler does, and the two want
// opposite handling.
export function isSalesforceErrorBody(errorText: string): boolean {
  return parseRestErrorDetails(errorText).length > 0 || looksLikeSoapFault(errorText);
}
