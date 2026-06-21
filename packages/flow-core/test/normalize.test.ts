import { describe, it, expect } from 'vitest';
import { normalize, type RawFlowMetadata } from '../src/normalize.js';

describe('flow-core/normalize', () => {
  describe('flow type detection', () => {
    it('ScreenFlow when screens exist', () => {
      const meta: RawFlowMetadata = { label: 'Onboarding', screens: [{ name: 'Welcome' }] };
      expect(normalize(meta).meta.flowType).toBe('ScreenFlow');
    });

    it('Scheduled when start has schedule block', () => {
      const meta: RawFlowMetadata = {
        label: 'Nightly Job',
        start: { triggerType: 'Scheduled', schedule: {} },
      };
      expect(normalize(meta).meta.flowType).toBe('Scheduled');
    });

    it('RecordTriggered when start.recordTriggerType is set', () => {
      const meta: RawFlowMetadata = {
        label: 'Account After Save',
        start: { recordTriggerType: 'CreateAndUpdate', object: 'Account' },
      };
      expect(normalize(meta).meta.flowType).toBe('RecordTriggered');
    });

    it('Autolaunched for processType Flow / AutoLaunchedFlow / Workflow', () => {
      for (const pt of ['Flow', 'AutoLaunchedFlow', 'Workflow']) {
        const meta: RawFlowMetadata = { label: 't', processType: pt };
        expect(normalize(meta).meta.flowType).toBe('Autolaunched');
      }
    });

    it('Unknown when no signal', () => {
      expect(normalize({ label: 't' }).meta.flowType).toBe('Unknown');
    });
  });

  describe('trigger detection', () => {
    it('timing Async', () => {
      const flow = normalize({ start: { triggerType: 'RecordAsync' } });
      expect(flow.trigger.timing).toBe('Async');
    });

    it('timing Unknown when empty or no match', () => {
      expect(normalize({ start: { triggerType: 'RandomEvent' } }).trigger.timing).toBe('Unknown');
      expect(normalize({ start: {} }).trigger.timing).toBe('Unknown');
    });

    it('timing BeforeSave', () => {
      // v2.0.2's detectTriggerTiming prefers recordTriggerType when set; only
      // falls back to triggerType when it is absent. So this fixture omits
      // recordTriggerType.
      const flow = normalize({ start: { triggerType: 'RecordBeforeSave' } });
      expect(flow.trigger.timing).toBe('BeforeSave');
    });

    it('event CreateOrUpdate when both words present', () => {
      const flow = normalize({ start: { triggerType: 'RecordAfterCreateOrUpdate' } });
      expect(flow.trigger.event).toBe('CreateOrUpdate');
    });

    it('event Delete when delete is present', () => {
      const flow = normalize({ start: { triggerType: 'RecordBeforeDelete' } });
      expect(flow.trigger.event).toBe('Delete');
    });

    it('entryCriteriaSummary counts filters', () => {
      const flow = normalize({
        start: { recordTriggerType: 'Create', filters: [{}, {}] },
      });
      expect(flow.trigger.entryCriteriaSummary).toBe('2 start filters configured');
    });

    it('entryCriteriaSummary acknowledges a formula', () => {
      const flow = normalize({
        start: { recordTriggerType: 'Create', filterFormula: 'X > 0' },
      });
      expect(flow.trigger.entryCriteriaSummary).toBe('Formula criteria defined');
    });
  });

  describe('node construction', () => {
    it('normalizes transforms, formulas, textTemplates, variables and recordLookups correctly', () => {
      const flow = normalize({
        recordLookups: [{ name: 'get1', filters: [ { field: 'Id' } ] }],
        transforms: [{ name: 'transform1' }],
        collectionProcessors: [{ name: 'colProc1' }],
        formulas: [{ name: 'f1', dataType: 'String', expression: '1 + 1' }],
        textTemplates: [{ name: 'tt1', text: 'Hello' }],
        variables: [{ name: 'var1', isInput: true, value: 'test' }],
        constants: [{ name: 'const1', dataType: 'String', value: 'myVal' }]
      });
      expect(flow.nodes.find(n => n.apiName === 'get1')?.metadata?.filters).toHaveLength(1);
      expect(flow.nodes.find(n => n.apiName === 'transform1')?.type).toBe('Transform');
      expect(flow.nodes.find(n => n.apiName === 'colProc1')?.type).toBe('CollectionProcessor');
      expect(flow.resources.find(r => r.name === 'f1')?.type).toBe('Formula');
      expect(flow.resources.find(r => r.name === 'tt1')?.type).toBe('TextTemplate');
      expect(flow.resources.find(r => r.name === 'var1')?.metadata?.isInput).toBe(true);
      expect(flow.resources.find(r => r.name === 'const1')?.type).toBe('Constant');
    });

    it('always emits a __start__ node', () => {
      const flow = normalize({ label: 'Empty' });
      expect(flow.nodes[0]!.id).toBe('__start__');
      expect(flow.nodes[0]!.type).toBe('Start');
    });

    it('marks DML elements as supporting fault paths', () => {
      const flow = normalize({
        recordUpdates: [{ name: 'UpdateAcct', label: 'Update', object: 'Account' }],
      });
      const node = flow.nodes.find((n) => n.apiName === 'UpdateAcct')!;
      expect(node.supportsFaultPath).toBe(true);
      expect(node.hasFaultPath).toBe(false);
    });

    it('detects fault path when faultConnector.targetReference is set', () => {
      const flow = normalize({
        recordCreates: [
          {
            name: 'MakeAcct',
            label: 'Make',
            object: 'Account',
            faultConnector: { targetReference: 'HandleError' },
          },
        ],
      });
      const node = flow.nodes.find((n) => n.apiName === 'MakeAcct')!;
      expect(node.hasFaultPath).toBe(true);
    });

    it('does NOT mark assignments / decisions / screens as supporting fault paths', () => {
      const flow = normalize({
        assignments: [{ name: 'A' }],
        decisions: [{ name: 'D' }],
        screens: [{ name: 'S' }],
      });
      for (const apiName of ['A', 'D', 'S']) {
        expect(flow.nodes.find((n) => n.apiName === apiName)?.supportsFaultPath).toBe(false);
      }
    });
  });

  describe('loop membership', () => {
    it('marks the loop body as isInLoop with depth 1', () => {
      const flow = normalize({
        loops: [
          {
            name: 'L',
            nextValueConnector: { targetReference: 'UpdateAcct' },
            noMoreValuesConnector: { targetReference: 'End' },
          },
        ],
        recordUpdates: [
          {
            name: 'UpdateAcct',
            object: 'Account',
            connector: { targetReference: 'L' },
          },
        ],
      });
      const update = flow.nodes.find((n) => n.apiName === 'UpdateAcct')!;
      expect(update.isInLoop).toBe(true);
      expect(update.loopDepth).toBe(1);
    });

    it('handles multiple paths to same loop body correctly', () => {
      const flow = normalize({
        loops: [
          {
            name: 'L',
            nextValueConnector: { targetReference: 'Split' },
          }
        ],
        decisions: [
          {
            name: 'Split',
            rules: [{ name: 'Rule1', connector: { targetReference: 'Shared' } }],
            defaultConnector: { targetReference: 'Shared' }
          }
        ],
        recordUpdates: [
          { name: 'Shared', object: 'A', connector: { targetReference: 'L' } }
        ]
      });
      const shared = flow.nodes.find((n) => n.apiName === 'Shared')!;
      expect(shared.isInLoop).toBe(true);
      expect(shared.loopDepth).toBe(1);
    });

    it('handles multiple loops with fault connector exclusion', () => {
      const flow = normalize({
        loops: [
          {
            name: 'L1',
            nextValueConnector: { targetReference: 'InL1' },
          },
          {
            name: 'L2',
            nextValueConnector: { targetReference: 'InL2' },
          }
        ],
        recordUpdates: [
          { name: 'InL1', object: 'A', connector: { targetReference: 'L2' }, faultConnector: { targetReference: 'FaultL1' } },
          { name: 'InL2', object: 'B', connector: { targetReference: 'L1' } }
        ],
        recordCreates: [{ name: 'FaultL1', object: 'C' }]
      });
      const inL1 = flow.nodes.find((n) => n.apiName === 'InL1')!;
      const inL2 = flow.nodes.find((n) => n.apiName === 'InL2')!;
      const faultL1 = flow.nodes.find((n) => n.apiName === 'FaultL1')!;

      expect(inL1.isInLoop).toBe(true);
      expect(inL2.isInLoop).toBe(true);
      expect(inL2.loopDepth).toBeGreaterThanOrEqual(1);
      expect(faultL1.isInLoop).toBe(false);
    });

    it('does NOT mark the post-loop node (noMoreValues target) as in loop', () => {
      const flow = normalize({
        loops: [
          {
            name: 'L',
            nextValueConnector: { targetReference: 'InLoop' },
            noMoreValuesConnector: { targetReference: 'AfterLoop' },
          },
        ],
        recordUpdates: [{ name: 'InLoop', object: 'A', connector: { targetReference: 'L' } }],
        recordCreates: [{ name: 'AfterLoop', object: 'A' }],
      });
      expect(flow.nodes.find((n) => n.apiName === 'AfterLoop')?.isInLoop).toBe(false);
    });
  });

  describe('dependencies', () => {
    it('records apex action dependencies', () => {
      const flow = normalize({
        actionCalls: [{ name: 'CallApex', actionType: 'apex', actionName: 'MyApexClass' }],
      });
      expect(flow.dependencies).toEqual([{ type: 'ApexAction', name: 'MyApexClass', count: 1 }]);
    });

    it('records non-flowruntime LWC dependencies from screen components', () => {
      const flow = normalize({
        screens: [
          {
            name: 'S',
            fields: [
              { fieldType: 'ComponentInstance', extensionName: 'c:MyComponent' },
              { fieldType: 'ComponentInstance', extensionName: 'flowruntime:input' }, // standard, ignored
            ],
          },
        ],
      });
      expect(flow.dependencies).toEqual([{ type: 'LwcComponent', name: 'c:MyComponent', count: 1 }]);
    });

    it('filters out all standard Lightning namespaces from LWC dependencies', () => {
      const flow = normalize({
        screens: [
          {
            name: 'S',
            fields: [
              // User component — should be kept.
              { fieldType: 'ComponentInstance', extensionName: 'c:CustomCmp' },
              // Managed-package component — should be kept.
              { fieldType: 'ComponentInstance', extensionName: 'mypkg:Widget' },
              // Standard Lightning namespaces — every one of these ships
              // with Salesforce, so they must not surface as dependencies.
              { fieldType: 'ComponentInstance', extensionName: 'flowruntime:input' },
              { fieldType: 'ComponentInstance', extensionName: 'force:outputField' },
              { fieldType: 'ComponentInstance', extensionName: 'forceContent:fileUpload' },
              { fieldType: 'ComponentInstance', extensionName: 'lightning:input' },
              { fieldType: 'ComponentInstance', extensionName: 'lightningCommunity:editor' },
              { fieldType: 'ComponentInstance', extensionName: 'lightningsnapin:settings' },
              { fieldType: 'ComponentInstance', extensionName: 'ui:button' },
              { fieldType: 'ComponentInstance', extensionName: 'aura:component' },
            ],
          },
        ],
      });
      expect(flow.dependencies).toEqual([
        { type: 'LwcComponent', name: 'c:CustomCmp', count: 1 },
        { type: 'LwcComponent', name: 'mypkg:Widget', count: 1 },
      ]);
    });

    it('records subflow dependencies', () => {
      const flow = normalize({
        subflows: [{ name: 'CallChild', flowName: 'Child_Flow' }],
      });
      expect(flow.dependencies).toEqual([{ type: 'Subflow', name: 'Child_Flow', count: 1 }]);
    });

    it('records Apex-defined-type dependencies from variables', () => {
      const flow = normalize({
        variables: [{ name: 'thing', dataType: 'Apex', apexClass: 'MyApex' }],
      });
      expect(flow.dependencies).toEqual([{ type: 'ApexDefinedType', name: 'MyApex', count: 1 }]);
    });

    it('dedupes and merges counts for repeated dependencies', () => {
      const flow = normalize({
        actionCalls: [
          { name: 'a1', actionType: 'apex', actionName: 'Shared' },
          { name: 'a2', actionType: 'apex', actionName: 'Shared' },
        ],
      });
      expect(flow.dependencies).toEqual([{ type: 'ApexAction', name: 'Shared', count: 2 }]);
    });
  });

  describe('edges', () => {
    it('builds the start edge', () => {
      const flow = normalize({
        start: { connector: { targetReference: 'first' } },
        assignments: [{ name: 'first' }],
      });
      expect(flow.edges).toContainEqual({ from: '__start__', to: 'first', kind: 'default', label: null });
    });

    it('builds decision edges with rule labels', () => {
      const flow = normalize({
        decisions: [
          {
            name: 'D',
            rules: [{ name: 'r1', label: 'Approved', connector: { targetReference: 'A' } }],
            defaultConnector: { targetReference: 'B' },
            defaultConnectorLabel: 'Otherwise',
          },
        ],
      });
      expect(flow.edges).toContainEqual({ from: 'D', to: 'A', kind: 'decision', label: 'Approved' });
      expect(flow.edges).toContainEqual({ from: 'D', to: 'B', kind: 'decision', label: 'Otherwise' });
    });
  });

  it('builds recordDeletes, transforms, and subflows edges', () => {
    const flow = normalize({
      recordDeletes: [{ name: 'delete1', connector: { targetReference: 'end' }, faultConnector: { targetReference: 'fault' } }],
      transforms: [{ name: 'transform1', connector: { targetReference: 'end' } }],
      subflows: [{ name: 'subflow1', connector: { targetReference: 'end' }, faultConnector: { targetReference: 'fault' } }],
      collectionProcessors: [{ name: 'colProc1', connector: { targetReference: 'end' } }],
    });
    expect(flow.edges).toContainEqual({ from: 'delete1', to: 'end', kind: 'default', label: null });
    expect(flow.edges).toContainEqual({ from: 'delete1', to: 'fault', kind: 'fault', label: null });
    expect(flow.edges).toContainEqual({ from: 'transform1', to: 'end', kind: 'default', label: null });
    expect(flow.edges).toContainEqual({ from: 'subflow1', to: 'end', kind: 'default', label: null });
    expect(flow.edges).toContainEqual({ from: 'subflow1', to: 'fault', kind: 'fault', label: null });
    expect(flow.edges).toContainEqual({ from: 'colProc1', to: 'end', kind: 'default', label: null });
  });

  describe('meta defaults', () => {
    it('falls back to defaults when label and fullName are missing', () => {
      const flow = normalize({}, {});
      expect(flow.meta.flowApiName).toBe('unknown_flow');
      expect(flow.meta.flowLabel).toBe('Unknown Flow');
    });

    it('falls back to options.flowApiName when fullName is absent', () => {
      const flow = normalize({ label: 'My Flow' }, { flowApiName: 'My_Flow' });
      expect(flow.meta.flowApiName).toBe('My_Flow');
    });

    it('preserves options.flowVersionId', () => {
      const flow = normalize({ label: 'x' }, { flowVersionId: '301AB' });
      expect(flow.meta.flowVersionId).toBe('301AB');
    });
  });
});
