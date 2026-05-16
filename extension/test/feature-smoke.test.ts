import { describe, it, expect, beforeEach } from 'vitest';
import { createFlowVersionManagerFeature, _flowVersionManagerTestApi } from '../features/flow-version-manager.js';
import { createComparisonExporterFeature, _comparisonExporterTestApi } from '../features/comparison-exporter.js';
import {
  createFlowTriggerExplorerEnhancerFeature,
  _flowTriggerExplorerEnhancerTestApi,
} from '../features/flow-trigger-explorer-enhancer.js';
import { createApiNameGeneratorFeature } from '../features/api-name-generator.js';
import { createAiAssistantFeature } from '../features/ai-assistant.js';
import { createScheduledFlowExplorerFeature, _scheduledFlowExplorerTestApi } from '../features/scheduled-flow-explorer.js';
import { ApiNameLibrary } from '@sfdt/flow-core';
import { SalesforceApiClient, type MessageBus } from '../lib/salesforce-api.js';
beforeEach(() => {
  document.body.replaceChildren();
});
describe('extension/features — smoke', () => {
  it('flow-version-manager registers with the right id', () => {
    expect(createFlowVersionManagerFeature().manifest.id).toBe('flow-version-manager');
  });
  it('flow-version-manager extracts row meta from a versions table row', () => {
    const { extractRowMeta } = _flowVersionManagerTestApi();
    const row = document.createElement('tr');
    row.className = 'dataRow';
    for (let i = 0; i < 9; i += 1) {
      const td = document.createElement('td');
      td.className = 'dataCell';
      row.appendChild(td);
    }
    const cells = row.querySelectorAll('td');
    cells[1]!.textContent = 'My Flow';
    cells[2]!.textContent = ' 3 ';
    cells[7]!.textContent = 'Inactive';
    const deleteLink = document.createElement('a');
    deleteLink.id = 'thePage:thePageBlock:versionsBlock:versionsRepeat:0:deleteLink';
    deleteLink.setAttribute('onclick', "if(confirmDelete()){currVersionId,301AB0000001abcAAA};return false;");
    row.appendChild(deleteLink);
    const meta = extractRowMeta(row);
    expect(meta).not.toBeNull();
    expect(meta!.versionId).toBe('301AB0000001abcAAA');
    expect(meta!.versionLabel).toBe('Version 3');
    expect(meta!.canDelete).toBe(true);
  });
  it('comparison-exporter scrapes diff rows', () => {
    const { scrapeDiffRows, toTsv } = _comparisonExporterTestApi();
    const table = document.createElement('table');
    table.className = 'slds-table';
    const tbody = document.createElement('tbody');
    const row = document.createElement('tr');
    for (const text of ['Get_Account', 'Modified', 'Object', 'Account', 'Contact']) {
      const td = document.createElement('td');
      td.textContent = text;
      row.appendChild(td);
    }
    tbody.appendChild(row);
    table.appendChild(tbody);
    document.body.appendChild(table);
    const rows = scrapeDiffRows(document);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ element: 'Get_Account', change: 'Modified' });
    expect(toTsv(rows)).toContain('Element\tChange\tField Changed\tOld Value\tNew Value');
  });
  it('comparison-exporter registers and feature id is stable', () => {
    expect(createComparisonExporterFeature().manifest.id).toBe('comparison-exporter');
  });
  it('flow-trigger-explorer-enhancer batches FlowDefinition fetches into a single IN-clause query per chunk', async () => {
    const { batchFetchFlowDefinitions } = _flowTriggerExplorerEnhancerTestApi();
    const queries: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      const params = new URL(u, 'http://x').searchParams;
      queries.push(params.get('q') ?? '');
      return {
        ok: true,
        status: 200,
        async json() {
          return { records: [], size: 0, done: true };
        },
        async text() {
          return '{}';
        },
      } as Response;
    }) as typeof fetch;
    const api = new SalesforceApiClient({
      win: { location: { hostname: 'x.lightning.force.com', origin: 'https://x.lightning.force.com', search: '' } } as never,
      messageBus: {
        sendMessage: (async () => ({ ok: true, sids: { 'https://x.my.salesforce.com': 'sid' } })) as unknown as MessageBus['sendMessage'],
      },
      fetchImpl,
    });
    const ids = Array.from({ length: 110 }, (_, i) => `30100000000${i.toString(16).padStart(4, '0')}`);
    await batchFetchFlowDefinitions(api, ids, 50);
    expect(queries).toHaveLength(3);
    expect(queries[0]).toMatch(/FROM FlowDefinition WHERE Id IN/);
  });
  it('flow-trigger-explorer-enhancer feature id is stable', () => {
    expect(createFlowTriggerExplorerEnhancerFeature().manifest.id).toBe('flow-trigger-explorer-enhancer');
  });
  it('api-name-generator opens a working modal that previews expansions', async () => {
    const library = new ApiNameLibrary();
    await library.load();
    const feature = createApiNameGeneratorFeature({ library });
    await feature.onActivate?.();
    const labelInput = document.querySelector<HTMLInputElement>('input[type="text"]');
    const typeSelect = document.querySelectorAll<HTMLSelectElement>('select')[0];
    const patternSelect = document.querySelectorAll<HTMLSelectElement>('select')[1];
    const preview = document.querySelector<HTMLElement>(
      'div[style*="monospace"]',
    );
    expect(labelInput).not.toBeNull();
    expect(typeSelect).not.toBeNull();
    expect(patternSelect).not.toBeNull();
    labelInput!.value = 'Active Accounts';
    typeSelect!.value = 'Get Records';
    labelInput!.dispatchEvent(new Event('input', { bubbles: true }));
    expect(preview?.textContent).toBe('Get_Active_Accounts');
  });
  it('ai-assistant feature id is stable and registers without crashing', () => {
    expect(createAiAssistantFeature().manifest.id).toBe('ai-assistant');
  });
  it('scheduled-flow-explorer discoverScheduledFlows returns only Schedule-Triggered flows', async () => {
    const { discoverScheduledFlows } = _scheduledFlowExplorerTestApi();
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      if (call === 1) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              size: 2,
              done: true,
              records: [
                { Id: '300A', DeveloperName: 'Scheduled_One', ActiveVersionId: '301A' },
                { Id: '300B', DeveloperName: 'Autolaunched_One', ActiveVersionId: '301B' },
              ],
            };
          },
          async text() {
            return '{}';
          },
        } as Response;
      }
      const isScheduled = call === 2;
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            size: 1,
            done: true,
            records: [
              {
                Id: isScheduled ? '301A' : '301B',
                MasterLabel: isScheduled ? 'Scheduled Flow' : 'Autolaunched Flow',
                LastModifiedDate: '2026-06-01T10:00:00.000Z',
                VersionNumber: 1,
                Status: 'Active',
                Metadata: isScheduled
                  ? {
                      start: {
                        triggerType: 'Scheduled',
                        schedule: { frequency: 'Daily', startDate: '2026-04-30', startTime: '08:00:00.000Z' },
                        object: 'Account',
                      },
                    }
                  : { start: { triggerType: 'RecordAfterSave' } },
              },
            ],
          };
        },
        async text() {
          return '{}';
        },
      } as Response;
    }) as typeof fetch;
    const api = new SalesforceApiClient({
      win: { location: { hostname: 'x.lightning.force.com', origin: 'https://x.lightning.force.com', search: '' } } as never,
      messageBus: {
        sendMessage: (async () => ({ ok: true, sids: { 'https://x.my.salesforce.com': 'sid' } })) as unknown as MessageBus['sendMessage'],
      },
      fetchImpl,
    });
    const result = await discoverScheduledFlows(api);
    expect(result.flows).toHaveLength(1);
    expect(result.flows[0]!.label).toBe('Scheduled Flow');
  });
  it('scheduled-flow-explorer feature id is stable', () => {
    expect(createScheduledFlowExplorerFeature().manifest.id).toBe('scheduled-flow-explorer');
  });
});
