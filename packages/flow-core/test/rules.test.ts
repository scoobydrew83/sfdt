import { describe, it, expect } from 'vitest';
import { normalize, type RawFlowMetadata } from '../src/normalize.js';
import { evaluate, type RulesConfig } from '../src/rules.js';
function run(meta: RawFlowMetadata, config?: RulesConfig) {
  return evaluate(normalize(meta), config);
}
describe('flow-core/rules', () => {
  it('flags a flow with no description', () => {
    const findings = run({ label: 'X' });
    expect(findings.find((f) => f.ruleId === 'FLOW_DESC_MISSING')).toBeDefined();
  });
  it('does NOT flag a flow that has a description', () => {
    const findings = run({ label: 'X', description: 'documented' });
    expect(findings.find((f) => f.ruleId === 'FLOW_DESC_MISSING')).toBeUndefined();
  });
  it('flags elements missing descriptions and skips the Start node', () => {
    const findings = run({
      assignments: [{ name: 'A1', label: 'Set things' }],
      decisions: [{ name: 'D1', label: 'Branch', description: 'present' }],
    });
    const ids = findings
      .filter((f) => f.ruleId === 'ELEMENT_DESC_MISSING')
      .map((f) => f.location?.elementApiName);
    expect(ids).toContain('A1');
    expect(ids).not.toContain('D1');
    expect(ids).not.toContain('__start__');
  });
  it('flags resources missing descriptions', () => {
    const findings = run({
      variables: [
        { name: 'V1', dataType: 'String' },
        { name: 'V2', dataType: 'String', description: 'ok' },
      ],
    });
    const names = findings
      .filter((f) => f.ruleId === 'RESOURCE_DESC_MISSING')
      .map((f) => f.location?.resourceName);
    expect(names).toEqual(['V1']);
  });
  it('flags generic element naming like "Assignment 1"', () => {
    const findings = run({
      assignments: [
        { name: 'a', label: 'Assignment 1' },
        { name: 'b', label: 'Set Owner' },
      ],
    });
    const flagged = findings
      .filter((f) => f.ruleId === 'GENERIC_ELEMENT_NAMING')
      .map((f) => f.location?.elementLabel);
    expect(flagged).toEqual(['Assignment 1']);
  });
  it('honours flow naming convention regex when supplied', () => {
    const findings = run(
      { label: 'My Flow', fullName: 'bad_flow_name' },
      { namingConventions: { flow: /^SF_[A-Z]/ } },
    );
    expect(findings.find((f) => f.scoreFamily === 'flow_naming')).toBeDefined();
  });
  it('whitelists "recordId" variable from naming-convention checks', () => {
    const findings = run(
      { variables: [{ name: 'recordId', dataType: 'String', description: 'ok' }] },
      { namingConventions: { variable: /^v[A-Z]/ } },
    );
    expect(findings.find((f) => f.scoreFamily === 'resource_naming')).toBeUndefined();
  });
  it('flags missing fault paths with the right family per element type', () => {
    const findings = run({
      recordLookups: [{ name: 'GetA', object: 'Account' }],
      recordCreates: [{ name: 'MakeA', object: 'Account' }],
      actionCalls: [{ name: 'CallX', actionType: 'apex', actionName: 'X' }],
    });
    const byFamily = findings
      .filter((f) => f.ruleId === 'FAULT_PATH_MISSING')
      .reduce<Record<string, string[]>>((acc, f) => {
        (acc[f.scoreFamily] ??= []).push(f.location?.elementApiName ?? '');
        return acc;
      }, {});
    expect(byFamily['fault_paths_queries']).toContain('GetA');
    expect(byFamily['fault_paths_dml']).toContain('MakeA');
    expect(byFamily['fault_paths_actions']).toContain('CallX');
  });
  it('flags DML inside loops', () => {
    const findings = run({
      loops: [
        {
          name: 'L',
          nextValueConnector: { targetReference: 'UpdateInLoop' },
          noMoreValuesConnector: { targetReference: 'End' },
        },
      ],
      recordUpdates: [
        { name: 'UpdateInLoop', object: 'Account', connector: { targetReference: 'L' } },
      ],
    });
    expect(findings.find((f) => f.ruleId === 'DML_INSIDE_LOOP')).toBeDefined();
  });
  it('does not flag DML outside loops', () => {
    const findings = run({
      recordUpdates: [{ name: 'UpdateOut', object: 'Account' }],
    });
    expect(findings.find((f) => f.ruleId === 'DML_INSIDE_LOOP')).toBeUndefined();
  });
  it('flags queries inside loops', () => {
    const findings = run({
      loops: [
        {
          name: 'L',
          nextValueConnector: { targetReference: 'GetInLoop' },
        },
      ],
      recordLookups: [
        { name: 'GetInLoop', object: 'Account', connector: { targetReference: 'L' } },
      ],
    });
    expect(findings.find((f) => f.ruleId === 'QUERIES_INSIDE_LOOP')).toBeDefined();
  });
  it('honours configurable threshold for high data operation count', () => {
    const meta: RawFlowMetadata = {
      recordLookups: [
        { name: 'g1' },
        { name: 'g2' },
        { name: 'g3' },
      ],
    };
    expect(run(meta, { highDataOperationThreshold: 5 }).find((f) => f.ruleId === 'HIGH_DATA_OPERATION_COUNT')).toBeUndefined();
    expect(run(meta, { highDataOperationThreshold: 2 }).find((f) => f.ruleId === 'HIGH_DATA_OPERATION_COUNT')).toBeDefined();
  });
  it('flags record-triggered flows with no entry criteria', () => {
    const findings = run({
      start: { recordTriggerType: 'CreateAndUpdate', object: 'Account' },
    });
    expect(findings.find((f) => f.ruleId === 'BROAD_ENTRY_CRITERIA')).toBeDefined();
  });
  it('does NOT flag entry criteria for non-record-triggered flows', () => {
    const findings = run({ screens: [{ name: 'S' }] });
    expect(findings.find((f) => f.ruleId === 'BROAD_ENTRY_CRITERIA')).toBeUndefined();
  });
  it('flags an outdated API version when gap exceeds threshold', () => {
    const findings = run(
      {
        apiVersion: 55,
        start: { recordTriggerType: 'Create', object: 'Account', filters: [{}] },
      },
      { currentApiVersion: 65, outdatedApiVersionThreshold: 6 },
    );
    expect(findings.find((f) => f.ruleId === 'OUTDATED_API_VERSION')).toBeDefined();
  });
  it('does not flag a recent API version', () => {
    const findings = run(
      { apiVersion: 64, start: { recordTriggerType: 'Create', object: 'Account', filters: [{}] } },
      { currentApiVersion: 65, outdatedApiVersionThreshold: 6 },
    );
    expect(findings.find((f) => f.ruleId === 'OUTDATED_API_VERSION')).toBeUndefined();
  });
  it('detects hard-coded Salesforce IDs inside inspectable literal fields', () => {
    const findings = run({
      assignments: [
        {
          name: 'Set',
          label: 'Set Owner',
          description: '.',
          assignmentItems: [
            { assignToReference: 'OwnerId', value: { stringValue: '001AB000000xyz1' } },
          ],
        },
      ],
    });
    const id = findings.find((f) => f.ruleId === 'HARD_CODED_ID');
    expect(id).toBeDefined();
    expect(id?.metadata?.matchedValue).toBe('001AB000000xyz1');
  });
  it('does NOT flag $User.Id or other blocked literals as hard-coded IDs', () => {
    const findings = run({
      assignments: [
        {
          name: 'Set',
          description: '.',
          assignmentItems: [{ value: { stringValue: '$User.Id' } }],
        },
      ],
    });
    expect(findings.find((f) => f.ruleId === 'HARD_CODED_ID')).toBeUndefined();
  });
  it('detects hard-coded URLs in formula expressions', () => {
    const findings = run({
      formulas: [
        {
          name: 'F',
          dataType: 'String',
          description: '.',
          expression: 'IF(true, "https://internal.example.com/api", "")',
        },
      ],
    });
    expect(findings.find((f) => f.ruleId === 'HARD_CODED_URL')).toBeDefined();
  });
  it('emits one info finding per dependency in the inventory', () => {
    const findings = run({
      actionCalls: [
        { name: 'a', actionType: 'apex', actionName: 'A' },
        { name: 'b', actionType: 'apex', actionName: 'B' },
      ],
      subflows: [{ name: 'sf', flowName: 'Child' }],
    });
    const inv = findings.filter((f) => f.ruleId === 'DEPENDENCY_INVENTORY');
    expect(inv).toHaveLength(3);
    expect(inv.every((f) => f.severity === 'info')).toBe(true);
  });
  it('finding IDs are deterministic per evaluate() call', () => {
    const meta: RawFlowMetadata = { variables: [{ name: 'a', dataType: 'String' }] };
    const a = evaluate(normalize(meta));
    const b = evaluate(normalize(meta));
    expect(a.map((f) => f.id)).toEqual(b.map((f) => f.id));
  });
});
