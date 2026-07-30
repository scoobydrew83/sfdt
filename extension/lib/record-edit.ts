// Pure editability model for record edit / clone (P4-1, PR-1).
//
// No DOM, no chrome.*, no I/O — every function here is a total function of its
// arguments. The UI layers (inspect-record's edit mode in PR-2, the clone form
// in PR-3) render what these decide; the *decisions* all live here so there is
// exactly one answer to "may this field be written", "what goes on the wire",
// and "what changed".
//
// The design rule (mini-plan decision 4): a field is editable in v1 iff the DOM
// offers a native, lossless control for it AND the wire format is unambiguous.
// Everything else is read-only *with a stated reason* — never silently dropped
// from the view. Only the payload is filtered.
//
// See docs/design/record-edit-clone.md.

import type { FieldDescribe } from './describe-cache.js';
import type { SalesforceRestErrorDetail } from './salesforce-api.js';

// ---------------------------------------------------------------------------
// Editable type set
// ---------------------------------------------------------------------------

// Describe `type` values that get a native control in v1. `multipicklist` and
// `time` are here because the rule above puts them here, not because an AC
// enumerated them — a principle that never changes an answer is not a
// principle. Deliberately absent: richtext/`htmlFormatted` textareas (would
// need sanitised HTML editing), compound `address`/`location` (the parent is
// not writable the way its components are), `encryptedstring` (the value we
// read is masked, writing it back corrupts data), `base64`, and
// `combobox`/`anytype`/`json` (ambiguous wire format).
export const EDITABLE_TYPES = [
  'boolean',
  'string',
  'textarea',
  'email',
  'phone',
  'url',
  'int',
  'double',
  'long',
  'currency',
  'percent',
  'date',
  'datetime',
  'time',
  'picklist',
  'multipicklist',
  'reference',
] as const;

export type EditableType = (typeof EDITABLE_TYPES)[number];

const EDITABLE_TYPE_SET: ReadonlySet<string> = new Set<string>(EDITABLE_TYPES);

const NUMERIC_TYPES: ReadonlySet<string> = new Set(['int', 'double', 'long', 'currency', 'percent']);

export function isEditableType(type: string): type is EditableType {
  return EDITABLE_TYPE_SET.has(type);
}

// Fields the platform maintains. Membership alone is not enough to call a field
// "system" — see classifyFieldEditability: an org can make some of these
// writable (e.g. CreatedDate under Set Audit Fields), and when describe says so
// we believe describe rather than this list.
export const SYSTEM_FIELD_NAMES: readonly string[] = [
  'Id',
  'CreatedById',
  'CreatedDate',
  'LastModifiedById',
  'LastModifiedDate',
  'SystemModstamp',
  'IsDeleted',
  'LastViewedDate',
  'LastReferencedDate',
];

const SYSTEM_FIELD_SET: ReadonlySet<string> = new Set(SYSTEM_FIELD_NAMES);

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type NotEditableReason =
  | 'formula'
  | 'auto-number'
  | 'system'
  | 'unsupported-type'
  | 'no-permission';

// 'update' asks the updateable question (edit an existing record); 'create'
// asks the createable one (clone stages a create form). Same rule set, one
// different permission flag — mini-plan "Field filtering (AC-2)".
export type EditabilityMode = 'update' | 'create';

export type FieldEditability =
  | { editable: true; type: EditableType }
  | { editable: false; reason: NotEditableReason; message: string };

function unsupportedTypeMessage(field: FieldDescribe): string {
  if (field.type === 'textarea' && field.htmlFormatted === true) {
    return 'Rich text is not editable here — its value is HTML, and this extension builds DOM without innerHTML by design.';
  }
  if (field.type === 'encryptedstring' || field.encrypted === true) {
    return 'Encrypted — the value shown is masked, so writing it back would corrupt the record.';
  }
  if (field.type === 'address' || field.type === 'location') {
    return `Compound ${field.type} fields are not writable as a whole — edit their component fields instead.`;
  }
  if (field.type === 'base64') {
    return 'Binary (base64) fields have no inline editor.';
  }
  return `Fields of type "${field.type}" are not editable here yet.`;
}

// The single place the question "may this field be written" is answered.
//
// Order matters: the more specific *why* wins, so a formula field reads
// "calculated", not "no permission" — both are true of it, but only one is
// useful. `no-permission` is the residual case and is worded non-committally on
// purpose: describe is evaluated per running user, so a field this user cannot
// edit is indistinguishable from one nobody can edit. We do not assert a cause
// we cannot verify.
export function classifyFieldEditability(
  field: FieldDescribe,
  mode: EditabilityMode = 'update',
): FieldEditability {
  if (field.calculated === true) {
    return {
      editable: false,
      reason: 'formula',
      message: 'Calculated server-side (formula or roll-up summary).',
    };
  }

  if (field.autoNumber === true) {
    return {
      editable: false,
      reason: 'auto-number',
      message: 'Auto-number — Salesforce assigns this value.',
    };
  }

  const permitted = mode === 'create' ? field.createable === true : field.updateable === true;

  // "System" needs both halves: a platform-maintained name AND describe
  // agreeing it is writable by nobody. An org with Set Audit Fields enabled
  // reports CreatedDate as createable, and then it is genuinely a create-time
  // input rather than a system field to grey out.
  if (SYSTEM_FIELD_SET.has(field.name) && field.updateable !== true && field.createable !== true) {
    return {
      editable: false,
      reason: 'system',
      message: 'Maintained by Salesforce and not writable.',
    };
  }

  if (!isEditableType(field.type)) {
    return { editable: false, reason: 'unsupported-type', message: unsupportedTypeMessage(field) };
  }

  // A rich-text area is typed `textarea`, so the type check above lets it
  // through — it is excluded on the htmlFormatted flag instead.
  if (field.type === 'textarea' && field.htmlFormatted === true) {
    return { editable: false, reason: 'unsupported-type', message: unsupportedTypeMessage(field) };
  }

  // Likewise a classic encrypted field can be typed `string`.
  if (field.encrypted === true) {
    return { editable: false, reason: 'unsupported-type', message: unsupportedTypeMessage(field) };
  }

  if (!permitted) {
    return {
      editable: false,
      reason: 'no-permission',
      message:
        mode === 'create'
          ? 'Not settable on create for you (field-level security or object permissions).'
          : 'Not editable for you (field-level security or object permissions).',
    };
  }

  return { editable: true, type: field.type };
}

// ---------------------------------------------------------------------------
// Read: record value -> control value
// ---------------------------------------------------------------------------

// What a native control wants: `boolean` for a checkbox, `string[]` for a
// <select multiple>, `string` for everything else.
export type InputValue = string | boolean | string[];

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

// Reads a `datetime` (an ISO-8601 UTC instant on the wire) into the
// 'YYYY-MM-DDTHH:mm' shape <input type="datetime-local"> requires, in the
// browser's own zone. Seconds are dropped: the control does not surface them
// unless `step` asks, and a save must not silently rewrite them — coerceForWire
// round-trips whatever the control gives back.
function toLocalDateTimeInput(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
    `T${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  );
}

// Formats a record value for its native control.
//
// `date` is the one to be careful with: Salesforce sends a bare 'YYYY-MM-DD'
// with no zone, and a Date round-trip through the browser's zone shifts it a
// day for anyone west of UTC. So a date is sliced as text and never parsed.
export function formatForInput(field: FieldDescribe, value: unknown): InputValue {
  if (field.type === 'boolean') return value === true || value === 'true';

  if (field.type === 'multipicklist') {
    if (Array.isArray(value)) return value.map((v) => String(v));
    if (typeof value === 'string' && value !== '') return value.split(';');
    return [];
  }

  if (value === null || value === undefined) return '';

  if (field.type === 'date') {
    // 'YYYY-MM-DD', or the date half of a datetime — string surgery only.
    const s = String(value);
    return s.length >= 10 ? s.slice(0, 10) : s;
  }

  if (field.type === 'datetime') return toLocalDateTimeInput(String(value));

  if (field.type === 'time') {
    // Salesforce sends 'HH:mm:ss.SSSZ'; <input type="time"> wants 'HH:mm:ss'.
    const s = String(value);
    const match = /^(\d{2}:\d{2}(?::\d{2})?)/.exec(s);
    return match?.[1] ?? s;
  }

  return String(value);
}

// ---------------------------------------------------------------------------
// Write: control value -> wire value
// ---------------------------------------------------------------------------

function isBlank(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    (typeof value === 'string' && value.trim() === '') ||
    (Array.isArray(value) && value.length === 0)
  );
}

// Coerces a control value into what the REST body should carry.
//
// Deliberately idempotent: applying it to an already-coerced value is a no-op.
// buildDirtyDiff leans on that, running it over BOTH the untouched GET value
// and the edited control value so the two are compared in one canonical form.
// That is what makes 3 and '3' the same number, '' and null the same absence,
// and two spellings of one instant the same datetime.
//
// It never throws and never rejects a value. A number field handed
// unparseable text passes the text through unchanged so the *org* rejects it —
// which lands as a field-level error on that exact field. Guessing here would
// only trade a precise server error for a silent local one.
export function coerceForWire(field: FieldDescribe, value: unknown): unknown {
  if (field.type === 'boolean') return value === true || value === 'true';

  if (field.type === 'multipicklist') {
    if (Array.isArray(value)) {
      const parts = value.map((v) => String(v)).filter((v) => v !== '');
      return parts.length > 0 ? parts.join(';') : null;
    }
    return isBlank(value) ? null : String(value);
  }

  if (isBlank(value)) return null;

  if (NUMERIC_TYPES.has(field.type)) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const n = Number(String(value).trim());
    return Number.isFinite(n) ? n : String(value).trim();
  }

  if (field.type === 'date') {
    const s = String(value).trim();
    return s.length >= 10 ? s.slice(0, 10) : s;
  }

  if (field.type === 'datetime') {
    const s = String(value).trim();
    const d = new Date(s);
    // Unparseable text goes through untouched — the org is authoritative.
    return Number.isNaN(d.getTime()) ? s : d.toISOString();
  }

  if (field.type === 'time') {
    const s = String(value).trim();
    const match = /^(\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?/.exec(s);
    if (!match) return s;
    const ms = (match[4] ?? '').padEnd(3, '0');
    return `${match[1]}:${match[2]}:${match[3] ?? '00'}.${ms}Z`;
  }

  return String(value);
}

// ---------------------------------------------------------------------------
// The diff
// ---------------------------------------------------------------------------

export interface DirtyDiff {
  // Exactly the body to PATCH. Empty object means nothing to save.
  patchBody: Record<string, unknown>;
  // The same fields, in describe order — what the save bar counts and what the
  // UI highlights. Always `Object.keys(patchBody)`; both exist so neither
  // caller has to re-derive the other.
  changedFieldNames: string[];
}

export interface DescribeLike {
  fields: FieldDescribe[];
}

// The single source of truth for "what changed" — the save bar and the PATCH
// body are the same computation, so they cannot disagree. (Before P4-1,
// inspect-record ran two independent `!==` loops for these two questions.)
//
// Three filters, in order, each of which matters:
//
//  1. Only fields describe knows about, and only ones classified editable. A
//     read-only field cannot become dirty, so a stale entry in `edited` for one
//     can never reach the wire.
//
//  2. Only fields PRESENT IN THE ORIGINAL GET PAYLOAD. This is the
//     security-relevant one. A field hidden from the running user by
//     field-level security is simply absent from the record JSON, so it reads
//     back as `undefined` — indistinguishable, to a naive comparison, from a
//     field the user just cleared. Including it would PATCH `null` over a value
//     the user was never allowed to see. `in` is the test, not a truthiness
//     check, because a legitimately null field IS present and must stay
//     editable.
//
//  3. Only values that actually differ once both sides are in canonical wire
//     form — so re-serialising a number or an instant is not mistaken for an
//     edit.
export function buildDirtyDiff(
  describe: DescribeLike | null | undefined,
  original: Record<string, unknown>,
  edited: Record<string, unknown>,
): DirtyDiff {
  const patchBody: Record<string, unknown> = {};
  const changedFieldNames: string[] = [];

  const fields = describe?.fields;
  if (!Array.isArray(fields)) return { patchBody, changedFieldNames };

  for (const field of fields) {
    if (!classifyFieldEditability(field, 'update').editable) continue;

    // Filter 2 — see above. Never relax this to a truthiness or != null check.
    if (!Object.prototype.hasOwnProperty.call(original, field.name)) continue;
    if (!Object.prototype.hasOwnProperty.call(edited, field.name)) continue;

    const before = coerceForWire(field, original[field.name]);
    const after = coerceForWire(field, edited[field.name]);
    if (before === after) continue;

    patchBody[field.name] = after;
    changedFieldNames.push(field.name);
  }

  return { patchBody, changedFieldNames };
}

// ---------------------------------------------------------------------------
// Save errors
// ---------------------------------------------------------------------------

// Renders under the named field's value cell.
export interface FieldSaveError {
  field: string;
  message: string;
  errorCode: string;
}

// Renders in the form-level banner, because there is no field row to attach it
// to. `field` is set when the org DID name a field but that field is not on
// screen — the banner then names it explicitly, which is the whole point.
export interface BannerSaveError {
  text: string;
  field: string | null;
  errorCode: string;
}

export interface MappedSaveErrors {
  fieldErrors: FieldSaveError[];
  bannerErrors: BannerSaveError[];
}

// Splits a rejection's records into "goes on a field row" and "goes in the
// banner".
//
// The banner is not a fallback for ugly errors — it is the guarantee that no
// error is lost. An error naming a field the user cannot currently see (
// filtered out, hidden by the show-nulls toggle, or not rendered at all) would
// otherwise vanish, which is exactly the silent failure this mapping exists to
// prevent. One record may name several fields; each is routed on its own, so a
// record naming one visible and one hidden field produces both an inline error
// and a banner line.
export function mapSaveErrors(
  details: readonly SalesforceRestErrorDetail[] | null | undefined,
  renderedFieldNames: Iterable<string>,
): MappedSaveErrors {
  const fieldErrors: FieldSaveError[] = [];
  const bannerErrors: BannerSaveError[] = [];
  if (!details) return { fieldErrors, bannerErrors };

  const rendered = new Set<string>();
  for (const name of renderedFieldNames) rendered.add(name.toLowerCase());

  for (const detail of details) {
    const errorCode = detail.errorCode ?? '';
    const message = detail.message ?? '';
    const fields = Array.isArray(detail.fields) ? detail.fields.filter((f) => f !== '') : [];

    if (fields.length === 0) {
      bannerErrors.push({ text: message, field: null, errorCode });
      continue;
    }

    for (const field of fields) {
      if (rendered.has(field.toLowerCase())) {
        fieldErrors.push({ field, message, errorCode });
      } else {
        bannerErrors.push({ text: `${field}: ${message}`, field, errorCode });
      }
    }
  }

  return { fieldErrors, bannerErrors };
}
