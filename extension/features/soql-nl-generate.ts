// C-P4-5 — natural-language → SOQL, inside the query runner.
//
// TWO THINGS THIS MUST NOT DO, AND ONE PLACE EACH IS PREVENTED.
//
//  1. IT MUST NOT RUN THE QUERY IT GENERATED. `generateSoql()` is the only
//     orchestrator, and its dependency type (`GenerateDeps`) has no executor in
//     it — no `query`, no `apiGet`, no client. The success outcome is a STRING.
//     There is therefore no code path from "the model answered" to "the org ran
//     it": the module that talks to the model cannot reach the org, and the
//     caller in features/soql-runner.ts does nothing with the string but put it
//     in the editor. `test/soql-nl-generate.test.ts` proxies the deps object and
//     asserts the property names this function ever reads, so a future executor
//     dep shows up as a failing test rather than as a silently-running query.
//
//  2. IT MUST NOT PUT RECORD DATA IN THE PROMPT. The prompt is assembled from a
//     describe, through `schemaFieldsForPrompt()` — an ALLOWLIST of five
//     metadata properties (name, label, type, nillable, inlineHelpText). Nothing
//     else survives the mapping, so a describe payload polluted with anything
//     (including rows) contributes nothing to the prompt. `buildGeneratePrompt()`
//     has no records parameter and no way to obtain one.
//
//     That is the guarantee. `recordValueLeak()` is the BACKSTOP for it: the
//     runner wires it in as `deps.inspectPrompt`, a gate that runs after the
//     prompt is assembled and before `askAi` is reached, and refuses the send if
//     a value from the on-screen result set appears in the assembled text. It is
//     a heuristic (see its own doc comment) and is deliberately NOT the thing
//     the guarantee rests on — it exists so that a future edit which starts
//     splicing rows into the prompt fails closed instead of shipping.
//
// AC-1 (hard): there is no LLM endpoint here. The only way out of this module is
// `deps.askAi`, which features/soql-runner.ts implements with the SAME
// `createBridgeClient(...).call({ kind: 'ai', … })` plumbing
// features/ai-assistant.ts already uses. No provider host, no API key, no new
// manifest permission. `test/no-llm-endpoints.test.ts` scans the whole extension
// source for that.
//
// Off by default — the manifest declares `enabledByDefault: false`. This feature
// sends org schema (object and field API names, labels, help text) out of the
// browser to whatever provider the local CLI is configured with. That is a
// data-egress decision, and the user makes it, not us.

import { CONTEXTS } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import { buildSchemaMarkdown } from './export-for-prompt.js';

/** Settings / kill-switch id — the feature-registry key. */
export const SOQL_NL_GENERATE_ID = 'soql-nl-generate';

/** Most objects whose schema is put in one prompt. */
export const MAX_OBJECTS = 3;

/**
 * Most fields per object. A stock Account describe is ~300 fields; three of
 * those is a prompt nobody's provider will thank you for, and the tail of a
 * describe is overwhelmingly managed-package noise. Truncation is announced in
 * the prompt so the model knows the list is partial rather than authoritative.
 */
export const MAX_FIELDS_PER_OBJECT = 150;

/**
 * THE ALLOWLIST. Exactly the properties that may travel from a describe into a
 * prompt. Exported so the test asserts against this list rather than against a
 * copy of it.
 */
export const PROMPT_FIELD_PROPERTIES = [
  'name',
  'label',
  'type',
  'nillable',
  'inlineHelpText',
] as const;

/** A Salesforce API name — also the only thing accepted as an object to describe. */
const SOBJECT_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * A describe, as loosely as possible. Everything is `unknown` on purpose: the
 * mapping below is what makes the shape safe, so it must be written against
 * arbitrary input rather than against a type that has already promised there is
 * nothing dangerous in it.
 */
export interface PromptSchemaSource {
  name?: unknown;
  label?: unknown;
  fields?: unknown;
}

/** One object's schema, reduced to what a prompt may carry. */
export interface PromptField {
  name: string;
  label: string;
  type: string;
  nillable: boolean;
  inlineHelpText: string | null;
}

export interface PromptSchema {
  objectName: string;
  fields: PromptField[];
  /** Total fields on the describe, before {@link MAX_FIELDS_PER_OBJECT}. */
  totalFields: number;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reduce a describe's fields to {@link PROMPT_FIELD_PROPERTIES}.
 *
 * This is the redaction boundary named in AC-4, and it is a rebuild rather than
 * a filter: every returned object is constructed property by property from the
 * allowlist, so an input property that is not on the list has no route into the
 * output — not even a wrong-typed one. A field entry that isn't an object, or
 * that has no usable `name`, is dropped entirely.
 */
export function schemaFieldsForPrompt(describe: PromptSchemaSource | null | undefined): PromptField[] {
  const raw = describe?.fields;
  if (!Array.isArray(raw)) return [];
  const out: PromptField[] = [];
  for (const entry of raw) {
    if (!isPlainRecord(entry)) continue;
    const name = str(entry.name).trim();
    if (!name) continue;
    out.push({
      name,
      label: str(entry.label),
      type: str(entry.type),
      // Absent ⇒ treated as nillable. The value only decides whether the
      // markdown says "Required: Yes"; it is a hint to the model, not a gate.
      nillable: entry.nillable !== false,
      inlineHelpText: typeof entry.inlineHelpText === 'string' ? entry.inlineHelpText : null,
    });
  }
  return out;
}

/** Reduce a whole describe, capped at {@link MAX_FIELDS_PER_OBJECT}. */
export function schemaForPrompt(
  objectName: string,
  describe: PromptSchemaSource | null | undefined,
): PromptSchema | null {
  const fields = schemaFieldsForPrompt(describe);
  if (fields.length === 0) return null;
  const resolved = str(describe?.name).trim() || objectName;
  return {
    objectName: resolved,
    fields: fields.slice(0, MAX_FIELDS_PER_OBJECT),
    totalFields: fields.length,
  };
}

/**
 * The schema block for one object, in the export-for-prompt format.
 *
 * Delegates to `buildSchemaMarkdown()` — the same function the "Export for
 * Prompt" feature (P2-1) copies to the clipboard — so the two surfaces cannot
 * drift into two dialects of "the schema, for a model". The allowlisted fields
 * are what it is handed.
 */
export function schemaMarkdown(schema: PromptSchema): string {
  const markdown = buildSchemaMarkdown(schema.objectName, {
    name: schema.objectName,
    label: schema.objectName,
    fields: schema.fields,
  });
  if (schema.totalFields > schema.fields.length) {
    return `${markdown}\n\n_Showing the first ${schema.fields.length} of ${schema.totalFields} fields on ${schema.objectName}._`;
  }
  return markdown;
}

/**
 * Normalise a list of object API names: trim, drop anything that isn't an API
 * name, dedupe case-insensitively (first spelling wins), cap the count.
 */
export function normaliseObjectNames(
  names: Iterable<string> | null | undefined,
  max = MAX_OBJECTS,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  if (max <= 0) return out;
  for (const raw of names ?? []) {
    const name = String(raw ?? '').trim();
    if (!SOBJECT_NAME_RE.test(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= max) break;
  }
  return out;
}

/** Parse the "Objects" box: a comma- or space-separated list of API names. */
export function parseObjectList(text: string | null | undefined, max = MAX_OBJECTS): string[] {
  return normaliseObjectNames(String(text ?? '').split(/[,\s]+/), max);
}

/**
 * Guess which objects a request is about by matching its words against the
 * org's own sObject list.
 *
 * Deliberately dumb: exact (case-insensitive) matches plus the two English
 * plurals Salesforce object names actually take (`Accounts` → `Account`,
 * `Opportunities` → `Opportunity`). Anything cleverer starts inventing objects
 * that aren't in the org, and the user can always name them explicitly — which
 * is why the box exists.
 *
 * Order is first-mention-in-the-request, so the result is stable for a given
 * sentence and reads the way the user wrote it.
 */
export function inferObjectNames(
  request: string,
  known: Iterable<string> | null | undefined,
  max = MAX_OBJECTS,
): string[] {
  const byLower = new Map<string, string>();
  for (const name of known ?? []) {
    const trimmed = String(name ?? '').trim();
    if (!SOBJECT_NAME_RE.test(trimmed)) continue;
    const key = trimmed.toLowerCase();
    // First spelling wins, so a duplicate in the global describe can't reorder.
    if (!byLower.has(key)) byLower.set(key, trimmed);
  }
  if (byLower.size === 0) return [];

  const hits: string[] = [];
  for (const m of String(request ?? '').matchAll(/[A-Za-z][A-Za-z0-9_]*/g)) {
    const word = m[0]!.toLowerCase();
    const candidates = [word];
    if (word.endsWith('ies')) candidates.push(`${word.slice(0, -3)}y`);
    if (word.endsWith('es')) candidates.push(word.slice(0, -2));
    if (word.endsWith('s')) candidates.push(word.slice(0, -1));
    for (const candidate of candidates) {
      const match = byLower.get(candidate);
      if (match) {
        hits.push(match);
        break;
      }
    }
  }
  return normaliseObjectNames(hits, max);
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

/**
 * The instruction block. Kept as one exported constant so the test asserts
 * against the shipped text rather than a paraphrase of it, and so a reviewer
 * can read what we ask a model to do without reconstructing it from
 * concatenation.
 */
export const PROMPT_INSTRUCTIONS = [
  'You are a Salesforce SOQL expert. Write ONE SOQL query that answers the request below.',
  '',
  'Rules:',
  '- Reply with the query only, inside a ```soql fenced code block. No explanation, no prose.',
  '- Use ONLY the objects and fields listed under "Schema". Do not invent field or object API names.',
  '- Always include Id in the SELECT list unless the query is an aggregate.',
  '- Add a LIMIT clause unless the request asks for an aggregate or explicitly asks for everything.',
  '- Do not emit DML, Apex, or SOSL. SELECT only.',
  '- The schema below is metadata only. You have not been given any record data; do not pretend to have seen any.',
].join('\n');

/**
 * The heading the user's request is interpolated under. Exported because
 * {@link recordValueLeak}'s fallback locates the request relative to it, and a
 * checker that hunts for a literal it does not own is a checker that silently
 * stops working when the literal moves.
 */
export const REQUEST_HEADING = '## Request\n';

export interface BuiltPrompt {
  /** What goes on the wire. */
  prompt: string;
  /** Just the schema section — the part this module assembled. */
  schemaBlock: string;
  /** The objects whose schema is in it, in prompt order. */
  objects: string[];
  /** Every field API name in the prompt — the leak gate's ignore list. */
  fieldNames: string[];
  /**
   * `[start, end)` of the user's request inside `prompt` — the exact span this
   * function interpolated it at.
   *
   * The leak gate subtracts the user's own words before scanning, and it has to
   * subtract the OCCURRENCE, not the characters: a global find-and-replace of a
   * one-character description deletes that character from the entire prompt and
   * the scan then finds nothing. Handing the gate the span removes the guesswork
   * — we know where we put it.
   */
  requestRange: readonly [number, number];
}

/**
 * Assemble the prompt.
 *
 * NOTE THE PARAMETER LIST. It takes a request string and schemas. There is no
 * records parameter, no result-set parameter, and no client it could fetch one
 * with. That absence is AC-4's guarantee; everything else about redaction is a
 * backstop for it.
 */
export function buildGeneratePrompt(input: {
  request: string;
  schemas: readonly PromptSchema[];
}): BuiltPrompt {
  const request = String(input.request ?? '').trim();
  const objects: string[] = [];
  const fieldNames: string[] = [];
  const blocks: string[] = [];
  for (const schema of input.schemas) {
    objects.push(schema.objectName);
    for (const f of schema.fields) fieldNames.push(f.name);
    blocks.push(schemaMarkdown(schema));
  }
  const schemaBlock = blocks.join('\n\n');
  // Assembled by index rather than by join() so the request's span is a fact we
  // computed, not one a later reader has to re-derive by searching for it.
  const head = `${PROMPT_INSTRUCTIONS}\n\n${REQUEST_HEADING}`;
  const tail = `\n\n## Schema\n${schemaBlock}`;
  const prompt = `${head}${request}${tail}`;
  const requestRange: readonly [number, number] = [head.length, head.length + request.length];
  return { prompt, schemaBlock, objects, fieldNames, requestRange };
}

// ---------------------------------------------------------------------------
// The leak backstop
// ---------------------------------------------------------------------------

/** Below this many characters a value is too generic to be evidence of a leak. */
const LEAK_MIN_LENGTH = 8;

/**
 * Walk a row and collect every scalar in it, however deeply nested.
 *
 * THERE IS NO DEPTH CAP, DELIBERATELY. There used to be one, at 3, which reached
 * two relationship hops (`Owner.Manager.Name`) and stopped. That is shallower
 * than SOQL goes: child-to-parent traversal is legal to five levels
 * (`A__r.B__r.C__r.D__r.E__r.Name`), and a parent-to-child subquery nests a
 * further `{ records: [...] }` envelope under its own key, so a single legal
 * query can put a value eight or nine levels into the response object. Any fixed
 * number is therefore a number a real result set can exceed, and a backstop with
 * a blind spot you can reach by writing an ordinary query is not much of a
 * backstop.
 *
 * Termination comes from a cycle guard instead of from a counter. The rows this
 * is handed are `JSON.parse`d Salesforce responses, which are finite trees; the
 * `seen` set is there for the case that is not true — a hand-built object with a
 * back edge — so a malformed caller gets a wrong answer rather than a hung tab.
 */
function collectRecordValues(
  value: unknown,
  into: Set<string>,
  seen: Set<object>,
): void {
  if (Array.isArray(value)) {
    if (seen.has(value)) return;
    seen.add(value);
    for (const item of value) collectRecordValues(item, into, seen);
    return;
  }
  if (isPlainRecord(value)) {
    if (seen.has(value)) return;
    seen.add(value);
    for (const key of Object.keys(value)) {
      // The Salesforce envelope carries the object's own API name as a VALUE
      // (`attributes.type: 'Account'`), which the schema block legitimately
      // contains. Skipping it is not a hole: it holds no field data.
      if (key.toLowerCase() === 'attributes') continue;
      collectRecordValues(value[key], into, seen);
    }
    return;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const text = String(value).trim();
    if (text.length >= LEAK_MIN_LENGTH) into.add(text);
  }
}

/**
 * Remove the user's request from the prompt — the OCCURRENCE, not the
 * characters.
 *
 * This is the whole of the N1 fix, so it is worth being explicit about what was
 * wrong. The old line was `prompt.split(request).join('\n')`, a global
 * find-and-replace. With `request = 'o'` that deletes every `o` in the prompt,
 * including the ones inside `Zenith Prosthetics Consortium`, and the scan that
 * follows then matches nothing — a one-character description switched the gate
 * off. A minimum-length floor would only move the bypass to the first length the
 * floor allows, so the fix is to stop doing a text substitution at all.
 *
 * `range` is the span {@link buildGeneratePrompt} interpolated the request at,
 * and it is verified against the prompt before it is trusted. Callers that
 * assembled the prompt some other way get a fallback that still removes exactly
 * one occurrence — the one under {@link REQUEST_HEADING} when there is a heading
 * — never all of them.
 */
function subtractRequest(
  prompt: string,
  request: string,
  range: readonly [number, number] | undefined,
): string {
  if (request.length === 0) return prompt;
  if (range) {
    const [start, end] = range;
    if (
      Number.isInteger(start) &&
      Number.isInteger(end) &&
      start >= 0 &&
      end - start === request.length &&
      end <= prompt.length &&
      prompt.slice(start, end) === request
    ) {
      return `${prompt.slice(0, start)}\n${prompt.slice(end)}`;
    }
  }
  const heading = prompt.indexOf(REQUEST_HEADING);
  const from = heading >= 0 ? heading + REQUEST_HEADING.length : 0;
  const at = prompt.indexOf(request, from);
  if (at < 0) return prompt;
  return `${prompt.slice(0, at)}\n${prompt.slice(at + request.length)}`;
}

/**
 * Does the assembled prompt contain a value from the on-screen result set?
 * Returns the offending value, or null.
 *
 * WHAT THIS IS AND IS NOT. It is a fail-closed backstop for the structural
 * guarantee above, not the guarantee itself. It is a substring search over
 * values it can see, so it is:
 *
 *   - blind to values shorter than 8 characters (a `true`, a `42`, a picklist
 *     code) — those are not distinguishable from ordinary prompt text;
 *   - blind to a value that has been reformatted (a date re-rendered, a number
 *     re-grouped) between the row and the prompt;
 *   - blind to anything in a result set that is not currently on screen.
 *
 * It is NOT blind to a deeply nested value: see {@link collectRecordValues},
 * which has no depth cap.
 *
 * `requestText` is subtracted before the search, because the user's own words
 * are theirs: someone typing "accounts named Universal Containers" while that
 * name happens to be in the results table has not suffered a leak, and blocking
 * them would be a bug. Only the REGION the request was interpolated at is
 * removed (`opts.requestRange`, from `buildGeneratePrompt`) — subtracting its
 * characters globally, as this once did, let a one-character description erase
 * the evidence from the whole prompt. Everything the ASSEMBLER produced is still
 * searched.
 *
 * `ignore` takes the object and field API names in the prompt, which the schema
 * block legitimately contains and which a row can also carry as a value
 * (`Type: 'Customer'` vs. a field named `Customer`).
 */
export function recordValueLeak(
  prompt: string,
  requestText: string,
  records: ReadonlyArray<unknown> | null | undefined,
  opts: { ignore?: Iterable<string>; requestRange?: readonly [number, number] } = {},
): string | null {
  if (!records || records.length === 0) return null;
  const request = String(requestText ?? '');
  // Subtract the user's own words — the occurrence, not the characters.
  const haystack = subtractRequest(prompt, request, opts.requestRange).toLowerCase();
  const ignore = new Set<string>();
  for (const name of opts.ignore ?? []) ignore.add(String(name).trim().toLowerCase());

  const values = new Set<string>();
  const seen = new Set<object>();
  for (const row of records) collectRecordValues(row, values, seen);
  for (const value of values) {
    const lower = value.toLowerCase();
    if (ignore.has(lower)) continue;
    if (haystack.includes(lower)) return value;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reading the model's reply
// ---------------------------------------------------------------------------

const FENCE_RE = /```(?:soql|sql)?[ \t]*\r?\n([\s\S]*?)```/i;

/**
 * Pull the query out of a model reply.
 *
 * Prefers a fenced block (what the instructions ask for); falls back to the
 * first SELECT and everything up to the next blank line, because a model that
 * ignored the fence rule usually still answers with the query on its own lines.
 * Returns '' when there is nothing SELECT-shaped, which the caller reports
 * rather than guessing at.
 */
export function extractSoql(reply: string | null | undefined): string {
  const text = String(reply ?? '');
  const fenced = FENCE_RE.exec(text);
  const body = fenced ? fenced[1]! : text;
  const select = /\bselect\b/i.exec(body);
  if (!select) return '';
  let query = body.slice(select.index);
  // A model that adds a trailing sentence puts it after a blank line.
  const blank = /\r?\n[ \t]*\r?\n/.exec(query);
  if (blank) query = query.slice(0, blank.index);
  return query.trim().replace(/;+\s*$/, '').trim();
}

export interface LocalValidation {
  valid: boolean;
  errors: string[];
}

/**
 * The CLI's local SOQL checks, mirrored.
 *
 * Same rules as `validateLocal()` in `src/lib/soql-runner.js` (the checks behind
 * `sfdt soql validate`, D-1) — reduced to the SOQL half, because a generator
 * that is told "SELECT only" and answers with a FIND has not produced a query
 * the runner asked for. Mirrored rather than imported for the same reason
 * `isSoslQuery()` above it is: the extension does not ship the CLI.
 *
 * It runs on the GENERATED text, before that text reaches the editor, so an
 * unusable answer is reported as an answer rather than pasted over the user's
 * draft. It makes NO org call — deliberately. The org-side half of validation
 * is the runner's existing Explain button, one click away once the query is in
 * the editor, and keeping generation free of any follow-on request is what
 * makes "it never runs anything" easy to keep true.
 */
export function validateGeneratedSoql(soql: string | null | undefined): LocalValidation {
  const text = String(soql ?? '').trim();
  const errors: string[] = [];
  if (!text) return { valid: false, errors: ['The assistant did not return a query.'] };
  if (!/^select\b/i.test(text)) {
    errors.push('The generated text does not start with SELECT.');
  } else {
    if (!/\bfrom\s+[a-z0-9_]+/i.test(text)) errors.push('SOQL requires a FROM <sObject> clause.');
    if (/^select\s+\*/i.test(text)) errors.push('SOQL has no `SELECT *` — fields must be listed.');
  }
  if (text.includes(';')) errors.push('Semicolons are not valid in SOQL.');
  let depth = 0;
  let inString = false;
  for (const ch of text) {
    if (ch === "'") inString = !inString;
    else if (!inString && ch === '(') depth += 1;
    else if (!inString && ch === ')') depth -= 1;
  }
  if (depth !== 0) errors.push(`Unbalanced parentheses (${depth > 0 ? 'missing )' : 'missing ('}).`);
  if ((text.match(/'/g) ?? []).length % 2 !== 0) errors.push('Unbalanced single quotes.');
  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// The orchestrator
// ---------------------------------------------------------------------------

export type AskAiResult =
  | { ok: true; response: string; provider?: string }
  | {
      ok: false;
      message: string;
      /** True for "the bridge/AI isn't set up", which gets the how-to-enable copy. */
      unavailable?: boolean;
      /** The original throwable, when there was one — for ui/panels.ts. */
      error?: unknown;
    };

export interface GenerateDeps {
  /** Resolve one object's describe. Null when the org can't describe it. */
  describeObject(name: string): Promise<PromptSchemaSource | null>;
  /** The org's sObject API names, for inference. Only called when inferring. */
  knownObjects(): Promise<readonly string[]> | readonly string[];
  /**
   * GATE. Runs on the assembled prompt before anything is sent. Return a
   * message to refuse the send; return null to allow it. A throw is a refusal —
   * a gate that fell over is not consent.
   */
  inspectPrompt?(
    prompt: string,
    requestText: string,
    context: {
      objects: readonly string[];
      fieldNames: readonly string[];
      /** Where `requestText` sits in `prompt`, so a gate can exclude it by index. */
      requestRange: readonly [number, number];
    },
  ): string | null;
  /**
   * Send the prompt through the ai-assistant bridge plumbing. THE ONLY WAY OUT
   * OF THIS MODULE. Note what is NOT in this interface: anything that can run a
   * query.
   */
  askAi(prompt: string): Promise<AskAiResult>;
}

export type GenerateOutcome =
  | {
      status: 'generated';
      /** The query text, for the editor. Nothing here can run it. */
      soql: string;
      objects: readonly string[];
      provider?: string;
    }
  | { status: 'no-request' }
  | { status: 'no-objects' }
  | { status: 'no-schema'; objects: readonly string[] }
  /** The prompt gate refused the send. Nothing was sent. */
  | { status: 'blocked'; message: string }
  /** No bridge, or the CLI has AI switched off — gets the how-to-enable copy. */
  | { status: 'unavailable'; message: string; error?: unknown }
  | { status: 'failed'; message: string; error?: unknown }
  | { status: 'not-soql'; response: string }
  | { status: 'invalid'; soql: string; errors: readonly string[] };

export interface GenerateInput {
  request: string;
  /** User-picked objects. Empty ⇒ inferred from the request. */
  objects?: readonly string[];
  maxObjects?: number;
}

/**
 * Request → prompt → bridge → query text. The whole feature, as one function
 * that returns a value and never throws.
 *
 * The gates run in order and each one can only stop the flow, never redirect
 * it: no request, no objects, no schema, and the prompt inspection all return
 * before `deps.askAi` is reached. Past `askAi` the only thing left is reading
 * the reply. At no point does this function hold anything that could execute
 * SOQL, which is why AC-2 is a property of the code shape rather than of a
 * caller's discipline.
 */
export async function generateSoql(
  input: GenerateInput,
  deps: GenerateDeps,
): Promise<GenerateOutcome> {
  const request = String(input.request ?? '').trim();
  if (!request) return { status: 'no-request' };
  const max = input.maxObjects ?? MAX_OBJECTS;

  let objects = normaliseObjectNames(input.objects ?? [], max);
  if (objects.length === 0) {
    const known = await deps.knownObjects();
    objects = inferObjectNames(request, known, max);
  }
  if (objects.length === 0) return { status: 'no-objects' };

  const schemas: PromptSchema[] = [];
  for (const name of objects) {
    const describe = await deps.describeObject(name);
    const schema = schemaForPrompt(name, describe);
    if (schema) schemas.push(schema);
  }
  if (schemas.length === 0) return { status: 'no-schema', objects };

  const built = buildGeneratePrompt({ request, schemas });

  // ---- GATE: nothing from the result set may be in what we send -----------
  if (deps.inspectPrompt) {
    let refusal: string | null;
    try {
      refusal = deps.inspectPrompt(built.prompt, request, {
        objects: built.objects,
        fieldNames: built.fieldNames,
        requestRange: built.requestRange,
      });
    } catch (err) {
      refusal = err instanceof Error ? err.message : String(err);
    }
    if (typeof refusal === 'string' && refusal.length > 0) {
      return { status: 'blocked', message: refusal };
    }
  }

  const reply = await deps.askAi(built.prompt);
  if (!reply.ok) {
    return {
      status: reply.unavailable ? 'unavailable' : 'failed',
      message: reply.message,
      error: reply.error,
    };
  }

  const soql = extractSoql(reply.response);
  if (!soql) return { status: 'not-soql', response: reply.response };
  const validation = validateGeneratedSoql(soql);
  if (!validation.valid) return { status: 'invalid', soql, errors: validation.errors };

  return { status: 'generated', soql, objects: built.objects, provider: reply.provider };
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

/**
 * AC-3's how-to-enable text, appended below whatever the bridge said.
 *
 * The bridge's own message already names the specific problem (an unpaired
 * token, an offline server, or the CLI's `"features.ai": false`), so this adds
 * the steps rather than repeating the diagnosis.
 */
export const UNAVAILABLE_GUIDANCE =
  'AI generation runs through the local sfdt CLI — nothing is sent from the browser to a model. ' +
  'To enable it: run `sfdt ui` on this machine, pair the extension on the SFDT options page ' +
  '(Bridge → token), and set "features.ai": true in the project\'s .sfdt/config.json.';

/** Shown under the request box, so the trade is stated before it is made. */
export const PROMPT_DISCLOSURE =
  'Your description and the selected objects’ field metadata (API names, labels, types, help text) ' +
  'are sent through the sfdt bridge to whichever AI provider your CLI is configured with. ' +
  'Values from the results table are not included. The generated query is placed in the editor ' +
  'for you to review — it is never run for you.';

// ---------------------------------------------------------------------------
// Registry feature
// ---------------------------------------------------------------------------

/**
 * The registry entry. Like C-P4-2's bulk delete this feature has no activation
 * of its own — it is a control inside the SOQL runner — so it registers purely
 * to own a kill-switch id and an options-page toggle. It has no FEATURE_ICONS
 * entry, so it never appears in the side menu or the command palette.
 */
export function createSoqlNlGenerateFeature(): Feature {
  return {
    manifest: {
      id: SOQL_NL_GENERATE_ID,
      name: 'Generate SOQL from a description (AI)',
      contexts: [
        CONTEXTS.SETUP_FLOWS,
        CONTEXTS.SETUP_OTHER,
        CONTEXTS.FLOW_BUILDER,
        CONTEXTS.FLOW_TRIGGER_EXPLORER,
      ],
      // Ships OFF: it moves org schema out of the browser through the bridge.
      enabledByDefault: false,
    },
  };
}
