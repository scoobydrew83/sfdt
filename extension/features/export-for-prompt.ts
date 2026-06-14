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

/** Escape a value so it is safe to embed in a Markdown table cell. */
function escapeCell(value: string): string {
  return value
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim();
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

/**
 * Resolve the SObject API name for a record. Prefers the name embedded in the
 * URL; otherwise looks it up by key prefix via the global describe (replacing
 * the old hardcoded five-object prefix map).
 */
async function resolveObjectName(
  api: SalesforceApiClient,
  recordContext: { recordId: string; sobjectName?: string },
): Promise<string | null> {
  if (recordContext.sobjectName) return recordContext.sobjectName;
  const prefix = recordContext.recordId.slice(0, 3);
  const global = await api.apiGet<GlobalDescribe>(
    `/services/data/${api.apiVersion}/sobjects/`,
  );
  const match = global?.sobjects?.find((s) => s.keyPrefix === prefix);
  return match ? match.name : null;
}

export function createExportForPromptFeature(options: ExportForPromptOptions = {}): Feature {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  const nav = options.navigator ?? navigator;

  return {
    manifest: {
      id: 'export-for-prompt',
      name: 'Export for Prompt',
      contexts: [CONTEXTS.RECORD_PAGE],
    },

    async onActivate() {
      try {
        const sfApi = getSalesforceApi();
        if (!sfApi) {
          showToast('Salesforce API not available. Please refresh the page.', { kind: 'error', doc });
          return;
        }

        const recordContext = extractRecordContext(win.location.href);
        if (!recordContext?.recordId) {
          showToast('No record context found on this page to export.', { kind: 'warning', doc });
          return;
        }

        showToast('Extracting schema for prompt…', { kind: 'info', doc });

        const objectName = await resolveObjectName(sfApi, recordContext);
        if (!objectName) {
          showToast('Could not resolve the object type for this record.', { kind: 'warning', doc });
          return;
        }

        const describe = await sfApi.apiGet<SObjectDescribe>(
          `/services/data/${sfApi.apiVersion}/sobjects/${objectName}/describe`,
        );
        const markdown = buildSchemaMarkdown(
          objectName,
          describe ?? { name: objectName, label: objectName, fields: [] },
        );

        await nav.clipboard.writeText(markdown);
        showToast(`Schema for ${objectName} copied to clipboard`, { kind: 'success', doc });
      } catch (err) {
        showToast(`Export failed: ${err instanceof Error ? err.message : String(err)}`, { kind: 'error', doc });
      }
    },
  };
}

export function _exportForPromptTestApi() {
  return { buildSchemaMarkdown, escapeCell };
}
