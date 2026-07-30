// What to do about a Salesforce error, in the user's own terms.
//
// Salesforce's REST errors are already specific and usually name the exact
// field at fault. Historically the extension threw all of that away and showed
// one line, so the rules this module exists to enforce are:
//
//  1. The org's own `message` is rendered IN FULL and is never replaced. Our
//     text is only ever appended beside it.
//  2. An unrecognised `errorCode` is not a licence to fall back to something
//     generic. It renders the org's message and the code verbatim; it just
//     means we have no extra advice to add.
//  3. Nothing here infers a cause. Guidance is keyed off the code the org
//     actually returned — INVALID_SESSION_ID advice can only ever attach to a
//     record the org itself tagged INVALID_SESSION_ID.
//  4. `fields[]` survives. Naming the offending field is most of the value of
//     a Salesforce error, and it is the first thing a one-line summary loses.
//
// Pure string logic, no DOM: every surface that renders an error (toasts, the
// SOQL error panel, data-import's per-row column, the field-creator form) gets
// the same text.

import type { SalesforceRestErrorDetail } from './salesforce-api.js';

// Keyed by the org's errorCode. Each entry is a single "what to do" sentence —
// it must add an action the org's own message does not already state, and must
// never contradict or restate it.
const CODE_GUIDANCE: Readonly<Record<string, string>> = {
  MALFORMED_QUERY:
    'Check the SOQL syntax and the value types in the WHERE clause — text and id values are quoted, but number, boolean and date values must not be.',
  INVALID_FIELD:
    'That field is not on the object, or your user cannot see it. Check the API name (custom fields end in __c) and your field-level security.',
  INVALID_TYPE:
    'That object does not exist, or your user has no access to it. Check the API name (custom objects end in __c) and the object permissions on your profile.',
  INVALID_SESSION_ID:
    'Your Salesforce session is no longer valid. Reload the Salesforce tab, or log in again, then retry.',
  REQUEST_LIMIT_EXCEEDED:
    "The org has spent its rolling 24-hour API request allowance. Wait for the window to roll over, or check Setup › Company Information › 'API Requests, Last 24 Hours'.",
  INSUFFICIENT_ACCESS:
    'Your user does not have access to this record, object or field. Ask an admin to check your profile and permission sets, field-level security, and sharing rules.',
  INSUFFICIENT_ACCESS_OR_READONLY:
    'Your user cannot edit this — it is read-only for you, or the record is locked by an approval process. Check your field-level security and the record’s approval status.',
  INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY:
    'The record is fine, but you lack access to something it points at (a lookup target or its parent). Ask an admin about access to the related record.',
  FIELD_CUSTOM_VALIDATION_EXCEPTION:
    "A validation rule on the object rejected the value — the message above is the rule's own error text, written by your admin.",
  REQUIRED_FIELD_MISSING:
    'A required field was not supplied. Add the field named above to the record (or map a CSV column to it) and retry.',
  DUPLICATE_VALUE:
    'Another record already holds this value in a unique field. Change the value, or update the existing record instead of creating a new one.',
  UNABLE_TO_LOCK_ROW:
    'Another process held the record while this ran. Retry — and if it keeps happening, use a smaller batch size so fewer rows contend for the same parent record.',
  ENTITY_IS_DELETED:
    'The record is in the Recycle Bin. Restore it, or point at a different record.',
  NOT_FOUND:
    'The record or endpoint does not exist, or your user cannot see it. Check the id and the API version in the path.',
  MALFORMED_ID: 'That is not a valid Salesforce id. Ids are 15 or 18 characters.',
  INVALID_CROSS_REFERENCE_KEY:
    'A lookup or picklist value points at something that does not exist. Check the referenced id, or that the picklist value is still active.',
  QUERY_TIMEOUT:
    'The org could not finish the query in time. Add a more selective WHERE clause, filter on an indexed field, or return fewer rows.',
  INVALID_QUERY_LOCATOR:
    'The paging cursor expired. Re-run the query from the start rather than asking for the next page.',
  OPERATION_TOO_LARGE:
    'The query asks for more data than one call can return. Narrow it with a WHERE clause, fewer fields, or a LIMIT.',
  API_DISABLED_FOR_ORG:
    "API access is not enabled for this org or for your user's profile. An admin has to enable it.",
  CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY:
    'A trigger or validation on the object rejected the operation — the message above comes from that code, not from the extension.',
  STRING_TOO_LONG:
    'The value is longer than the field allows. Shorten it, or ask an admin to increase the field length.',
  JSON_PARSER_ERROR:
    'Salesforce could not parse the request body. Check the field names and value types being sent.',
  INVALID_FIELD_FOR_INSERT_UPDATE:
    'That field cannot be written — it is a formula, rollup, autonumber, or otherwise read-only. Remove it from the write.',
};

// Used only when the org gave us NO structured record to key off (an HTML error
// page, an empty body, plain text). Deliberately narrow: it describes what the
// status means and stops short of asserting why.
const STATUS_GUIDANCE: Readonly<Record<number, string>> = {
  0: 'The request never reached Salesforce. Check your network connection and any VPN or proxy.',
  401: 'Salesforce rejected the request as unauthenticated. Reload the Salesforce tab, or log in again, then retry.',
  403: 'Salesforce refused the request. This is usually a permission, an org-level API restriction, or an IP/login-range policy.',
  404: 'Nothing is served at that path. Check the endpoint and the API version.',
  405: 'That HTTP method is not allowed on this endpoint.',
  413: 'The request body is too large for this endpoint. Send it in smaller batches.',
  429: 'Salesforce is rate-limiting the extension. Wait a moment and retry.',
  500: 'Salesforce hit an internal error. Retry — if it persists, the message above is what Salesforce support will want.',
  503: 'Salesforce is unavailable or in maintenance. Retry shortly; check trust.salesforce.com for the instance status.',
};

export function guidanceForErrorCode(errorCode: string): string {
  if (typeof errorCode !== 'string') return '';
  return CODE_GUIDANCE[errorCode.trim().toUpperCase()] ?? '';
}

export function guidanceForStatus(status: number): string {
  return STATUS_GUIDANCE[status] ?? '';
}

// Renders one org error record as "code (field: X) — what to do", or '' when
// there is nothing to add beyond the message itself. The record's `message` is
// NOT included: the caller has already shown it, and repeating it verbatim
// under its own annotation reads as noise.
function annotate(detail: SalesforceRestErrorDetail): string {
  const errorCode = typeof detail?.errorCode === 'string' ? detail.errorCode.trim() : '';
  const fields = Array.isArray(detail?.fields)
    ? detail.fields.filter((f): f is string => typeof f === 'string' && f !== '')
    : [];

  const parts: string[] = [];
  if (errorCode) parts.push(errorCode);
  // The field the org blamed. This is the single most useful thing in a
  // Salesforce error and the first casualty of a one-line summary.
  if (fields.length === 1) parts.push(`field: ${fields[0]}`);
  else if (fields.length > 1) parts.push(`fields: ${fields.join(', ')}`);

  const head = parts.length > 0 ? parts.join(' · ') : '';
  const advice = guidanceForErrorCode(errorCode);
  if (head && advice) return `${head} — ${advice}`;
  return head || advice;
}

// Builds the user-facing message for a failed Salesforce call.
//
// `headline` is the caller's existing one-line summary (unchanged, so anything
// matching on its prefix keeps working). Everything after it is additive: the
// org's remaining records, the codes and fields it named, and our "what to do"
// line where we have one.
//
// Newlines are used rather than a run-on sentence because every surface that
// shows these either pre-wraps or wraps on width; see the `pre-line` on the
// shared toast.
export function buildUserFacingMessage(
  headline: string,
  details: readonly SalesforceRestErrorDetail[] | null | undefined,
  status: number,
): string {
  const records = Array.isArray(details) ? details.filter((d) => d && typeof d === 'object') : [];
  const lines: string[] = [headline];

  if (records.length === 0) {
    // No structured record — say only what the status establishes.
    const advice = guidanceForStatus(status);
    if (advice) lines.push(advice);
    return lines.join('\n');
  }

  const [first, ...rest] = records;
  const firstAnnotation = annotate(first!);
  if (firstAnnotation) lines.push(firstAnnotation);

  // The org can return several records; the headline only ever showed the
  // first. The rest are real errors about the same request and must not be
  // silently dropped.
  for (const record of rest) {
    const message = typeof record.message === 'string' ? record.message : '';
    const annotation = annotate(record);
    if (message) lines.push(`Also: ${message}`);
    if (annotation) lines.push(annotation);
  }

  return lines.join('\n');
}
