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
    expect(createTriggerConflictsFeature().id).toBe('trigger-conflicts');
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
    // Null entry criteria renders as "no entry criteria".
    expect(document.body.textContent).toContain('no entry criteria');
  });
});

describe('extension/features/subflow-graph', () => {
  it('feature id is stable', () => {
    expect(createSubflowGraphFeature().id).toBe('subflow-graph');
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
    expect(document.body.textContent).toContain('depth 1');
    expect(document.body.textContent).toContain('depth 0');
  });
});

describe('extension/features/flow-deploy', () => {
  it('feature id is stable', () => {
    expect(createFlowDeployFeature().id).toBe('flow-deploy');
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
