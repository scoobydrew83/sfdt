// Shared, browser-safe metadata-dependency logic (MetadataComponentDependency).
// Pure — used by the Chrome `dependency-explorer`, the GUI Dependency page, and
// the `sfdt dependencies` CLI command, so all three resolve and group identically.

/** Escape single-quotes (and backslashes) for safe inclusion in a SOQL string literal. */
export function escapeSoql(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Metadata types the explorer can resolve to a component Id. */
export type MetadataType =
  | 'ApexClass'
  | 'ApexTrigger'
  | 'ApexPage'
  | 'Flow'
  | 'CustomField'
  | 'LightningComponentBundle';

// Per type: which Tooling object holds the Id, and which field carries the
// developer-entered name. Apex* objects key on `Name`; Flow/LWC/CustomField
// are stored under their own definition objects keyed on `DeveloperName`.
const RESOLVE: Record<string, { object: string; nameField: 'Name' | 'DeveloperName' }> = {
  ApexClass: { object: 'ApexClass', nameField: 'Name' },
  ApexTrigger: { object: 'ApexTrigger', nameField: 'Name' },
  ApexPage: { object: 'ApexPage', nameField: 'Name' },
  Flow: { object: 'FlowDefinition', nameField: 'DeveloperName' },
  LightningComponentBundle: { object: 'LightningComponentBundle', nameField: 'DeveloperName' },
  CustomField: { object: 'CustomField', nameField: 'DeveloperName' },
};

/** The order types appear in a picker. */
export const METADATA_TYPES = Object.keys(RESOLVE);

/** Build the SOQL that resolves a name+type to its component Id (quote-escaped). */
export function resolveQueryFor(type: string, name: string): string {
  const cfg = RESOLVE[type];
  if (!cfg) throw new Error(`Unsupported metadata type: ${type}`);
  return `SELECT Id FROM ${cfg.object} WHERE ${cfg.nameField}='${escapeSoql(name)}'`;
}

/** Tooling SOQL for the components a given Id REFERENCES (this → others). */
export function referencesQuery(id: string): string {
  return `SELECT RefMetadataComponentName, RefMetadataComponentType FROM MetadataComponentDependency WHERE MetadataComponentId = '${escapeSoql(id)}' ORDER BY RefMetadataComponentType, RefMetadataComponentName`;
}

/** Tooling SOQL for the components that REFERENCE a given Id (others → this). */
export function referencedByQuery(id: string): string {
  return `SELECT MetadataComponentName, MetadataComponentType FROM MetadataComponentDependency WHERE RefMetadataComponentId = '${escapeSoql(id)}' ORDER BY MetadataComponentType, MetadataComponentName`;
}

export interface DependencyGroup {
  type: string;
  names: string[];
}

/**
 * Collapse dependency rows into per-type groups, sorted by type then name.
 * `nameKey`/`typeKey` differ between the two dependency queries
 * (Ref* for references, plain for referenced-by).
 */
export function groupByType(
  rows: Array<Record<string, unknown>>,
  nameKey: string,
  typeKey: string,
): DependencyGroup[] {
  const byType = new Map<string, string[]>();
  for (const row of rows) {
    const type = String(row[typeKey] ?? '(unknown)');
    const name = String(row[nameKey] ?? '(unknown)');
    const list = byType.get(type) ?? [];
    list.push(name);
    byType.set(type, list);
  }
  return [...byType.entries()]
    .map(([type, names]) => ({ type, names: names.sort((a, b) => a.localeCompare(b)) }))
    .sort((a, b) => a.type.localeCompare(b.type));
}
