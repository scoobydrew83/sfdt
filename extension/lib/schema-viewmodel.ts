// Pure describe -> viewmodel mappers for the Schema Browser (P2-1).
// No DOM, no chrome.*, no I/O — fully unit-testable. The UI layer (a later PR)
// renders these shapes; the mapping/normalisation all lives here.
import type {
  GlobalDescribe,
  SObjectDescribe,
  FieldDescribe,
  ChildRelationship,
} from './describe-cache.js';

export interface ObjectListItem {
  name: string;
  label: string;
  keyPrefix: string | null;
  custom: boolean;
}

// A filterable object-list viewmodel. `custom` is derived from the API-name
// suffix (`__c`) since the global describe entry we cache only carries
// name/label/keyPrefix.
export function toObjectListVM(global: GlobalDescribe): ObjectListItem[] {
  const sobjects = Array.isArray(global?.sobjects) ? global.sobjects : [];
  return sobjects.map((s) => ({
    name: s.name,
    label: s.label,
    keyPrefix: s.keyPrefix ?? null,
    custom: /__c$/i.test(s.name),
  }));
}

export interface FieldRow {
  name: string;
  label: string;
  type: string;
  custom: boolean;
  nillable: boolean;
  length?: number;
  precision?: number;
  scale?: number;
  // Picklist values expanded to plain strings (the raw {value,label} pairs are
  // collapsed to their `value` for display/filtering).
  picklistValues?: string[];
  // Reference (lookup/master-detail) targets and the relationship name.
  referenceTo?: string[];
  relationshipName?: string | null;
  // Formula source, when the field is a formula.
  formula?: string;
  // Set on a compound field (address/geolocation): the component field names.
  components?: string[];
  // Set on a component field: the compound parent it belongs to.
  compoundFieldName?: string | null;
  // Flag columns. Named for the describe attributes rather than the column
  // headers so the mapping stays one-to-one and greppable.
  unique: boolean;
  externalId: boolean;
  autoNumber: boolean;
  calculated: boolean;
  /** Admin help text shown under the field in the UI. Empty when unset. */
  helpText: string;
}

export interface FieldTableVM {
  fields: FieldRow[];
  childRelationships: ChildRelationship[];
}

function isCompoundType(type: string): boolean {
  return type === 'address' || type === 'location';
}

function toFieldRow(field: FieldDescribe, componentsByParent: Map<string, string[]>): FieldRow {
  const row: FieldRow = {
    name: field.name,
    label: field.label,
    type: field.type,
    custom: field.custom ?? /__c$/i.test(field.name),
    nillable: field.nillable,
    // `=== true` rather than a truthiness check or `!== false`: these are
    // optional on FieldDescribe, and an absent value must read as "no", not as
    // "unknown, assume yes". See the DENY-flag note in lib/describe-cache.ts.
    unique: field.unique === true,
    externalId: field.externalId === true,
    autoNumber: field.autoNumber === true,
    calculated: field.calculated === true,
    helpText: typeof field.inlineHelpText === 'string' ? field.inlineHelpText : '',
  };

  if (typeof field.length === 'number') row.length = field.length;
  if (typeof field.precision === 'number') row.precision = field.precision;
  if (typeof field.scale === 'number') row.scale = field.scale;

  if (Array.isArray(field.picklistValues) && field.picklistValues.length > 0) {
    row.picklistValues = field.picklistValues.map((p) => p.value);
  }

  if (field.type === 'reference') {
    row.referenceTo = Array.isArray(field.referenceTo) ? field.referenceTo : [];
    row.relationshipName = field.relationshipName ?? null;
  }

  if (field.calculated && field.calculatedFormula) {
    row.formula = field.calculatedFormula;
  }

  if (isCompoundType(field.type)) {
    row.components = componentsByParent.get(field.name) ?? [];
  }

  if (field.compoundFieldName) {
    row.compoundFieldName = field.compoundFieldName;
  }

  return row;
}

// Field-table viewmodel: flattens compound fields (attaches component names to
// their address/geolocation parent), expands picklists, resolves reference
// targets, surfaces formula source, and carries the child-relationship list.
export function toFieldTableVM(describe: SObjectDescribe): FieldTableVM {
  const fields = Array.isArray(describe?.fields) ? describe.fields : [];

  // Group component fields by their compound parent so the parent row can list
  // its components (e.g. BillingAddress -> [BillingStreet, BillingCity, ...]).
  const componentsByParent = new Map<string, string[]>();
  for (const f of fields) {
    if (f.compoundFieldName) {
      const list = componentsByParent.get(f.compoundFieldName) ?? [];
      list.push(f.name);
      componentsByParent.set(f.compoundFieldName, list);
    }
  }

  return {
    fields: fields.map((f) => toFieldRow(f, componentsByParent)),
    childRelationships: Array.isArray(describe?.childRelationships)
      ? describe.childRelationships
      : [],
  };
}

// Display name per describe type. Salesforce's wire types are not what admins
// call these things ('string' is "Text", 'double' is "Number"), and the type
// column is read by people who think in the Setup vocabulary.
const TYPE_LABELS: Readonly<Record<string, string>> = {
  string: 'Text',
  textarea: 'Long Text',
  boolean: 'Checkbox',
  int: 'Number',
  double: 'Number',
  currency: 'Currency',
  percent: 'Percent',
  date: 'Date',
  datetime: 'Date/Time',
  time: 'Time',
  email: 'Email',
  phone: 'Phone',
  url: 'URL',
  id: 'Id',
  reference: 'Lookup',
  picklist: 'Picklist',
  multipicklist: 'Multi-Picklist',
  combobox: 'Combobox',
  base64: 'File',
  encryptedstring: 'Encrypted Text',
  address: 'Address',
  location: 'Geolocation',
  anyType: 'Any',
  complexvalue: 'Complex',
};

const SIZED_TYPES: ReadonlySet<string> = new Set([
  'string',
  'textarea',
  'email',
  'phone',
  'url',
  'encryptedstring',
]);

const SCALED_TYPES: ReadonlySet<string> = new Set(['currency', 'double', 'percent', 'int']);

/**
 * The type as it should read in the table: `Text(255)`, `Currency(18,0)`,
 * `Lookup`. Falls back to the raw describe type for anything unmapped, so a new
 * Salesforce field type degrades to its wire name rather than to nothing.
 */
export function typeDisplay(row: Pick<FieldRow, 'type' | 'length' | 'precision' | 'scale'>): string {
  const base = TYPE_LABELS[row.type] ?? row.type;
  if (SIZED_TYPES.has(row.type) && typeof row.length === 'number' && row.length > 0) {
    return `${base}(${row.length})`;
  }
  if (SCALED_TYPES.has(row.type) && typeof row.precision === 'number' && row.precision > 0) {
    return `${base}(${row.precision},${row.scale ?? 0})`;
  }
  return base;
}

export interface ObjectMetaVM {
  name: string;
  label: string;
  labelPlural: string;
  keyPrefix: string | null;
  custom: boolean;
  customSetting: boolean;
  searchable: boolean;
  queryable: boolean;
  createable: boolean;
  updateable: boolean;
  deletable: boolean;
  fieldCount: number;
  customFieldCount: number;
}

/**
 * The object-metadata rail. Every value here comes out of the describe the
 * browser has already fetched — no extra call, which is why this section is the
 * one that renders instantly while record count and audit are still loading.
 */
export function toObjectMetaVM(describe: SObjectDescribe): ObjectMetaVM {
  const fields = Array.isArray(describe?.fields) ? describe.fields : [];
  return {
    name: describe.name,
    label: describe.label,
    labelPlural: describe.labelPlural ?? describe.label,
    keyPrefix: describe.keyPrefix ?? null,
    custom: describe.custom === true,
    customSetting: describe.customSetting === true,
    searchable: describe.searchable === true,
    queryable: describe.queryable === true,
    createable: describe.createable === true,
    updateable: describe.updateable === true,
    deletable: describe.deletable === true,
    fieldCount: fields.length,
    customFieldCount: fields.filter((f) => f.custom ?? /__c$/i.test(f.name)).length,
  };
}

/**
 * Per-object custom-field ceiling.
 *
 * Salesforce does not expose this anywhere in the describe or the /limits
 * endpoint — it is an edition property, not org data. 500 is the
 * Enterprise/Unlimited/Performance/Developer figure; Professional is 100. The
 * UI states the assumption on screen rather than presenting the percentage as
 * measured fact, because a Professional org would read 88/500 as comfortable
 * when it is actually over the wall.
 */
export const CUSTOM_FIELD_LIMIT = 500;

// A node graph of the object's immediate relationships. Structurally identical
// to ui/node-graph.ts's NodeGraph — declared here rather than imported so lib/
// keeps no dependency on ui/, and structural typing makes it assignable anyway.
export interface ObjectGraphNode {
  id: string;
  label: string;
  outgoing: Array<{ id: string; missing: boolean }>;
  incoming: string[];
}

export interface ObjectGraphVM {
  nodes: Map<string, ObjectGraphNode>;
  cycles: never[];
  maxDepth: Map<string, number>;
  /** Neighbours dropped by the cap, so the UI can say so instead of lying by omission. */
  truncated: { children: number; parents: number };
}

// An Account has 60+ child relationships. Rendering them all makes a 2000px
// column nobody reads, so the graph shows the first N alphabetically and the
// caller reports the remainder. A cap the user cannot see is a cap that reads
// as "this is everything".
export const MAX_GRAPH_NEIGHBOURS = 12;

/**
 * Build the relationship graph for one object.
 *
 * Columns follow the direction of reference, which is what makes the rendered
 * arrows correct without any special-casing: children (which hold the lookup)
 * sit left, the object itself in the middle, and the objects IT looks up to sit
 * right. Every edge therefore runs left-to-right.
 *
 * Self-references (Account.ParentId → Account) are skipped. They would need a
 * backwards curve from a node to itself, and the field row's Details cell
 * already shows the target — a loop in the picture adds nothing but a artefact.
 */
export function buildObjectGraphVM(root: string, vm: FieldTableVM): ObjectGraphVM {
  const parents = [
    ...new Set(
      vm.fields
        .flatMap((f) => f.referenceTo ?? [])
        .filter((target) => target && target !== root),
    ),
  ].sort((a, b) => a.localeCompare(b));

  const children = [
    ...new Set(
      vm.childRelationships
        .map((c) => c.childSObject)
        .filter((child) => child && child !== root),
    ),
  ].sort((a, b) => a.localeCompare(b));

  const shownParents = parents.slice(0, MAX_GRAPH_NEIGHBOURS);
  const shownChildren = children.slice(0, MAX_GRAPH_NEIGHBOURS);

  const nodes = new Map<string, ObjectGraphNode>();
  const maxDepth = new Map<string, number>();

  for (const child of shownChildren) {
    nodes.set(child, { id: child, label: child, outgoing: [{ id: root, missing: false }], incoming: [] });
    maxDepth.set(child, 0);
  }

  nodes.set(root, {
    id: root,
    label: root,
    outgoing: shownParents.map((p) => ({ id: p, missing: false })),
    incoming: [...shownChildren],
  });
  maxDepth.set(root, 1);

  for (const parent of shownParents) {
    nodes.set(parent, { id: parent, label: parent, outgoing: [], incoming: [root] });
    maxDepth.set(parent, 2);
  }

  return {
    nodes,
    cycles: [],
    maxDepth,
    truncated: {
      children: children.length - shownChildren.length,
      parents: parents.length - shownParents.length,
    },
  };
}

/**
 * The field table as plain rows, for CSV/JSON export.
 *
 * Column order and naming match what the table shows on screen, so a
 * spreadsheet of this is recognisably the same thing the user was looking at —
 * an export whose columns are in describe order and named after wire attributes
 * is a different document that happens to contain the same facts.
 */
export function toExportRows(fields: readonly FieldRow[]): Record<string, unknown>[] {
  return fields.map((f) => ({
    Label: f.label,
    'API Name': f.name,
    Type: typeDisplay(f),
    Length: typeof f.length === 'number' && f.length > 0 ? f.length : '',
    Required: f.nillable ? '' : 'Yes',
    Unique: f.unique ? 'Yes' : '',
    'External Id': f.externalId ? 'Yes' : '',
    Custom: f.custom ? 'Yes' : '',
    'Help Text': f.helpText,
    'Reference To': (f.referenceTo ?? []).join(' '),
    'Picklist Values': (f.picklistValues ?? []).join(' | '),
    Formula: f.formula ?? '',
  }));
}
