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
