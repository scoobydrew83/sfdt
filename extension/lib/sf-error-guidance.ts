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

import type { SalesforceRestErrorDetail } from './sf-error-body.js';

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
  // Salesforce returns this for TWO different limits: the rolling 24-hour
  // request allowance and the concurrent long-running request cap
  // (ConcurrentPerOrgLongTxn). Naming only the first sends anyone who hit the
  // second to a page showing plenty of headroom, from which the only available
  // conclusion is that the extension is wrong.
  REQUEST_LIMIT_EXCEEDED:
    "The org hit either its rolling 24-hour API request allowance or its cap on concurrent long-running requests. Check Setup › Company Information › 'API Requests, Last 24 Hours' — if that shows headroom, it is the concurrent limit, so let running queries finish and retry.",
  INSUFFICIENT_ACCESS:
    'Your user does not have access to this record, object or field. Ask an admin to check your profile and permission sets, field-level security, and sharing rules.',
  INSUFFICIENT_ACCESS_OR_READONLY:
    'Your user cannot edit this — it is read-only for you, or the record is locked by an approval process. Check your field-level security and the record’s approval status.',
  INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY:
    'The record is fine, but you lack access to something it points at (a lookup target or its parent). Ask an admin about access to the related record.',
  // Apex `addError()` on a field produces this code too, so it must not send
  // anyone hunting through Setup › Validation Rules for a rule that is not
  // there. Kept consistent with CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY below.
  FIELD_CUSTOM_VALIDATION_EXCEPTION:
    'A validation rule or an Apex trigger on the object rejected the value — the message above is that rule or code’s own error text, not the extension’s.',
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
  // The most common status on these paths, so a 400 whose body did not parse
  // (an HTML page from an intermediary, a truncated reply) still gets a next
  // step rather than a bare headline.
  400: 'Salesforce rejected the request as malformed. Check the query or request body — the object and field API names, and the value types.',
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
  const { orgText, notes } = buildUserFacingParts(headline, details, status);
  return [orgText, ...notes].join('\n');
}

/**
 * A composed failure, kept in its parts: what the ORG said, and what WE added.
 *
 * `orgText` may itself be multi-line — an Apex compile error or a stack trace
 * arrives that way — which is exactly why this type exists.
 */
export interface SfErrorParts {
  /** The org's own wording, in full and never ours. */
  orgText: string;
  /** Only what we appended: codes, fields, advice, `Also:` records. */
  notes: string[];
}

/**
 * The same composition as `buildUserFacingMessage`, before it is flattened.
 *
 * The flattening is lossy and cannot be undone by re-reading the string: a
 * first draft of the renderer took line one as the org's text and every line
 * after it as ours, which is right for a single-line org message and WRONG for
 * a multi-line one — it re-labels the org's own continuation lines as our
 * advice and paints them in our colour. That is the PR #308 defect inverted,
 * so the parts travel with the error instead of being guessed at the far end.
 */
export function buildUserFacingParts(
  headline: string,
  details: readonly SalesforceRestErrorDetail[] | null | undefined,
  status: number,
): SfErrorParts {
  const records = Array.isArray(details) ? details.filter((d) => d && typeof d === 'object') : [];
  const notes: string[] = [];

  if (records.length === 0) {
    // No structured record — say only what the status establishes.
    const advice = guidanceForStatus(status);
    if (advice) notes.push(advice);
    return { orgText: headline, notes };
  }

  const [first, ...rest] = records;
  const firstAnnotation = annotate(first!);
  if (firstAnnotation) notes.push(firstAnnotation);

  // The org can return several records; the headline only ever showed the
  // first. The rest are real errors about the same request and must not be
  // silently dropped. They are the ORG's words, but they reach the renderer
  // through this list, so they are prefixed to say so.
  for (const record of rest) {
    const message = typeof record.message === 'string' ? record.message : '';
    const annotation = annotate(record);
    if (message) notes.push(`Also: ${message}`);
    if (annotation) notes.push(annotation);
  }

  return { orgText: headline, notes };
}

/**
 * An error that carried its composition with it rather than joining it away.
 * `SalesforceRestError` implements this; nothing else has to.
 *
 * This is an in-page property, not a wire field: `structuredClone` and
 * `postMessage` do not carry it (they do not carry an Error's own properties at
 * all), so it would be lost by anything crossing the worker boundary. Nothing
 * does today — `buildRequestError` runs page-side, after the proxy has already
 * resolved a plain `SfApiFetchResponse` — but a future move of error
 * construction INTO the worker would silently drop the split and fall back to
 * the flattened `.message`, which renders as one node rather than wrongly.
 */
export interface CarriesUserFacingParts {
  readonly userFacing: SfErrorParts;
}

/**
 * The parts to render for whatever a `catch` caught.
 *
 * When the error carried its composition (every failure raised by
 * `lib/salesforce-api.ts`), the split is exact. When it did not — a plain
 * string, a `TypeError`, a message a feature composed itself — this returns the
 * whole thing as the ORG's text and adds nothing. Guessing where our words
 * start is what produced the mislabelling described on `buildUserFacingParts`;
 * a renderer that declines to guess loses nothing, because the single node it
 * emits is `pre-wrap` and keeps every newline the message already had.
 */
export function sfErrorParts(error: unknown): SfErrorParts {
  const carried = (error as Partial<CarriesUserFacingParts> | null | undefined)?.userFacing;
  if (
    carried &&
    typeof carried === 'object' &&
    typeof carried.orgText === 'string' &&
    Array.isArray(carried.notes)
  ) {
    return {
      orgText: carried.orgText,
      notes: carried.notes.filter((n): n is string => typeof n === 'string' && n.trim() !== ''),
    };
  }
  return { orgText: errorText(error), notes: [] };
}

/**
 * Normalises whatever a `catch` caught into a string.
 *
 * Scope, stated honestly: this is NOT a codebase-wide de-duplication.
 * `err instanceof Error ? err.message : String(err)` is still written out by
 * hand in 46 places across `features/`, `ui/`, `lib/` and `entrypoints/`, and
 * this PR does not touch them — most feed a toast or a status line, not a
 * panel. It exists so the shared error PATH (`sfErrorParts` below, and the one
 * call site that needs a string beside the panel) has a single definition of
 * what a non-`Error` throw looks like on screen. `null`/`undefined` produce
 * nothing rather than the words "null"/"undefined", which is what lets a
 * pre-built, still-empty panel be created with `renderSfError(null)`.
 */
export function errorText(error: unknown): string {
  if (error === null || error === undefined) return '';
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}
