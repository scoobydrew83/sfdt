import { CONTEXTS, extractRecordContext } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import { getSalesforceApi } from '../lib/salesforce-api.js';
import { showToast } from '../ui/toast.js';

export interface ExportForPromptOptions {
  doc?: Document;
  win?: Window;
  navigator?: Navigator;
}

export function createExportForPromptFeature(options: ExportForPromptOptions = {}): Feature {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  const nav = options.navigator ?? navigator;

  return {
    manifest: {
      id: 'export-for-prompt',
      name: 'Export for Prompt',
      contexts: [CONTEXTS.RECORD_PAGE, CONTEXTS.SETUP_OTHER, CONTEXTS.FLOW_BUILDER, CONTEXTS.SETUP_FLOWS],
    },

    async onActivate() {
      try {
        const sfApi = getSalesforceApi();
        if (!sfApi) {
          showToast('Salesforce API not available. Please refresh the page.', { kind: 'error', doc });
          return;
        }

        const recordContext = extractRecordContext(win.location.href);
        let markdown = '';

        if (recordContext?.recordId && recordContext.recordId.length >= 15) {
          showToast('Extracting schema for prompt...', { kind: 'info', doc });

          let objectType = recordContext.sobjectName;

          if (!objectType) {
             const prefix = recordContext.recordId.substring(0, 3);
             const prefixMap: Record<string, string> = {
                 '001': 'Account', '003': 'Contact', '006': 'Opportunity', '00Q': 'Lead', '500': 'Case'
             };
             objectType = prefixMap[prefix];
          }

          if (objectType) {
              const res = await sfApi.query(`SELECT DeveloperName, TableEnumOrId FROM CustomField WHERE TableEnumOrId = '${objectType}'`);
              markdown += `# Schema for ${objectType}\n\n`;
              if (res && res.records && res.records.length > 0) {
                 markdown += `| Field Name |\n`;
                 markdown += `|---|\n`;
                 for (const field of res.records) {
                     markdown += `| \`${(field as any).DeveloperName}\` |\n`;
                 }
              } else {
                 markdown += `Could not retrieve field describe.\n`;
              }
          } else {
             markdown = `# Salesforce Record: ${recordContext.recordId}\n\nNo schema extracted.`;
          }
        } else {
           markdown = `# Context Extract\n\nNo specific record context found to export.`;
        }

        if (markdown) {
           await nav.clipboard.writeText(markdown);
           showToast('Markdown copied to clipboard!', { kind: 'success', doc });
        } else {
           showToast('No data found to export.', { kind: 'warning', doc });
        }

      } catch (err) {
        showToast(`Export failed: ${err instanceof Error ? err.message : String(err)}`, { kind: 'error', doc });
      }
    },
  };
}

export function _exportForPromptTestApi() {
  return {};
}
