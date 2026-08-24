import {
  classifyFieldEditability,
  buildDirtyDiff,
  buildCreateBody,
  mapSaveErrors,
} from '@sfdt/flow-core';
import { orgRest, restErrorMessage, restErrorDetails } from './org-rest.js';

/**
 * Single-record read / edit / clone.
 *
 * The editability model is @sfdt/flow-core's — the SAME module the Chrome
 * extension's inspector uses. That is the point of this runner rather than a
 * second set of rules: a formula field, an auto-number or a field the running
 * user cannot write is refused here for the identical stated reason it is
 * refused in the browser, and there is no second implementation to drift.
 *
 * Everything reaches the org through `sf api request rest` (lib/org-rest.js),
 * so there is no new auth plumbing and no new dependency.
 *
 * Arg parsing, body building and outcome classification are pure so they can be
 * unit-tested without an org.
 */

const DEFAULT_API_VERSION = 'v62.0';

/** Salesforce record Id shape check — 15 or 18 chars, not the null Id. */
export function isRecordId(id) {
  return typeof id === 'string'
    && /^[a-zA-Z0-9]{15,18}$/.test(id)
    && !id.startsWith('000')
    && /[0-9]/.test(id.slice(0, 5));
}

/**
 * `config.sourceApiVersion` as a REST path segment (`v62.0`), or the default.
 *
 * Exported because `events-runner.js` builds `/sobjects/<Event>__e/` paths too,
 * and two copies of this normalisation would eventually disagree about whether
 * `62` means `v62.0`.
 */
export function apiVersion(config) {
  const raw = config?.sourceApiVersion;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_API_VERSION;
  const n = String(raw).replace(/^v/i, '');
  return /^\d+(\.\d+)?$/.test(n) ? `v${n.includes('.') ? n : `${n}.0`}` : DEFAULT_API_VERSION;
}

/**
 * Parse `--set Field=Value` pairs.
 *
 * Splits on the FIRST `=` only, so a value containing `=` (a URL query string,
 * a base64 tail) survives. An empty value is an explicit clear, and is kept as
 * `''` rather than dropped — flow-core's coerceForWire is what turns that into
 * a null on the wire, and duplicating the decision here would be the second
 * implementation this runner exists to avoid.
 */
export function parseSetPairs(pairs) {
  const out = {};
  for (const raw of pairs ?? []) {
    const text = String(raw);
    const eq = text.indexOf('=');
    if (eq <= 0) {
      throw new Error(`--set expects Field=Value (got "${text}")`);
    }
    out[text.slice(0, eq).trim()] = text.slice(eq + 1);
  }
  return out;
}

/**
 * Resolve an sObject type from a record Id's 3-character key prefix.
 *
 * A caller that already knows the type should pass it — this costs a global
 * describe, which is a large payload.
 */
export async function resolveSObject(orgAlias, recordId, config) {
  const data = await orgRest(orgAlias, `/services/data/${apiVersion(config)}/sobjects/`);
  const prefix = recordId.slice(0, 3);
  const match = (data?.sobjects ?? []).find((s) => s.keyPrefix === prefix);
  return match ? match.name : null;
}

/** Describe an sObject, keeping the flags the editability model reads. */
export async function describeForEdit(orgAlias, sobject, config) {
  const data = await orgRest(
    orgAlias,
    `/services/data/${apiVersion(config)}/sobjects/${sobject}/describe`,
  );
  const fields = Array.isArray(data?.fields) ? data.fields : [];
  return { name: data?.name ?? sobject, label: data?.label ?? sobject, fields };
}

/**
 * Classify a caught write failure.
 *
 * Mirrors the extension's three-state save contract: a PATCH is one DML
 * transaction, so the org either committed all of it or none of it — but that
 * is only a claim we may make when the org actually ANSWERED. An execa timeout
 * means the request's outcome is unknown and the record may well have been
 * written, so reporting it as "nothing was saved" would invite a retry that
 * duplicates the work.
 */
export function classifyWriteError(err) {
  const timedOut = err?.timedOut === true || err?.originalMessage === 'Timeout'
    || /ETIMEDOUT|timed out/i.test(String(err?.shortMessage ?? ''));
  if (timedOut) {
    return { outcome: 'unknown', message: `Timed out — the change may already have been saved in Salesforce; re-read the record before retrying. (${restErrorMessage(err)})` };
  }
  return { outcome: 'rejected', message: restErrorMessage(err), details: restErrorDetails(err) };
}

/**
 * Everything a read or a write needs about one record: its type, its describe,
 * and its current values — each fetched exactly ONCE.
 *
 * Private because `describe` must not escape into a command's output. A full
 * describe is a very large payload, and `record get --json` is consumed by
 * scripts and by the MCP tool; putting it in the envelope would bloat every
 * response with data no caller asked for.
 *
 * This exists because `editRecord` used to call `getRecord` (which describes)
 * and then `describeForEdit` again — two large round trips per write, for the
 * same answer.
 */
async function loadRecordContext(config, recordId, { org, sobject } = {}) {
  if (!isRecordId(recordId)) {
    throw new Error(`"${recordId}" is not a 15 or 18 character Salesforce record Id.`);
  }
  const type = sobject ?? (await resolveSObject(org, recordId, config));
  if (!type) throw new Error(`Could not resolve an sObject for the key prefix "${recordId.slice(0, 3)}".`);

  const describe = await describeForEdit(org, type, config);
  const record = await orgRest(org, `/services/data/${apiVersion(config)}/sobjects/${type}/${recordId}`);
  return { type, describe, record: record ?? {} };
}

/** Read one record plus the describe-derived editability of every field. */
export async function getRecord(config, recordId, { org, sobject } = {}) {
  const orgAlias = org;
  const { type, describe, record } = await loadRecordContext(config, recordId, { org, sobject });

  const fields = describe.fields.map((f) => {
    const editability = classifyFieldEditability(f, 'update');
    return {
      name: f.name,
      label: f.label ?? f.name,
      type: f.type,
      value: record?.[f.name] ?? null,
      editable: editability.editable,
      ...(editability.editable ? {} : { reason: editability.reason, why: editability.message }),
    };
  });

  return { id: recordId, sobject: type, org: orgAlias, fields, record };
}

/**
 * Apply `--set` values to a record.
 *
 * The PATCH body comes from flow-core's buildDirtyDiff, which is what makes a
 * non-editable field a LOCAL refusal with its reason rather than a round trip
 * that comes back with an opaque org error — and which drops any field absent
 * from the GET payload, so a field hidden by field-level security can never be
 * PATCHed to null over a value the user was never allowed to see.
 */
export async function editRecord(config, recordId, values, { org, sobject, dryRun = false } = {}) {
  const { type, describe, record } = await loadRecordContext(config, recordId, { org, sobject });
  const current = { sobject: type, record };

  // Refuse locally, by name, before anything reaches the org.
  const refused = [];
  for (const name of Object.keys(values)) {
    const field = describe.fields.find((f) => f.name === name);
    if (!field) {
      refused.push({ field: name, reason: 'unknown-field', why: `No field named "${name}" on ${current.sobject}.` });
      continue;
    }
    const e = classifyFieldEditability(field, 'update');
    if (!e.editable) refused.push({ field: name, reason: e.reason, why: e.message });
  }
  if (refused.length) {
    const lines = refused.map((r) => `  ${r.field}: ${r.why}`).join('\n');
    throw new Error(`Refusing to write ${refused.length} field(s):\n${lines}`);
  }

  const edited = { ...current.record, ...values };
  const { patchBody, changedFieldNames } = buildDirtyDiff(describe, current.record, edited);

  if (changedFieldNames.length === 0) {
    return { id: recordId, sobject: current.sobject, org, outcome: 'no-op', changed: [], body: {} };
  }
  // patchBody has a null prototype (flow-core builds it with Object.create(null)
  // so a field named __proto__ lands as a real own key). Serialise it, never
  // coerce it to a string and never call hasOwnProperty on it.
  const body = JSON.parse(JSON.stringify(patchBody));
  if (dryRun) {
    return { id: recordId, sobject: current.sobject, org, outcome: 'dry-run', changed: changedFieldNames, body };
  }

  try {
    await orgRest(org, `/services/data/${apiVersion(config)}/sobjects/${current.sobject}/${recordId}`, {
      method: 'PATCH',
      body,
    });
    return { id: recordId, sobject: current.sobject, org, outcome: 'saved', changed: changedFieldNames, body };
  } catch (err) {
    const classified = classifyWriteError(err);
    const rendered = describe.fields.map((f) => f.name);
    const mapped = classified.details ? mapSaveErrors(classified.details, rendered) : { fieldErrors: [], bannerErrors: [] };
    return {
      id: recordId,
      sobject: current.sobject,
      org,
      outcome: classified.outcome,
      changed: changedFieldNames,
      body,
      error: classified.message,
      fieldErrors: mapped.fieldErrors,
      bannerErrors: mapped.bannerErrors,
    };
  }
}

/**
 * Clone a record, optionally overriding fields.
 *
 * Uses flow-core's buildCreateBody, which asks the CREATE question rather than
 * the update one — so an org with Set Audit Fields can carry CreatedDate across
 * while an auto-number or formula is excluded, exactly as the browser does it.
 */
export async function cloneRecord(config, recordId, values, { org, sobject, dryRun = false } = {}) {
  const { type, describe, record } = await loadRecordContext(config, recordId, { org, sobject });
  const current = { sobject: type };
  const seeded = { ...record, ...values };
  const { body: created, includedFieldNames } = buildCreateBody(describe, seeded);
  const body = JSON.parse(JSON.stringify(created));

  if (includedFieldNames.length === 0) {
    throw new Error(`Nothing to create — no field on ${current.sobject} is settable on insert with a value.`);
  }
  if (dryRun) {
    return { source: recordId, sobject: current.sobject, org, outcome: 'dry-run', fields: includedFieldNames, body };
  }

  try {
    const resp = await orgRest(org, `/services/data/${apiVersion(config)}/sobjects/${current.sobject}`, {
      method: 'POST',
      body,
    });
    return {
      source: recordId,
      sobject: current.sobject,
      org,
      outcome: 'created',
      id: resp?.id ?? resp?.Id ?? null,
      fields: includedFieldNames,
      body,
    };
  } catch (err) {
    const classified = classifyWriteError(err);
    const rendered = describe.fields.map((f) => f.name);
    const mapped = classified.details ? mapSaveErrors(classified.details, rendered) : { fieldErrors: [], bannerErrors: [] };
    return {
      source: recordId,
      sobject: current.sobject,
      org,
      outcome: classified.outcome,
      fields: includedFieldNames,
      body,
      error: classified.message,
      fieldErrors: mapped.fieldErrors,
      bannerErrors: mapped.bannerErrors,
    };
  }
}
