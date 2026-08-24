// Automation state — what is switched on, and what it takes to switch it off.
//
// ---------------------------------------------------------------------------
// The thing their SwitchBoard hides
// ---------------------------------------------------------------------------
// A grid of on/off toggles implies every row costs the same. It does not. The
// five kinds of Salesforce automation are written three different ways, and two
// of them are not a record update at all:
//
//   Flow, ValidationRule, DuplicateRule  → a Tooling `Metadata` write
//   WorkflowRule, ApexTrigger            → a METADATA DEPLOY
//
// And in production an Apex trigger's `Status` cannot change any other way,
// because a trigger's status is part of its source: flipping it is a code
// deployment, with the test run that implies. A single button that hides that
// distinction is the failure mode this module exists to avoid — every descriptor
// carries its write mechanism, and the caller is expected to surface it.
//
// ---------------------------------------------------------------------------
// Process Builder is not a sixth type
// ---------------------------------------------------------------------------
// A Process Builder process IS a Flow (it differs only by `ProcessType`), so
// `FlowDefinition` already covers it. Their feature list names it separately;
// listing it as its own row here would be marketing, not modelling.
//
// ---------------------------------------------------------------------------
// A Tooling `Metadata` write is read-modify-write of the WHOLE object
// ---------------------------------------------------------------------------
// `Metadata` is a compound field. Writing `{ active: false }` to a
// ValidationRule does not merge — it replaces, and the rule's formula and error
// message go with it. So every Tooling toggle must read the current `Metadata`,
// change exactly one key, and send all of it back. That is the single most
// dangerous operation in this module, and it is also why the before-state comes
// for free: the object you read IS the thing to put back.
//
// `FlowDefinition.Metadata` is the exception that makes the danger easy to miss
// — it carries almost nothing besides `activeVersionNumber`, so the existing
// flow-rollback code can write it wholesale without appearing to read first.

import { escapeSoql } from './dependencies.js';

/** How a type's on/off state is written. */
export type AutomationWriteMode = 'tooling-metadata' | 'metadata-deploy';

export interface AutomationType {
  /** Stable id used on the command line and as the ledger `kind` suffix. */
  id: string;
  label: string;
  /** Tooling sObject queried for state. */
  sobject: string;
  /** Metadata API type name, for the deploy path. */
  metadataType: string;
  writeMode: AutomationWriteMode;
  /**
   * Why this type is written the way it is — surfaced to the user rather than
   * left as tribal knowledge, because the cost differs per mode.
   */
  writeNote: string;
}

export const AUTOMATION_TYPES: readonly AutomationType[] = [
  {
    id: 'flow',
    label: 'Flow (incl. Process Builder)',
    sobject: 'FlowDefinition',
    metadataType: 'Flow',
    writeMode: 'tooling-metadata',
    writeNote:
      'Activating or deactivating a flow sets FlowDefinition.Metadata.activeVersionNumber ' +
      '(0 = off). No source is redeployed, and the previously active VERSION NUMBER is what has ' +
      'to be recorded to put it back — deactivating discards it.',
  },
  {
    id: 'validation-rule',
    label: 'Validation rule',
    sobject: 'ValidationRule',
    metadataType: 'ValidationRule',
    writeMode: 'tooling-metadata',
    writeNote:
      "The rule's whole Metadata object is read, its `active` flag changed, and all of it written " +
      'back — Metadata replaces rather than merges, so a partial write would discard the formula.',
  },
  {
    id: 'duplicate-rule',
    label: 'Duplicate rule',
    sobject: 'DuplicateRule',
    metadataType: 'DuplicateRule',
    writeMode: 'tooling-metadata',
    writeNote:
      "Same read-modify-write as a validation rule, on the rule's `isActive` flag.",
  },
  {
    id: 'workflow-rule',
    label: 'Workflow rule',
    sobject: 'WorkflowRule',
    metadataType: 'WorkflowRule',
    writeMode: 'metadata-deploy',
    writeNote:
      'Workflow rules are not reliably writable through the Tooling API, so toggling one is a ' +
      'metadata retrieve, edit and deploy. Slower than a record update, and in production it ' +
      'runs tests.',
  },
  {
    id: 'apex-trigger',
    label: 'Apex trigger',
    sobject: 'ApexTrigger',
    metadataType: 'ApexTrigger',
    writeMode: 'metadata-deploy',
    writeNote:
      "A trigger's Status is part of its source. In production it CANNOT be changed by a record " +
      'update at all — toggling one is a deployment, with the test run that implies. This is the ' +
      'row where a uniform on/off button is most misleading.',
  },
];

export function findAutomationType(id: string): AutomationType | null {
  const needle = id.trim().toLowerCase();
  return (
    AUTOMATION_TYPES.find((t) => t.id === needle) ??
    AUTOMATION_TYPES.find((t) => t.sobject.toLowerCase() === needle) ??
    null
  );
}

// --------------------------------------------------------------------------
// Queries
// --------------------------------------------------------------------------
//
// These deliberately differ from the `audit inactive-*` checks in two ways that
// matter: they select `Id` (without which a row cannot be acted on) and they
// query BOTH states (the audit checks filter to inactive only, because they
// answer "is anything switched off?" rather than "what is the state of
// everything?").

export function automationListQuery(type: AutomationType): string {
  switch (type.id) {
    case 'flow':
      return (
        'SELECT Id, DeveloperName, ActiveVersionId, ActiveVersion.VersionNumber,' +
        ' LatestVersion.VersionNumber FROM FlowDefinition ORDER BY DeveloperName'
      );
    case 'validation-rule':
      return (
        'SELECT Id, ValidationName, Active, EntityDefinition.QualifiedApiName' +
        ' FROM ValidationRule ORDER BY ValidationName'
      );
    case 'duplicate-rule':
      return 'SELECT Id, DeveloperName, MasterLabel, IsActive FROM DuplicateRule ORDER BY DeveloperName';
    case 'workflow-rule':
      return 'SELECT Id, Name, TableEnumOrId, Active FROM WorkflowRule ORDER BY Name';
    case 'apex-trigger':
      return (
        "SELECT Id, Name, Status, TableEnumOrId FROM ApexTrigger WHERE NamespacePrefix = null" +
        ' ORDER BY Name'
      );
    default:
      throw new Error(`No list query for automation type "${type.id}".`);
  }
}

/** One component's `Metadata`, for the read half of a read-modify-write. */
export function metadataFetchQuery(type: AutomationType, id: string): string {
  return `SELECT Id, Metadata FROM ${type.sobject} WHERE Id = '${escapeSoql(id)}' LIMIT 1`;
}

// --------------------------------------------------------------------------
// Rows
// --------------------------------------------------------------------------

export interface AutomationRow {
  typeId: string;
  typeLabel: string;
  id: string;
  name: string;
  /** Object the automation hangs off, where the type has one. */
  object: string | null;
  active: boolean;
  /** Flows only — the version that is active, which deactivating would discard. */
  activeVersion: number | null;
  writeMode: AutomationWriteMode;
}

export function toAutomationRow(type: AutomationType, record: Record<string, unknown>): AutomationRow | null {
  const id = typeof record.Id === 'string' ? record.Id : null;
  if (!id) return null;
  const base = { typeId: type.id, typeLabel: type.label, id, writeMode: type.writeMode };

  switch (type.id) {
    case 'flow': {
      const activeVersion = (record.ActiveVersion as Record<string, unknown> | undefined)?.VersionNumber;
      return {
        ...base,
        name: String(record.DeveloperName ?? id),
        object: null,
        active: record.ActiveVersionId != null,
        activeVersion: typeof activeVersion === 'number' ? activeVersion : null,
      };
    }
    case 'validation-rule':
      return {
        ...base,
        name: String(record.ValidationName ?? id),
        object:
          ((record.EntityDefinition as Record<string, unknown> | undefined)?.QualifiedApiName as string) ?? null,
        active: record.Active === true,
        activeVersion: null,
      };
    case 'duplicate-rule':
      return {
        ...base,
        name: String(record.DeveloperName ?? record.MasterLabel ?? id),
        object: null,
        active: record.IsActive === true,
        activeVersion: null,
      };
    case 'workflow-rule':
      return {
        ...base,
        name: String(record.Name ?? id),
        object: (record.TableEnumOrId as string) ?? null,
        active: record.Active === true,
        activeVersion: null,
      };
    case 'apex-trigger':
      return {
        ...base,
        name: String(record.Name ?? id),
        object: (record.TableEnumOrId as string) ?? null,
        // A trigger has three statuses; only 'Active' is on. 'Deleted' is
        // neither on nor a normal state, and lumping it with Inactive would
        // offer a toggle that cannot work.
        active: record.Status === 'Active',
        activeVersion: null,
      };
    default:
      return null;
  }
}

/**
 * Change exactly one key in a Metadata object, preserving everything else.
 *
 * The whole point: `{ ...metadata, [key]: value }` rather than `{ [key]: value }`.
 * The second form compiles, reads fine, and silently destroys a validation
 * rule's formula the first time it runs.
 */
export function toggledMetadata(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
  value: unknown,
): Record<string, unknown> {
  if (metadata == null || typeof metadata !== 'object') {
    throw new Error(
      `Refusing to write Metadata that was never read — a Metadata write REPLACES the object, so ` +
        `sending only "${key}" would discard everything else on it.`,
    );
  }
  return { ...metadata, [key]: value };
}

/** Which Metadata key carries the on/off state, per type. */
export function activeMetadataKey(type: AutomationType): string {
  switch (type.id) {
    case 'flow':
      return 'activeVersionNumber';
    case 'validation-rule':
      return 'active';
    case 'duplicate-rule':
      return 'isActive';
    default:
      throw new Error(`${type.label} is not toggled through Tooling Metadata.`);
  }
}

export interface AutomationGridVM {
  org: string | null;
  rows: AutomationRow[];
  counts: { total: number; active: number; inactive: number; byType: Record<string, number> };
  notes: string[];
}

export interface AutomationQueries {
  /** Tooling SOQL. Rejections MUST throw, never resolve empty. */
  toolingQuery<T>(soql: string): Promise<{ records: T[] }>;
}

/**
 * List every automation component and its state.
 *
 * A type whose query is refused becomes a note rather than an exception: some
 * orgs reject `WorkflowRule` outright because the feature is not enabled, and
 * losing the other four types over that would be absurd. But an empty list from
 * a REFUSED query is never reported as "this org has none".
 */
export async function buildAutomationGrid(
  q: AutomationQueries,
  { org = null, types = AUTOMATION_TYPES }: { org?: string | null; types?: readonly AutomationType[] } = {},
): Promise<AutomationGridVM> {
  const rows: AutomationRow[] = [];
  const notes: string[] = [];

  for (const type of types) {
    try {
      const result = await q.toolingQuery<Record<string, unknown>>(automationListQuery(type));
      for (const record of result.records) {
        const row = toAutomationRow(type, record);
        if (row) rows.push(row);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // An org without the workflow feature rejects the object outright. That
      // is "not applicable here", not a failure — and it is not "none exist".
      if (/cannot use|invalid_type/i.test(message)) {
        notes.push(`${type.label}s are not available in this org, so none were listed.`);
      } else {
        notes.push(
          `${type.label}s could not be listed (${message}), so NONE are shown for that type — a ` +
            `failed query, not a finding that this org has none.`,
        );
      }
    }
  }

  rows.sort(
    (a, b) => a.typeId.localeCompare(b.typeId) || a.name.localeCompare(b.name),
  );

  const deployTypes = [...new Set(rows.filter((r) => r.writeMode === 'metadata-deploy').map((r) => r.typeLabel))];
  if (deployTypes.length > 0) {
    notes.push(
      `${deployTypes.join(' and ')} cannot be toggled by a record update — changing one is a ` +
        `metadata deploy, which is slower and, in production, runs tests. They are shown in the ` +
        `same grid but they do not cost the same.`,
    );
  }

  const byType: Record<string, number> = {};
  for (const row of rows) byType[row.typeId] = (byType[row.typeId] ?? 0) + 1;

  return {
    org,
    rows,
    counts: {
      total: rows.length,
      active: rows.filter((r) => r.active).length,
      inactive: rows.filter((r) => !r.active).length,
      byType,
    },
    notes,
  };
}
