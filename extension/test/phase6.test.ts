// Phase 6 feature smoke tests — trigger-conflicts, subflow-graph,
// flow-deploy. The detection engines live in @sfdt/flow-core and have
// dedicated tests there; this file exercises the extension wiring:
// modal rendering, feature ids, bridge error mapping.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  _triggerConflictsTestApi,
  createTriggerConflictsFeature,
} from '../features/trigger-conflicts.js';
import {
  _subflowGraphTestApi,
  createSubflowGraphFeature,
} from '../features/subflow-graph.js';
import {
  _flowDeployTestApi,
  createFlowDeployFeature,
} from '../features/flow-deploy.js';
import { buildSubflowGraph, type FlowConflictGroup } from '@sfdt/flow-core';
import { SalesforceApiClient, type MessageBus } from '../lib/salesforce-api.js';

beforeEach(() => {
  document.body.replaceChildren();
});

// A fetch-backed SalesforceApiClient whose responses are routed by the SOQL
// `q` query param, mirroring the pattern in feature-smoke.test.ts. `route`
// returns the JSON records array for a query, or throws to simulate a 4xx.
function makeRoutedApi(route: (soql: string) => unknown[]): SalesforceApiClient {
  const fetchImpl = (async (url: string | URL | Request) => {
    const soql = new URL(String(url), 'http://x').searchParams.get('q') ?? '';
    let records: unknown[];
    try {
      records = route(soql);
    } catch {
      return {
        ok: false,
        status: 400,
        async json() {
          return {};
        },
        async text() {
          return 'bad request';
        },
      } as Response;
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return { size: records.length, done: true, records };
      },
      async text() {
        return '{}';
      },
    } as Response;
  }) as typeof fetch;
  return new SalesforceApiClient({
    win: {
      location: { hostname: 'x.lightning.force.com', origin: 'https://x.lightning.force.com', search: '' },
    } as never,
    messageBus: {
      sendMessage: (async () => ({
        ok: true,
        sids: { 'https://x.my.salesforce.com': 'sid' },
      })) as unknown as MessageBus['sendMessage'],
    },
    fetchImpl,
  });
}

describe('extension/features/trigger-conflicts', () => {
  it('feature id is stable', () => {
    expect(createTriggerConflictsFeature().manifest.id).toBe('trigger-conflicts');
  });

  it('buildConflictsModal renders the empty state when no groups are present', () => {
    const { buildConflictsModal } = _triggerConflictsTestApi();
    buildConflictsModal(document, []);
    expect(document.querySelector('.sfdt-view-overlay')?.textContent).toContain(
      'No record-triggered flows',
    );
  });

  it('buildConflictsModal lists each group with object · timing · event', () => {
    const { buildConflictsModal } = _triggerConflictsTestApi();
    const groups: FlowConflictGroup[] = [
      {
        objectApiName: 'Account',
        triggerTiming: 'AfterSave',
        triggerEvent: 'Create',
        flows: [
          { flowId: 'A', label: 'Flow A', entryCriteriaSummary: '1 start filter configured' },
          { flowId: 'B', label: 'Flow B', entryCriteriaSummary: null },
        ],
      },
    ];
    buildConflictsModal(document, groups);
    const overlay = document.querySelector('.sfdt-view-overlay')!;
    expect(overlay.textContent).toContain('Account · AfterSave · Create');
    expect(overlay.textContent).toContain('Flow A');
    expect(overlay.textContent).toContain('Flow B');
    expect(overlay.textContent).toContain('no entry criteria');
  });

  it('buildConflictsModal renders Activate/Deactivate buttons that fire the bridge callbacks', async () => {
    const { buildConflictsModal } = _triggerConflictsTestApi();
    const calls: Array<{ kind: string; flowApiName: string; toVersion?: number }> = [];
    const groups: FlowConflictGroup[] = [
      {
        objectApiName: 'Account',
        triggerTiming: 'AfterSave',
        triggerEvent: 'Create',
        flows: [{ flowId: 'My_Flow', label: 'My Flow', entryCriteriaSummary: null }],
      },
    ];
    buildConflictsModal(document, groups, {
      extras: { My_Flow: { latestVersionNumber: 3, active: true } },
      onActivate: async (flowApiName, toVersion) => {
        calls.push({ kind: 'activate', flowApiName, toVersion });
        return { ok: true };
      },
      onDeactivate: async (flowApiName) => {
        calls.push({ kind: 'deactivate', flowApiName });
        return { ok: true };
      },
    });

    // The Activate button is labelled with the latest version number from extras.
    const buttons = Array.from(document.querySelectorAll('button'));
    const activateBtn = buttons.find((b) => /Activate v3/.test(b.textContent ?? ''));
    const deactivateBtn = buttons.find((b) => b.textContent === 'Deactivate');
    expect(activateBtn).toBeTruthy();
    expect(deactivateBtn).toBeTruthy();

    // Active flow: Activate is disabled, Deactivate is enabled.
    expect((activateBtn as HTMLButtonElement).disabled).toBe(true);
    expect((deactivateBtn as HTMLButtonElement).disabled).toBe(false);

    // Click Deactivate → onDeactivate runs and the row flips to inactive.
    (deactivateBtn as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([{ kind: 'deactivate', flowApiName: 'My_Flow' }]);
    expect(document.body.textContent).toContain('Inactive');

    // After deactivation, Activate becomes enabled and Deactivate disabled.
    expect((activateBtn as HTMLButtonElement).disabled).toBe(false);
    expect((deactivateBtn as HTMLButtonElement).disabled).toBe(true);

    // Click Activate → onActivate runs with the latest version number.
    (activateBtn as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([
      { kind: 'deactivate', flowApiName: 'My_Flow' },
      { kind: 'activate', flowApiName: 'My_Flow', toVersion: 3 },
    ]);
  });

  it('buildConflictsModal surfaces bridge errors on the row without crashing', async () => {
    const { buildConflictsModal } = _triggerConflictsTestApi();
    const groups: FlowConflictGroup[] = [
      {
        objectApiName: 'Account',
        triggerTiming: 'AfterSave',
        triggerEvent: 'Create',
        flows: [{ flowId: 'My_Flow', label: 'My Flow', entryCriteriaSummary: null }],
      },
    ];
    buildConflictsModal(document, groups, {
      extras: { My_Flow: { latestVersionNumber: 2, active: true } },
      onDeactivate: async () => ({ ok: false, error: 'sfdt offline' }),
    });
    const buttons = Array.from(document.querySelectorAll('button'));
    const deactivateBtn = buttons.find((b) => b.textContent === 'Deactivate') as HTMLButtonElement;
    deactivateBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Row stays active; the failure indicator appears.
    expect(document.body.textContent).toContain('Active');
    // The ✗ status indicator carries the error message in its title.
    expect(document.querySelector('span[title="sfdt offline"]')).toBeTruthy();
  });

  it('describeBridgeError maps each bridge code to a user-facing string', () => {
    const { describeBridgeError } = _triggerConflictsTestApi();
    const mk = (code?: string, error = 'raw error') =>
      describeBridgeError({ ok: false, requestId: 'r', error, code: code as never });
    expect(describeBridgeError({ ok: true, requestId: 'r', data: {} } as never)).toBe('OK');
    expect(mk('BRIDGE_UNAUTHORIZED')).toMatch(/token/i);
    expect(mk('BRIDGE_FORBIDDEN')).toMatch(/origin/i);
    expect(mk('NOT_IMPLEMENTED')).toMatch(/not support/i);
    expect(mk('BRIDGE_OFFLINE')).toMatch(/sfdt is not running/);
    // NOT_FOUND and unknown codes fall through to the raw error text.
    expect(mk('NOT_FOUND')).toBe('raw error');
    expect(mk('SOME_OTHER_CODE')).toBe('raw error');
    // Missing code is treated as BRIDGE_OFFLINE.
    expect(mk(undefined)).toMatch(/sfdt is not running/);
  });

  it('fetchActiveFlows builds candidates+extras, skipping flows without metadata or that error', async () => {
    const { fetchActiveFlows } = _triggerConflictsTestApi();
    const api = makeRoutedApi((soql) => {
      if (soql.includes('FROM FlowDefinition')) {
        return [
          { Id: '300A', DeveloperName: 'Has_Meta', ActiveVersionId: '301A', LatestVersion: { VersionNumber: 4 } },
          { Id: '300B', DeveloperName: 'No_Meta', ActiveVersionId: '301B', LatestVersion: { VersionNumber: 2 } },
          { Id: '300C', DeveloperName: 'Errors', ActiveVersionId: '301C', LatestVersion: null },
        ];
      }
      // Per-flow Flow query, routed by the version id embedded in the WHERE clause.
      if (soql.includes("'301A'")) return [{ Id: '301A', MasterLabel: 'Has Meta', Metadata: { start: {} } }];
      if (soql.includes("'301B'")) return [{ Id: '301B', MasterLabel: 'No Meta' }]; // no Metadata → skipped
      if (soql.includes("'301C'")) throw new Error('boom'); // per-flow read error → swallowed
      return [];
    });

    const { candidates, extras } = await fetchActiveFlows(api);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ flowId: 'Has_Meta', label: 'Has Meta' });
    expect(extras.Has_Meta).toEqual({ latestVersionNumber: 4, active: true });
    expect(extras.No_Meta).toBeUndefined();
    expect(extras.Errors).toBeUndefined();
  });

  it('fetchActiveFlows returns empty results when no flows are active', async () => {
    const { fetchActiveFlows } = _triggerConflictsTestApi();
    const api = makeRoutedApi((soql) => (soql.includes('FROM FlowDefinition') ? [] : []));
    const { candidates, extras } = await fetchActiveFlows(api);
    expect(candidates).toHaveLength(0);
    expect(Object.keys(extras)).toHaveLength(0);
  });
});

describe('extension/features/subflow-graph', () => {
  it('feature id is stable', () => {
    expect(createSubflowGraphFeature().manifest.id).toBe('subflow-graph');
  });

  it('buildSubflowGraphModal surfaces cycles at the top in a red banner', () => {
    const { buildSubflowGraphModal } = _subflowGraphTestApi();
    const graph = buildSubflowGraph([
      {
        id: 'A',
        metadata: { processType: 'Flow', subflows: [{ name: 'callB', flowName: 'B' }] },
      },
      {
        id: 'B',
        metadata: { processType: 'Flow', subflows: [{ name: 'callA', flowName: 'A' }] },
      },
    ]);
    buildSubflowGraphModal(document, graph);
    const overlay = document.querySelector('.sfdt-view-overlay')!;
    expect(overlay.textContent).toContain('1 cycle detected');
    expect(overlay.textContent).toMatch(/A → B → A/);
  });

  it('buildSubflowGraphModal surfaces unresolved subflow references', () => {
    const { buildSubflowGraphModal } = _subflowGraphTestApi();
    const graph = buildSubflowGraph([
      {
        id: 'A',
        metadata: { processType: 'Flow', subflows: [{ name: 'callX', flowName: 'Ghost' }] },
      },
    ]);
    buildSubflowGraphModal(document, graph);
    const overlay = document.querySelector('.sfdt-view-overlay')!;
    expect(overlay.textContent).toContain(`reference`);
    expect(overlay.textContent).toContain('Ghost');
  });

  it('buildSubflowGraphModal lists every flow with depth + call counts', () => {
    const { buildSubflowGraphModal } = _subflowGraphTestApi();
    const graph = buildSubflowGraph([
      { id: 'A', metadata: { processType: 'Flow', subflows: [{ name: 'b', flowName: 'B' }] } },
      { id: 'B', metadata: { processType: 'Flow', subflows: [] } },
    ]);
    buildSubflowGraphModal(document, graph);
    const overlay = document.querySelector('.sfdt-view-overlay')!;
    // List view is reachable behind the toggle — its body content is still
    // attached to the DOM (just display:none until the user switches).
    expect(overlay.textContent).toContain('depth 1');
    expect(overlay.textContent).toContain('depth 0');
  });

  it('buildSubflowGraphSvg renders one rect per node and an edge per outgoing call', () => {
    const { buildSubflowGraphSvg } = _subflowGraphTestApi();
    const graph = buildSubflowGraph([
      { id: 'A', metadata: { processType: 'Flow', subflows: [{ name: 'b', flowName: 'B' }] } },
      { id: 'B', metadata: { processType: 'Flow', subflows: [{ name: 'c', flowName: 'C' }] } },
      { id: 'C', metadata: { processType: 'Flow', subflows: [] } },
    ]);
    const svg = buildSubflowGraphSvg(document, graph);
    document.body.appendChild(svg);
    // Three node rectangles (one per flow).
    expect(svg.querySelectorAll('rect')).toHaveLength(3);
    // Two cubic-Bezier edges: A→B and B→C. Filter to direct children of
    // <svg> only so we don't pick up arrowhead paths inside <marker> defs.
    const directChildPaths = Array.from(svg.children).filter(
      (n): n is SVGPathElement => n.tagName.toLowerCase() === 'path',
    );
    expect(directChildPaths).toHaveLength(2);
    // And those paths use the cubic-bezier C command.
    expect(directChildPaths.every((p) => /C/.test(p.getAttribute('d') ?? ''))).toBe(true);
  });

  it('buildSubflowGraphSvg strokes cycle edges and nodes red', () => {
    const { buildSubflowGraphSvg } = _subflowGraphTestApi();
    const graph = buildSubflowGraph([
      { id: 'A', metadata: { processType: 'Flow', subflows: [{ name: 'b', flowName: 'B' }] } },
      { id: 'B', metadata: { processType: 'Flow', subflows: [{ name: 'a', flowName: 'A' }] } },
    ]);
    const svg = buildSubflowGraphSvg(document, graph);
    const rects = Array.from(svg.querySelectorAll('rect'));
    expect(rects.every((r) => r.style.stroke === 'var(--sfdt-color-error)')).toBe(true);
    // Filter to direct-child edge paths so marker arrowhead paths don't
    // pollute the count.
    const directChildPaths = Array.from(svg.children).filter(
      (n): n is SVGPathElement => n.tagName.toLowerCase() === 'path',
    );
    const cycleEdges = directChildPaths.filter((p) => p.style.stroke === 'var(--sfdt-color-error)');
    // A→B and B→A — both should be in the cycle and stroked red.
    expect(cycleEdges).toHaveLength(2);
  });

  it('buildSubflowGraphSvg dashes the stub for unresolved subflow references', () => {
    const { buildSubflowGraphSvg } = _subflowGraphTestApi();
    const graph = buildSubflowGraph([
      {
        id: 'A',
        metadata: { processType: 'Flow', subflows: [{ name: 'ghost', flowName: 'Ghost' }] },
      },
    ]);
    const svg = buildSubflowGraphSvg(document, graph);
    const stubs = Array.from(svg.querySelectorAll('line'));
    expect(stubs).toHaveLength(1);
    expect(stubs[0]!.getAttribute('stroke-dasharray')).toBeTruthy();
  });
});

describe('extension/features/flow-deploy', () => {
  it('feature id is stable', () => {
    expect(createFlowDeployFeature().manifest.id).toBe('flow-deploy');
  });

  it('describeBridgeError maps every code to a user-facing string', () => {
    const { describeBridgeError } = _flowDeployTestApi();
    expect(
      describeBridgeError({
        ok: false,
        requestId: 'r',
        error: 'x',
        code: 'BRIDGE_UNAUTHORIZED',
      }),
    ).toMatch(/Bearer token/i);
    expect(
      describeBridgeError({
        ok: false,
        requestId: 'r',
        error: 'x',
        code: 'BRIDGE_FORBIDDEN',
      }),
    ).toMatch(/origin/i);
    expect(
      describeBridgeError({
        ok: false,
        requestId: 'r',
        error: 'x',
        code: 'NOT_IMPLEMENTED',
      }),
    ).toMatch(/not available/i);
    expect(
      describeBridgeError({
        ok: false,
        requestId: 'r',
        error: 'x',
        code: 'BRIDGE_OFFLINE',
      }),
    ).toMatch(/sfdt is not running/);
    expect(
      describeBridgeError({ ok: false, requestId: 'r', error: 'underlying' }),
    ).toBe('sfdt is not running. Start `sfdt ui` or install the native messaging host.');
  });

  it('describeBridgeError returns the raw error for an unrecognised code', () => {
    const { describeBridgeError } = _flowDeployTestApi();
    expect(
      describeBridgeError({
        ok: false,
        requestId: 'r',
        error: 'something specific',
        code: 'SOME_NEW_CODE' as never,
      }),
    ).toBe('something specific');
  });

  it('describeBridgeError returns OK for a successful response', () => {
    const { describeBridgeError } = _flowDeployTestApi();
    expect(describeBridgeError({ ok: true, requestId: 'r', data: {} } as never)).toBe('OK');
  });

  it('onActivate warns and opens no modal when not on the Flow Builder canvas', async () => {
    const win = { location: { href: 'https://example.com/not-salesforce' } } as Window;
    const feature = createFlowDeployFeature({ win });
    await feature.onActivate?.();
    expect(document.querySelector('.sfdt-toast')?.textContent).toMatch(/Flow Builder canvas/);
    // No deploy modal should have been rendered.
    expect(document.body.querySelector('button')).toBeNull();
  });

  it('onActivate errors when the Flow Builder URL carries no flowId', async () => {
    const win = {
      location: { href: 'https://x.lightning.force.com/builder_platform_interaction/flowBuilder.app' },
    } as Window;
    const feature = createFlowDeployFeature({ win });
    await feature.onActivate?.();
    expect(document.querySelector('.sfdt-toast')?.textContent).toMatch(/could not determine the current flow id/i);
  });

  it('onActivate renders the deploy/rollback modal which Cancel dismisses', async () => {
    const win = {
      location: {
        href: 'https://x.lightning.force.com/builder_platform_interaction/flowBuilder.app?flowId=301AB0000001abcAAA',
      },
    } as Window;
    const feature = createFlowDeployFeature({ win });
    await feature.onActivate?.();

    const buttons = Array.from(document.querySelectorAll('button')).map((b) => b.textContent);
    expect(buttons).toEqual(expect.arrayContaining(['Deploy', 'Rollback', 'Cancel']));

    const cancel = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Cancel')!;
    cancel.click();
    // The overlay (and its buttons) are removed on Cancel.
    expect(Array.from(document.querySelectorAll('button')).some((b) => b.textContent === 'Deploy')).toBe(false);
  });
});
