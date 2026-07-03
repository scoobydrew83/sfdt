// Smoke tests for the Phase 4 features that ship mostly as scaffolding
// (heavy on DOM mutation against Flow Builder selectors, light on pure
// logic). These confirm each feature registers a stable id and that the
// pure helpers it exposes work; full integration coverage lives where the
// feature has substantial pure logic of its own.

import { describe, it, expect, beforeEach, vi } from 'vitest';

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

// A fetch-backed SalesforceApiClient whose responses are routed by the SOQL
// `q` query param. `route` returns the records array, or throws to simulate a
// failed (4xx) Tooling API call.
function makeRoutedApi(route: (soql: string) => unknown[]): SalesforceApiClient {
  const fetchImpl = (async (url: string | URL | Request) => {
    const soql = new URL(String(url), 'http://x').searchParams.get('q') ?? '';
    let records: unknown[];
    try {
      records = route(soql);
    } catch {
      return { ok: false, status: 400, async json() { return {}; }, async text() { return 'err'; } } as Response;
    }
    return {
      ok: true,
      status: 200,
      async json() { return { size: records.length, done: true, records }; },
      async text() { return '{}'; },
    } as Response;
  }) as typeof fetch;
  return new SalesforceApiClient({
    win: { location: { hostname: 'x.lightning.force.com', origin: 'https://x.lightning.force.com', search: '' } } as never,
    messageBus: {
      sendMessage: (async () => ({ ok: true, sids: { 'https://x.my.salesforce.com': 'sid' } })) as unknown as MessageBus['sendMessage'],
    },
    fetchImpl,
  });
}

const SCHEDULED_METADATA = {
  start: {
    triggerType: 'Scheduled',
    schedule: { frequency: 'Daily', startDate: '2026-04-30', startTime: '08:00:00.000Z' },
    object: 'Account',
  },
};

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

  it('comparison-exporter scrapeDiffRows skips rows with fewer than 5 cells', () => {
    const { scrapeDiffRows } = _comparisonExporterTestApi();
    const table = document.createElement('table');
    table.className = 'slds-table';
    const tbody = document.createElement('tbody');
    const shortRow = document.createElement('tr');
    for (const text of ['only', 'three', 'cells']) {
      const td = document.createElement('td');
      td.textContent = text;
      shortRow.appendChild(td);
    }
    tbody.appendChild(shortRow);
    table.appendChild(tbody);
    document.body.appendChild(table);
    expect(scrapeDiffRows(document)).toHaveLength(0);
  });

  it('comparison-exporter toTsv escapes embedded tabs and newlines', () => {
    const { toTsv } = _comparisonExporterTestApi();
    const tsv = toTsv([
      { element: 'a\tb', change: 'c\nd', fieldChanged: 'Object', oldValue: 'old', newValue: 'new' },
    ]);
    const dataLine = tsv.split('\n')[1]!;
    // Embedded tab in `element` became a space, so the row still has exactly 5 columns.
    expect(dataLine.split('\t')).toHaveLength(5);
    expect(dataLine).toContain('a b');
    expect(dataLine).toContain('c d');
  });

  it('comparison-exporter onActivate warns off the Compare Flows view', () => {
    const win = { location: { href: 'https://example.com/not-salesforce' } } as Window;
    createComparisonExporterFeature({ win }).onActivate?.();
    expect(document.querySelector('.sfdt-toast')?.textContent).toMatch(/Compare Flows view/);
  });

  it('comparison-exporter onActivate warns when there are no comparison rows', () => {
    const win = {
      location: { href: 'https://x.lightning.force.com/builder_platform_interaction/flowBuilder.app?compareTargetFlowId=301AB0000001abcAAA' },
    } as Window;
    createComparisonExporterFeature({ win }).onActivate?.();
    expect(document.querySelector('.sfdt-toast')?.textContent).toMatch(/No comparison rows/);
  });

  it('comparison-exporter onActivate downloads a TSV and reports the row count', () => {
    const win = {
      location: { href: 'https://x.lightning.force.com/builder_platform_interaction/flowBuilder.app?compareTargetFlowId=301AB0000001abcAAA' },
    } as Window;
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

    // happy-dom does not implement URL.createObjectURL; stub it (and a captured
    // anchor click) so triggerDownload runs without hitting the real DOM API.
    const createSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake');
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    let downloadName = '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloadName = this.download;
    });

    try {
      createComparisonExporterFeature({ win }).onActivate?.();
      expect(createSpy).toHaveBeenCalledOnce();
      expect(revokeSpy).toHaveBeenCalledOnce();
      expect(downloadName).toMatch(/^flow-comparison-.*\.tsv$/);
      expect(document.querySelector('.sfdt-toast')?.textContent).toMatch(/Exported 1 comparison row\./);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('flow-trigger-explorer-enhancer groups triggered flows by object and timing', () => {
    const { shapeTriggeredFlows } = _flowTriggerExplorerEnhancerTestApi();
    const groups = shapeTriggeredFlows([
      { ApiName: 'A_After', Label: 'A After', TriggerType: 'RecordAfterSave', RecordTriggerType: 'Update', TriggerObjectOrEventLabel: 'Account', IsActive: true, ActiveVersionId: '301x' },
      { ApiName: 'A_Before', Label: 'A Before', TriggerType: 'RecordBeforeSave', RecordTriggerType: 'Create', TriggerObjectOrEventLabel: 'Account', IsActive: true, ActiveVersionId: '301y' },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.object).toBe('Account');
    // Before Save sorts ahead of After Save.
    expect(groups[0]!.flows.map((f) => f.timing)).toEqual(['BeforeSave', 'AfterSave']);
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
        // FlowDefinition query.
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
      // Flow version queries — return Scheduled vs Autolaunched.
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

  it('scheduled-flow-explorer discoverScheduledFlows returns empty when no flows are active', async () => {
    const { discoverScheduledFlows } = _scheduledFlowExplorerTestApi();
    const api = makeRoutedApi(() => []);
    const result = await discoverScheduledFlows(api);
    expect(result.flows).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('scheduled-flow-explorer discoverScheduledFlows records per-flow read errors', async () => {
    const { discoverScheduledFlows } = _scheduledFlowExplorerTestApi();
    const api = makeRoutedApi((soql) => {
      if (soql.includes('FROM FlowDefinition')) {
        return [
          { Id: '300A', DeveloperName: 'Good', ActiveVersionId: '301A', LatestVersionId: '301A' },
          { Id: '300B', DeveloperName: 'Bad', ActiveVersionId: '301B', LatestVersionId: '301B' },
        ];
      }
      if (soql.includes("'301A'")) {
        return [{ Id: '301A', MasterLabel: 'Good Flow', LastModifiedDate: '2026-04-30T08:00:00.000Z', VersionNumber: 1, Status: 'Active', Metadata: SCHEDULED_METADATA }];
      }
      throw new Error('tooling read failed'); // 301B errors.
    });
    const result = await discoverScheduledFlows(api);
    expect(result.flows.map((f) => f.label)).toEqual(['Good Flow']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.flowDefinitionId).toBe('300B');
  });

  it('scheduled-flow-explorer buildModal renders the empty state when there are no flows', () => {
    const { buildModal } = _scheduledFlowExplorerTestApi();
    document.body.appendChild(buildModal(document, { flows: [], errors: [] }, new Date('2026-06-15T00:00:00Z')));
    expect(document.body.textContent).toContain('No active Schedule-Triggered Flows');
  });

  it('scheduled-flow-explorer buildModal lists each flow with its next run and an error banner', async () => {
    const { discoverScheduledFlows, buildModal } = _scheduledFlowExplorerTestApi();
    const api = makeRoutedApi((soql) => {
      if (soql.includes('FROM FlowDefinition')) {
        return [
          { Id: '300A', DeveloperName: 'Good', ActiveVersionId: '301A', LatestVersionId: '301A' },
          { Id: '300B', DeveloperName: 'Bad', ActiveVersionId: '301B', LatestVersionId: '301B' },
        ];
      }
      if (soql.includes("'301A'")) {
        return [{ Id: '301A', MasterLabel: 'Nightly Sync', LastModifiedDate: '2026-04-30T08:00:00.000Z', VersionNumber: 2, Status: 'Active', Metadata: SCHEDULED_METADATA }];
      }
      throw new Error('boom');
    });
    const result = await discoverScheduledFlows(api);
    document.body.appendChild(buildModal(document, result, new Date('2026-06-15T00:00:00Z')));

    expect(document.body.textContent).toContain('Scheduled Flow Explorer — 1 flow');
    expect(document.body.textContent).toContain('Nightly Sync');
    expect(document.body.textContent).toContain('Daily · Account');
    expect(document.body.textContent).toContain('Next run:');
    expect(document.body.textContent).toContain('could not be loaded');
  });

  it('scheduled-flow-explorer onActivate opens the explorer overlay on a Setup Flows page', async () => {
    const { discoverScheduledFlows } = _scheduledFlowExplorerTestApi();
    void discoverScheduledFlows;
    const api = makeRoutedApi((soql) =>
      soql.includes('FROM FlowDefinition')
        ? [{ Id: '300A', DeveloperName: 'Good', ActiveVersionId: '301A', LatestVersionId: '301A' }]
        : [{ Id: '301A', MasterLabel: 'Nightly', LastModifiedDate: '2026-04-30T08:00:00.000Z', VersionNumber: 1, Status: 'Active', Metadata: SCHEDULED_METADATA }],
    );
    const win = { location: { href: 'https://x.lightning.force.com/lightning/setup/Flows/home' } } as Window;
    const feature = createScheduledFlowExplorerFeature({ api, win, now: () => new Date('2026-06-15T00:00:00Z') });
    await feature.onActivate?.();
    await new Promise((r) => setTimeout(r, 0));

    expect(document.querySelector('.sfdt-view-overlay')).not.toBeNull();
    expect(document.body.textContent).toContain('Nightly');
  });
});
