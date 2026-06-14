import { CONTEXTS, extractRecordContext } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import { getSalesforceApi, type SalesforceApiClient } from '../lib/salesforce-api.js';
import { showToast } from '../ui/toast.js';

export interface ExportForPromptOptions {
  doc?: Document;
  win?: Window;
  navigator?: Navigator;
}

interface FieldDescribe {
  name: string;
  label: string;
  type: string;
  nillable: boolean;
  inlineHelpText: string | null;
}

interface SObjectDescribe {
  name: string;
  label: string;
  fields: FieldDescribe[];
}

interface GlobalDescribe {
  sobjects: { name: string; keyPrefix: string | null }[];
}

/** Salesforce 15- or 18-char record/entity id. */
const SF_ID_RE = /^[a-zA-Z0-9]{15,18}$/;

/** Escape a value so it is safe to embed in a Markdown table cell. */
function escapeCell(value: string): string {
  return value
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim();
}

/**
 * Extract the object segment from a Lightning Object Manager setup URL, e.g.
 * `/lightning/setup/ObjectManager/Account/FieldsAndRelationships/view` → `Account`.
 * Returns null for the Object Manager landing page (`.../ObjectManager/home/...`)
 * and any non–Object Manager URL. The segment is usually the API name, but can
 * be a durable entity id for some custom objects — callers resolve that.
 */
export function extractSetupObject(url: string): string | null {
  const m = /\/lightning\/setup\/ObjectManager\/([^/?#]+)/i.exec(url);
  if (!m) return null;
  let seg: string;
  try {
    seg = decodeURIComponent(m[1]!);
  } catch {
    seg = m[1]!;
  }
  if (!seg || seg.toLowerCase() === 'home') return null;
  return seg;
}

/**
 * Build a dense Markdown schema table optimised for LLM prompts. Includes all
 * fields (standard + custom) with type, required, and inline help text so the
 * model gets maximum signal per token.
 */
export function buildSchemaMarkdown(objectName: string, describe: SObjectDescribe): string {
  const lines: string[] = [`# Schema: ${objectName}`, ''];
  const fields = describe.fields ?? [];
  if (fields.length === 0) {
    lines.push('_No fields returned from describe._');
    return lines.join('\n');
  }
  lines.push('| Field | Label | Type | Required | Description |');
  lines.push('|---|---|---|---|---|');
  for (const f of fields) {
    const required = f.nillable === false ? 'Yes' : 'No';
    const description = escapeCell(f.inlineHelpText ?? '');
    lines.push(
      `| \`${f.name}\` | ${escapeCell(f.label)} | ${f.type} | ${required} | ${description} |`,
    );
  }
  return lines.join('\n');
}

/** Look up an object's API name from a record key prefix via the global describe. */
async function resolveApiNameFromKeyPrefix(
  api: SalesforceApiClient,
  prefix: string,
): Promise<string | null> {
  const global = await api.apiGet<GlobalDescribe>(
    `/services/data/${api.apiVersion}/sobjects/`,
  );
  const match = global?.sobjects?.find((s) => s.keyPrefix === prefix);
  return match ? match.name : null;
}

/**
 * Resolve the target SObject API name for the current page — either an Object
 * Manager setup page or a record page. Returns null when neither applies.
 */
async function resolveTargetObject(
  api: SalesforceApiClient,
  url: string,
): Promise<string | null> {
  const setupSegment = extractSetupObject(url);
  // The segment is the API name for standard objects and most custom objects;
  // describeObject() falls back to an entity-id lookup when it isn't.
  if (setupSegment) return setupSegment;

  const recordContext = extractRecordContext(url);
  if (recordContext?.recordId) {
    if (recordContext.sobjectName) return recordContext.sobjectName;
    return resolveApiNameFromKeyPrefix(api, recordContext.recordId.slice(0, 3));
  }
  return null;
}

/**
 * Describe an object by API name. If the name is actually a durable entity id
 * (custom objects in some Object Manager URLs), resolve it to a QualifiedApiName
 * via the Tooling API and retry. Returns null when the object can't be described.
 */
async function describeObject(
  api: SalesforceApiClient,
  nameOrId: string,
): Promise<SObjectDescribe | null> {
  try {
    return await api.apiGet<SObjectDescribe>(
      `/services/data/${api.apiVersion}/sobjects/${encodeURIComponent(nameOrId)}/describe`,
    );
  } catch {
    if (!SF_ID_RE.test(nameOrId)) return null;
    try {
      const res = await api.toolingQuery<{ QualifiedApiName: string }>(
        `SELECT QualifiedApiName FROM EntityDefinition WHERE DurableId = '${nameOrId}'`,
      );
      const apiName = res?.records?.[0]?.QualifiedApiName;
      if (!apiName) return null;
      return await api.apiGet<SObjectDescribe>(
        `/services/data/${api.apiVersion}/sobjects/${encodeURIComponent(apiName)}/describe`,
      );
    } catch {
      return null;
    }
  }
}

export function createExportForPromptFeature(options: ExportForPromptOptions = {}): Feature {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  const nav = options.navigator ?? navigator;

  return {
    manifest: {
      id: 'export-for-prompt',
      name: 'Export for Prompt',
      contexts: [CONTEXTS.RECORD_PAGE, CONTEXTS.SETUP_OTHER],
    },

    async onActivate() {
      try {
        const sfApi = getSalesforceApi();
        if (!sfApi) {
          showToast('Salesforce API not available. Please refresh the page.', { kind: 'error', doc });
          return;
        }

        const objectName = await resolveTargetObject(sfApi, win.location.href);
        if (!objectName) {
          showToast('Open a record or an Object Manager page to export its schema.', {
            kind: 'warning',
            doc,
          });
          return;
        }

        showToast('Extracting schema for prompt…', { kind: 'info', doc });

        const describe = await describeObject(sfApi, objectName);
        if (!describe) {
          showToast(`Could not describe object "${objectName}".`, { kind: 'error', doc });
          return;
        }

        const resolvedName = describe.name || objectName;
        const markdown = buildSchemaMarkdown(resolvedName, describe);
        await nav.clipboard.writeText(markdown);
        showToast(`Schema for ${resolvedName} copied to clipboard`, { kind: 'success', doc });
      } catch (err) {
        showToast(`Export failed: ${err instanceof Error ? err.message : String(err)}`, { kind: 'error', doc });
      }
    },
  };
}

export function _exportForPromptTestApi() {
  return { buildSchemaMarkdown, escapeCell, extractSetupObject };
}
