// Shared, browser-safe metadata-dependency logic (MetadataComponentDependency).
// Pure — used by the Chrome `dependency-explorer`, the GUI Dependency page, and
// the `sfdt dependencies` CLI command, so all three resolve and group identically.

/** Escape single-quotes (and backslashes) for safe inclusion in a SOQL string literal. */
export function escapeSoql(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Metadata types the explorer can resolve to a component Id (CLI single-lookup). */
export type MetadataType =
  | 'ApexClass'
  | 'ApexTrigger'
  | 'ApexPage'
  | 'ApexComponent'
  | 'Flow'
  | 'CustomField'
  | 'LightningComponentBundle'
  | 'AuraDefinitionBundle';

/**
 * Single source of truth for every metadata type the dependency features know
 * about. The CLI resolve map, the picker order, and the GUI graph's selectable
 * source types are all DERIVED from this array — add a type here, once.
 */
export interface MetadataTypeInfo {
  /** MetadataComponentType value, e.g. 'ApexClass'. */
  type: string;
  /** Human label for pickers, e.g. 'Apex Class'. */
  label: string;
  /** Present ⇒ the CLI can resolve a single component of this type to an Id. */
  resolve?: { object: string; nameField: 'Name' | 'DeveloperName' };
  /** Selectable as a source type in the GUI bulk graph. */
  graphSource: boolean;
  /** Checked by default in the GUI graph. */
  graphDefaultOn: boolean;
}

export const METADATA_TYPE_REGISTRY: MetadataTypeInfo[] = [
  { type: 'ApexClass',                label: 'Apex Class',            resolve: { object: 'ApexClass', nameField: 'Name' },                        graphSource: true, graphDefaultOn: true },
  { type: 'ApexTrigger',              label: 'Apex Trigger',          resolve: { object: 'ApexTrigger', nameField: 'Name' },                      graphSource: true, graphDefaultOn: true },
  { type: 'ApexPage',                 label: 'Visualforce Page',      resolve: { object: 'ApexPage', nameField: 'Name' },                         graphSource: true, graphDefaultOn: true },
  { type: 'ApexComponent',            label: 'Visualforce Component', resolve: { object: 'ApexComponent', nameField: 'Name' },                    graphSource: true, graphDefaultOn: true },
  { type: 'Flow',                     label: 'Flow',                  resolve: { object: 'FlowDefinition', nameField: 'DeveloperName' },           graphSource: true, graphDefaultOn: true },
  { type: 'LightningComponentBundle', label: 'LWC',                   resolve: { object: 'LightningComponentBundle', nameField: 'DeveloperName' }, graphSource: true, graphDefaultOn: true },
  { type: 'AuraDefinitionBundle',     label: 'Aura Component',        resolve: { object: 'AuraDefinitionBundle', nameField: 'DeveloperName' },     graphSource: true, graphDefaultOn: true },
  { type: 'CustomObject',             label: 'Custom Object',         /* GUI-only: no CLI resolve */                                              graphSource: true, graphDefaultOn: false },
  { type: 'CustomField',              label: 'Custom Field',          resolve: { object: 'CustomField', nameField: 'DeveloperName' },             graphSource: true, graphDefaultOn: false },
];

// Per type: which Tooling object holds the Id, and which field carries the
// developer-entered name. Derived from the registry so it never drifts.
const RESOLVE: Record<string, { object: string; nameField: 'Name' | 'DeveloperName' }> =
  Object.fromEntries(
    METADATA_TYPE_REGISTRY.filter((m) => m.resolve).map((m) => [m.type, m.resolve!]),
  );

/** The order types appear in a picker (CLI-resolvable types). */
export const METADATA_TYPES = Object.keys(RESOLVE);

/** Selectable source types for the GUI bulk dependency graph, with defaults. */
export interface GraphSourceType {
  type: string;
  label: string;
  graphDefaultOn: boolean;
}
export const GRAPH_SOURCE_TYPES: GraphSourceType[] = METADATA_TYPE_REGISTRY
  .filter((m) => m.graphSource)
  .map(({ type, label, graphDefaultOn }) => ({ type, label, graphDefaultOn }));

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
