// "What writes this field?" — pure extraction of every FIELD WRITE a Flow
// performs, read straight out of Tooling API `Flow.Metadata`.
//
// Reads are deliberately NOT writes: Get Records elements, entry criteria,
// element `filters`, formula resources and decision conditions all reference
// fields without changing them, and none of them produce a row here. Only three
// constructs write a field in a Flow, and each is handled below:
//
//   1. Create Records  (`recordCreates[].inputAssignments[].field`)
//   2. Update Records  (`recordUpdates[].inputAssignments[].field`)
//   3. Assignment      (`assignments[].assignmentItems[].assignToReference`,
//                       when the target is `<recordRef>.<Field>` — the
//                       before-save `$Record.Field__c` pattern)
//
// This module is the single Flow-parsing engine for the field-impact feature:
// the Chrome extension consumes it rather than re-implementing a second parser.
//
// Pure — no DOM, no org, no fs, no XML parser. Consumes the same
// `RawFlowMetadata` shape `normalize()` does, so a caller that already fetched a
// flow for the quality scan can feed it straight in.

import type { RawFlowMetadata } from './normalize.js';

/** Which Flow construct performed the write. */
export type FieldWriteKind = 'recordCreate' | 'recordUpdate' | 'assignment';

/**
 * Provenance of a write, using the SAME vocabulary as the dependency `--gaps`
 * report (`src/lib/source-dependencies.js`, `GET /api/dependencies/gaps`, the
 * GUI Gaps panel):
 *
 * - `confirmed` — the metadata itself states the fact. The field name came from
 *   the element, and the object API name was resolvable from this flow's own
 *   metadata (the element's `object`, the record-triggered `start.object` behind
 *   `$Record`, or a declared sObject variable's `objectType`).
 * - `inferred` — the parser is confident a field of this name is written, but
 *   could not bind it to a concrete object (assignment into an undeclared or
 *   non-sObject reference, or a relationship hop). Never present an `inferred`
 *   row as a confirmed one.
 */
export type FieldWriteStatus = 'confirmed' | 'inferred';

export interface FlowFieldWrite {
  /** Object API name the written field belongs to, or `null` when unresolved. */
  object: string | null;
  /** Field API name written (bare, e.g. `Status__c`). */
  field: string;
  kind: FieldWriteKind;
  /** API name of the Flow element performing the write. */
  elementName: string;
  /** Display label of that element (falls back to its API name). */
  elementLabel: string;
  status: FieldWriteStatus;
  /** Human-readable snippet of what was matched — mirrors `InferredRef.evidence`. */
  evidence: string;
}

/** Display labels for each write kind (shared so consumers don't re-invent them). */
export const FIELD_WRITE_KIND_LABELS: Record<FieldWriteKind, string> = {
  recordCreate: 'Create Records',
  recordUpdate: 'Update Records',
  assignment: 'Assignment',
};

// `$Record` / `$Record__Prior` resolve to the record-triggered start object.
const RECORD_GLOBALS = ['$Record', '$Record__Prior'];

// Flow globals that are never a writable sObject record — an assignment whose
// head is one of these is not a field write on a business object.
const NON_RECORD_GLOBALS = new Set(
  [
    '$Flow', '$User', '$UserRole', '$Profile', '$Organization', '$Setup',
    '$System', '$Api', '$Label', '$Permission', '$Action', '$Resource',
  ].map((g) => g.toLowerCase()),
);

// Element collections whose entries carry an `object` and can therefore name the
// sObject behind an element-scoped reference (`storeOutputAutomatically`).
const OBJECT_BEARING_COLLECTIONS = [
  'recordLookups',
  'recordCreates',
  'recordUpdates',
  'recordDeletes',
] as const;

type Rec = Record<string, unknown>;

function asRecords(value: unknown): Rec[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is Rec => typeof v === 'object' && v !== null);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** First segment of a merge-field path (`$Record.Status__c` → `$Record`). */
function headOf(reference: string): string {
  const dot = reference.indexOf('.');
  return dot === -1 ? reference : reference.slice(0, dot);
}

/**
 * Build the reference → object-API-name map for one flow. Every entry comes from
 * the flow's own metadata, which is what makes a resolved object `confirmed`
 * rather than a guess.
 */
function buildObjectResolver(metadata: RawFlowMetadata): (reference: string) => string | null {
  const map = new Map<string, string>();
  const put = (name: unknown, object: unknown): void => {
    const key = str(name).toLowerCase();
    const value = str(object);
    if (!key || !value) return;
    if (!map.has(key)) map.set(key, value);
  };

  // Record-triggered flows: `$Record` IS the start object.
  const startObject = str((metadata.start as Rec | undefined)?.object);
  if (startObject) {
    for (const global of RECORD_GLOBALS) map.set(global.toLowerCase(), startObject);
  }

  // Declared sObject variables carry their own objectType.
  for (const variable of asRecords(metadata.variables)) {
    put(variable.name, variable.objectType);
  }

  // Elements that store output automatically are referenced by element name.
  for (const key of OBJECT_BEARING_COLLECTIONS) {
    for (const element of asRecords(metadata[key])) put(element.name, element.object);
  }

  // A loop variable takes the object of the collection it iterates. Two passes
  // so a loop over another loop's output still resolves; deeper chains are rare
  // and degrade to `inferred` rather than to a wrong object.
  const loops = asRecords(metadata.loops);
  for (let pass = 0; pass < 2; pass++) {
    for (const loop of loops) {
      const collection = str(loop.collectionReference);
      if (!collection) continue;
      const resolved = map.get(headOf(collection).toLowerCase());
      if (resolved) put(loop.name, resolved);
    }
  }

  return (reference: string): string | null => map.get(reference.trim().toLowerCase()) ?? null;
}

function dedupe(writes: FlowFieldWrite[]): FlowFieldWrite[] {
  const seen = new Set<string>();
  const out: FlowFieldWrite[] = [];
  for (const write of writes) {
    const key = `${write.kind}|${write.object ?? ''}|${write.field}|${write.elementName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(write);
  }
  // Deterministic order so snapshots and rendered lists are stable.
  return out.sort(
    (a, b) =>
      a.elementName.localeCompare(b.elementName) ||
      a.field.localeCompare(b.field) ||
      a.kind.localeCompare(b.kind),
  );
}

/**
 * Every field write in one Flow's metadata. Returns `[]` for metadata that is
 * missing, empty, or contains no writing element — never throws on a partial or
 * unexpected shape (Salesforce omits keys whose value is the default).
 */
export function extractFieldWrites(metadata: RawFlowMetadata | null | undefined): FlowFieldWrite[] {
  if (!metadata || typeof metadata !== 'object') return [];
  const resolve = buildObjectResolver(metadata);
  const writes: FlowFieldWrite[] = [];

  // --- 1 + 2. Create / Update Records: inputAssignments name the field, the
  // element (or the record variable it updates) names the object. ---
  const recordElements: ReadonlyArray<readonly [FieldWriteKind, string]> = [
    ['recordCreate', 'recordCreates'],
    ['recordUpdate', 'recordUpdates'],
  ];
  for (const [kind, collection] of recordElements) {
    for (const element of asRecords(metadata[collection])) {
      const elementName = str(element.name);
      const elementLabel = str(element.label) || elementName;
      // `object` is stated for "use separate resources/criteria"; an
      // `inputReference`-driven element instead points at a record variable.
      let object = str(element.object) || null;
      if (!object) {
        const inputReference = str(element.inputReference);
        if (inputReference) object = resolve(headOf(inputReference));
      }
      for (const assignment of asRecords(element.inputAssignments)) {
        const field = str(assignment.field);
        if (!field) continue;
        writes.push({
          object,
          field,
          kind,
          elementName,
          elementLabel,
          status: object ? 'confirmed' : 'inferred',
          evidence: `${FIELD_WRITE_KIND_LABELS[kind]} "${elementLabel}" sets ${object ?? '(unresolved object)'}.${field}`,
        });
      }
    }
  }

  // --- 3. Assignment elements writing into a record's field. This is how a
  // before-save record-triggered flow writes ($Record.Field__c), and how any
  // flow populates an sObject variable before a Create/Update element. ---
  for (const element of asRecords(metadata.assignments)) {
    const elementName = str(element.name);
    const elementLabel = str(element.label) || elementName;
    for (const item of asRecords(element.assignmentItems)) {
      const target = str(item.assignToReference);
      if (!target) continue;
      const parts = target.split('.').map((p) => p.trim());
      // No dot = a plain variable assignment, not a field write.
      if (parts.length < 2) continue;
      const head = parts[0]!;
      const field = parts[parts.length - 1]!;
      if (!head || !field) continue;
      // `$Flow.CurrentDate` and friends are not records — never a field write.
      if (NON_RECORD_GLOBALS.has(head.toLowerCase())) continue;
      // More than one hop (`$Record.Owner.Name`) cannot be bound to a concrete
      // object here; the write is reported, but only as `inferred`.
      const object = parts.length === 2 ? resolve(head) : null;
      writes.push({
        object,
        field,
        kind: 'assignment',
        elementName,
        elementLabel,
        status: object ? 'confirmed' : 'inferred',
        evidence: `Assignment "${elementLabel}" sets ${target}`,
      });
    }
  }

  return dedupe(writes);
}

export interface FieldWriteQuery {
  /** Field API name to match (case-insensitive, bare name). */
  field: string;
  /** Object API name to match. Omit to match any object. */
  object?: string | null;
}

/**
 * Narrow a flow's writes to one field. Writes whose object could not be resolved
 * (`object === null`, always `status: 'inferred'`) are KEPT when an object is
 * supplied — dropping them would silently hide a real write, and keeping them
 * labelled `inferred` is the honest presentation.
 */
export function filterFieldWrites(
  writes: readonly FlowFieldWrite[],
  query: FieldWriteQuery,
): FlowFieldWrite[] {
  const field = str(query.field).toLowerCase();
  if (!field) return [];
  const object = str(query.object).toLowerCase();
  return writes.filter((write) => {
    if (write.field.toLowerCase() !== field) return false;
    if (!object) return true;
    if (write.object === null) return true;
    return write.object.toLowerCase() === object;
  });
}
