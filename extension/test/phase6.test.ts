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

beforeEach(() => {
  document.body.replaceChildren();
});

describe('extension/features/trigger-conflicts', () => {
  it('feature id is stable', () => {
    expect(createTriggerConflictsFeature().manifest.id).toBe('trigger-conflicts');
  });

  it('buildConflictsModal renders the empty state when no groups are present', () => {
    const { buildConflictsModal } = _triggerConflictsTestApi();
    document.body.appendChild(buildConflictsModal(document, []));
    expect(document.body.textContent).toContain('No record-triggered flows');
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
    document.body.appendChild(buildConflictsModal(document, groups));
    expect(document.body.textContent).toContain('Account · AfterSave · Create');
    expect(document.body.textContent).toContain('Flow A');
    expect(document.body.textContent).toContain('Flow B');
    expect(document.body.textContent).toContain('no entry criteria');
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
    document.body.appendChild(
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
      }),
    );

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
    document.body.appendChild(
      buildConflictsModal(document, groups, {
        extras: { My_Flow: { latestVersionNumber: 2, active: true } },
        onDeactivate: async () => ({ ok: false, error: 'sfdt offline' }),
      }),
    );
    const buttons = Array.from(document.querySelectorAll('button'));
    const deactivateBtn = buttons.find((b) => b.textContent === 'Deactivate') as HTMLButtonElement;
    deactivateBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Row stays active; the failure indicator appears.
    expect(document.body.textContent).toContain('Active');
    // The ✗ status indicator carries the error message in its title.
    expect(document.querySelector('span[title="sfdt offline"]')).toBeTruthy();
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
    document.body.appendChild(buildSubflowGraphModal(document, graph));
    expect(document.body.textContent).toContain('1 cycle detected');
    expect(document.body.textContent).toMatch(/A → B → A/);
  });

  it('buildSubflowGraphModal surfaces unresolved subflow references', () => {
    const { buildSubflowGraphModal } = _subflowGraphTestApi();
    const graph = buildSubflowGraph([
      {
        id: 'A',
        metadata: { processType: 'Flow', subflows: [{ name: 'callX', flowName: 'Ghost' }] },
      },
    ]);
    document.body.appendChild(buildSubflowGraphModal(document, graph));
    expect(document.body.textContent).toContain(`reference`);
    expect(document.body.textContent).toContain('Ghost');
  });

  it('buildSubflowGraphModal lists every flow with depth + call counts', () => {
    const { buildSubflowGraphModal } = _subflowGraphTestApi();
    const graph = buildSubflowGraph([
      { id: 'A', metadata: { processType: 'Flow', subflows: [{ name: 'b', flowName: 'B' }] } },
      { id: 'B', metadata: { processType: 'Flow', subflows: [] } },
    ]);
    document.body.appendChild(buildSubflowGraphModal(document, graph));
    // List view is reachable behind the toggle — its body content is still
    // attached to the DOM (just display:none until the user switches).
    expect(document.body.textContent).toContain('depth 1');
    expect(document.body.textContent).toContain('depth 0');
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
    expect(rects.every((r) => r.getAttribute('stroke') === '#c23934')).toBe(true);
    // Filter to direct-child edge paths so marker arrowhead paths don't
    // pollute the count.
    const directChildPaths = Array.from(svg.children).filter(
      (n): n is SVGPathElement => n.tagName.toLowerCase() === 'path',
    );
    const cycleEdges = directChildPaths.filter((p) => p.getAttribute('stroke') === '#c23934');
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
    ).toMatch(/not implemented/i);
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
});
