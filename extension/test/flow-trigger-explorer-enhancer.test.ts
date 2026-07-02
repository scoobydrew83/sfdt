import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createFlowTriggerExplorerEnhancerFeature,
  shapeTriggeredFlows,
  triggerTiming,
  flowBuilderUrl,
  type FlowDefinitionViewRow,
} from '../features/flow-trigger-explorer-enhancer.js';
import { setWorkspaceViewSink } from '../ui/present-view.js';
import type { SalesforceApiClient } from '../lib/salesforce-api.js';

function clearBody(): void {
  document.body.innerHTML = '';
  setWorkspaceViewSink(null);
  window.history.replaceState({}, '', 'https://x.lightning.force.com/interaction_explorer/flowExplorer');
}

function fakeApi(query: (soql: string) => Promise<{ records: unknown[]; totalSize: number; done: boolean }>): SalesforceApiClient {
  return { query } as unknown as SalesforceApiClient;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

const ROWS: FlowDefinitionViewRow[] = [
  { ApiName: 'Acc_After', Label: 'Account After', TriggerType: 'RecordAfterSave', RecordTriggerType: 'CreateAndUpdate', TriggerObjectOrEventLabel: 'Account', IsActive: true, ActiveVersionId: '301000000000001', ProcessType: 'AutoLaunchedFlow' },
  { ApiName: 'Acc_Before', Label: 'Account Before', TriggerType: 'RecordBeforeSave', RecordTriggerType: 'Update', TriggerObjectOrEventLabel: 'Account', IsActive: true, ActiveVersionId: '301000000000002', ProcessType: 'AutoLaunchedFlow' },
  { ApiName: 'Con_Del', Label: 'Contact Delete', TriggerType: 'RecordBeforeDelete', RecordTriggerType: 'Delete', TriggerObjectOrEventLabel: 'Contact', IsActive: true, ActiveVersionId: '301000000000003', ProcessType: 'AutoLaunchedFlow' },
];

describe('triggerTiming', () => {
  it('maps TriggerType to a timing bucket', () => {
    expect(triggerTiming('RecordBeforeSave')).toBe('BeforeSave');
    expect(triggerTiming('RecordAfterSave')).toBe('AfterSave');
    expect(triggerTiming('RecordBeforeDelete')).toBe('BeforeDelete');
    expect(triggerTiming('Scheduled')).toBe('Other');
    expect(triggerTiming(undefined)).toBe('Other');
  });
});

describe('shapeTriggeredFlows', () => {
  it('groups by object and sorts before-save before after-save before-delete', () => {
    const groups = shapeTriggeredFlows(ROWS);
    expect(groups.map((g) => g.object)).toEqual(['Account', 'Contact']); // alphabetical
    // Within Account: Before Save must come before After Save.
    expect(groups[0]!.flows.map((f) => f.timing)).toEqual(['BeforeSave', 'AfterSave']);
    expect(groups[0]!.flows[0]!.event).toBe('on Update');
    expect(groups[0]!.flows[1]!.event).toBe('on Create or Update');
    expect(groups[1]!.flows[0]!.timingLabel).toBe('Before Delete');
  });

  it('falls back to ApiName and "Unknown object" when labels are missing', () => {
    const groups = shapeTriggeredFlows([
      { ApiName: 'Nameless', TriggerType: 'RecordAfterSave', IsActive: true, ActiveVersionId: null },
    ]);
    expect(groups[0]!.object).toBe('Unknown object');
    expect(groups[0]!.flows[0]!.label).toBe('Nameless');
  });
});

describe('flowBuilderUrl', () => {
  it('builds a Flow Builder deep link for the active version', () => {
    expect(flowBuilderUrl('https://x.lightning.force.com', '301abc')).toBe(
      'https://x.lightning.force.com/builder_platform_interaction/flowBuilder.app?flowId=301abc',
    );
  });
});

describe('flow-trigger-explorer-enhancer feature', () => {
  beforeEach(clearBody);

  it('queries FlowDefinitionView and renders grouped flows + builder links', async () => {
    let capturedSoql = '';
    const query = vi.fn(async (soql: string) => {
      capturedSoql = soql;
      return { records: ROWS, totalSize: ROWS.length, done: true };
    });
    const feature = createFlowTriggerExplorerEnhancerFeature({ api: fakeApi(query) });
    await feature.onActivate?.();
    await flush();

    expect(query).toHaveBeenCalledTimes(1);
    expect(capturedSoql).toContain('FROM FlowDefinitionView');
    const text = document.body.textContent ?? '';
    expect(text).toContain('Account');
    expect(text).toContain('Account Before');
    expect(text).toContain('Contact Delete');
    // Builder deep links are rendered per active version; Before Save sorts first.
    const links = [...document.querySelectorAll('a[href*="flowBuilder.app"]')] as HTMLAnchorElement[];
    const hrefs = links.map((l) => l.href).join(' ');
    expect(hrefs).toContain('301000000000001'); // After Save version present
    expect(links[0]!.href).toContain('301000000000002'); // Before Save renders first
  });

  it('shows an empty state when there are no triggered flows', async () => {
    const query = vi.fn(async () => ({ records: [], totalSize: 0, done: true }));
    const feature = createFlowTriggerExplorerEnhancerFeature({ api: fakeApi(query) });
    await feature.onActivate?.();
    await flush();
    expect(document.body.textContent).toContain('No active record-triggered flows');
  });

  it('surfaces a query error in an error panel', async () => {
    const query = vi.fn(async () => { throw new Error('INVALID_TYPE: FlowDefinitionView'); });
    const feature = createFlowTriggerExplorerEnhancerFeature({ api: fakeApi(query) });
    await feature.onActivate?.();
    await flush();
    expect(document.body.textContent).toContain('INVALID_TYPE');
  });
});
