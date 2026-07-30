// Fixture Flows for the field-write extractor (P4-4). Each is a realistic
// Tooling API `Flow.Metadata` payload — the same shape `normalize()` consumes —
// trimmed to the keys the extractor reads plus enough context (start block,
// variables, filters) to exercise object resolution and the read/write split.

import type { RawFlowMetadata } from '../../src/normalize.js';

/**
 * Before-save record-triggered flow on Case. Writes `Priority` and `Status`
 * through an Assignment on `$Record`, and READS `Subject` in a decision — the
 * read must not be reported.
 */
export const beforeSaveCaseFlow: RawFlowMetadata = {
  label: 'Case Before Save Triage',
  processType: 'AutoLaunchedFlow',
  status: 'Active',
  start: {
    object: 'Case',
    triggerType: 'RecordBeforeSave',
    recordTriggerType: 'CreateAndUpdate',
    filters: [{ field: 'Origin', operator: 'EqualTo', value: { stringValue: 'Web' } }],
  },
  decisions: [
    {
      name: 'Is_Escalated',
      label: 'Is Escalated?',
      rules: [{ name: 'Yes', label: 'Yes', connector: { targetReference: 'Set_Priority' } }],
    },
  ],
  assignments: [
    {
      name: 'Set_Priority',
      label: 'Set Priority',
      assignmentItems: [
        { assignToReference: '$Record.Priority', operator: 'Assign', value: { stringValue: 'High' } },
        { assignToReference: '$Record.Status', operator: 'Assign', value: { stringValue: 'Escalated' } },
        // Not a field write: a plain flow variable.
        { assignToReference: 'counterVar', operator: 'Add', value: { numberValue: 1 } },
        // Not a field write: a non-record global.
        { assignToReference: '$Flow.CurrentDateTime', operator: 'Assign', value: {} },
      ],
    },
  ],
  recordLookups: [
    // A pure READ — must produce no writes at all.
    {
      name: 'Get_Account',
      label: 'Get Account',
      object: 'Account',
      filters: [{ field: 'Industry', operator: 'EqualTo', value: { stringValue: 'Retail' } }],
      queriedFields: ['Id', 'Industry', 'Priority'],
    },
  ],
};

/**
 * After-save flow that updates a DIFFERENT object via an Update Records element
 * with an explicit `object`, and creates a Task. Both objects are stated in the
 * metadata, so every write is `confirmed`.
 */
export const afterSaveAccountFlow: RawFlowMetadata = {
  label: 'Opportunity After Save Rollup',
  processType: 'AutoLaunchedFlow',
  status: 'Active',
  start: { object: 'Opportunity', triggerType: 'RecordAfterSave', recordTriggerType: 'Create' },
  recordUpdates: [
    {
      name: 'Update_Account_Rating',
      label: 'Update Account Rating',
      object: 'Account',
      filters: [{ field: 'Id', operator: 'EqualTo', value: { elementReference: '$Record.AccountId' } }],
      inputAssignments: [
        { field: 'Rating', value: { stringValue: 'Hot' } },
        { field: 'Industry', value: { elementReference: '$Record.Industry__c' } },
      ],
    },
  ],
  recordCreates: [
    {
      name: 'Create_Followup_Task',
      label: 'Create Follow-up Task',
      object: 'Task',
      inputAssignments: [
        { field: 'Subject', value: { stringValue: 'Follow up' } },
        { field: 'Status', value: { stringValue: 'Not Started' } },
      ],
    },
  ],
};

/**
 * Screen flow that builds an sObject variable field-by-field and then commits it
 * with an `inputReference`-driven Create Records element. The object comes from
 * the variable's `objectType`, so these are still `confirmed`.
 */
export const sobjectVariableFlow: RawFlowMetadata = {
  label: 'New Contact Screen',
  processType: 'Flow',
  status: 'Active',
  screens: [{ name: 'Collect', label: 'Collect Details', fields: [{ fieldType: 'InputField' }] }],
  variables: [
    { name: 'newContact', dataType: 'SObject', objectType: 'Contact', isCollection: false },
    // Non-sObject variable: assigning "into" it cannot be bound to an object.
    { name: 'wrapper', dataType: 'Apex', apexClass: 'ContactWrapper' },
  ],
  assignments: [
    {
      name: 'Populate_Contact',
      label: 'Populate Contact',
      assignmentItems: [
        { assignToReference: 'newContact.FirstName', operator: 'Assign', value: {} },
        { assignToReference: 'newContact.Email', operator: 'Assign', value: {} },
        // Unresolvable head → reported, but only as `inferred`.
        { assignToReference: 'wrapper.Email', operator: 'Assign', value: {} },
      ],
    },
  ],
  recordCreates: [
    {
      name: 'Commit_Contact',
      label: 'Commit Contact',
      inputReference: 'newContact',
    },
  ],
};

/**
 * Loop over a Get Records collection, updating each row. The loop variable
 * inherits the collection's object, so `Loop_Item.Description` resolves.
 */
export const loopUpdateFlow: RawFlowMetadata = {
  label: 'Bulk Case Description',
  processType: 'AutoLaunchedFlow',
  status: 'Active',
  recordLookups: [
    { name: 'Get_Cases', label: 'Get Cases', object: 'Case', getFirstRecordOnly: false },
  ],
  loops: [
    { name: 'Loop_Cases', label: 'Loop Cases', collectionReference: 'Get_Cases' },
  ],
  assignments: [
    {
      name: 'Stamp_Description',
      label: 'Stamp Description',
      assignmentItems: [
        { assignToReference: 'Loop_Cases.Description', operator: 'Assign', value: {} },
        // Relationship hop — real write attempt, object cannot be bound.
        { assignToReference: 'Loop_Cases.Account.Name', operator: 'Assign', value: {} },
      ],
    },
  ],
};

/** A flow with no writing element at all — reads and a subflow only. */
export const readOnlyFlow: RawFlowMetadata = {
  label: 'Lookup Only',
  processType: 'AutoLaunchedFlow',
  status: 'Active',
  recordLookups: [
    {
      name: 'Get_Account',
      label: 'Get Account',
      object: 'Account',
      filters: [{ field: 'Industry', operator: 'EqualTo', value: { stringValue: 'Retail' } }],
    },
  ],
  subflows: [{ name: 'Call_Child', label: 'Call Child', flowName: 'Child_Flow' }],
  formulas: [{ name: 'AccountName', dataType: 'String', expression: '{!Get_Account.Name}' }],
};

/** Deliberately ragged metadata: missing names, empty strings, wrong types. */
export const malformedFlow = {
  label: 'Broken',
  assignments: [
    null,
    { name: 'A1', assignmentItems: 'not-an-array' },
    { name: 'A2', assignmentItems: [{ assignToReference: '' }, { assignToReference: '.' }, 42] },
  ],
  recordUpdates: [
    { name: 'U1', object: 'Account', inputAssignments: [{ field: '' }, { value: 1 }] },
  ],
} as unknown as RawFlowMetadata;
