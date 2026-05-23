// Embedded directly so flow-core has no I/O on first use.
// PrefixEntry is defined here (the data-owning file) and re-exported from
// api-name.ts to avoid a circular dependency.

export interface PrefixEntry {
  type: string;
  Snake_Case: string;
  PascalCase: string;
  camelCase: string;
}

export const DEFAULT_PREFIXES: readonly PrefixEntry[] = Object.freeze([
  { type: 'Screen Flow', Snake_Case: 'SF_', PascalCase: 'SF', camelCase: 'sf' },
  { type: 'Record-Triggered Flow', Snake_Case: 'RTF_', PascalCase: 'RTF', camelCase: 'rtf' },
  { type: 'Record-Triggered Flow - Approval Process', Snake_Case: 'RTAP_', PascalCase: 'RTAP', camelCase: 'rtap' },
  { type: 'Schedule-Triggered Flow', Snake_Case: 'STF_', PascalCase: 'STF', camelCase: 'stf' },
  { type: 'Platform Event-Triggered Flow', Snake_Case: 'PET_', PascalCase: 'PET', camelCase: 'pet' },
  { type: 'Automation Event-Triggered Flow', Snake_Case: 'AETF_', PascalCase: 'AETF', camelCase: 'aetf' },
  { type: 'Autolaunched Flow', Snake_Case: 'AF_', PascalCase: 'AF', camelCase: 'af' },
  { type: 'Autolaunched Flow - Approval Process', Snake_Case: 'ALAP_', PascalCase: 'ALAP', camelCase: 'alap' },
  { type: 'Orchestration', Snake_Case: 'Orch_', PascalCase: 'Orch', camelCase: 'orch' },
  { type: 'Flow', Snake_Case: 'Flow_', PascalCase: 'Flow', camelCase: 'flow' },

  { type: 'Get Records', Snake_Case: 'Get_', PascalCase: 'Get', camelCase: 'get' },
  { type: 'Create Records', Snake_Case: 'Create_', PascalCase: 'Create', camelCase: 'create' },
  { type: 'Update Records', Snake_Case: 'Update_', PascalCase: 'Update', camelCase: 'update' },
  { type: 'Delete Records', Snake_Case: 'Delete_', PascalCase: 'Delete', camelCase: 'delete' },
  { type: 'Decision', Snake_Case: 'Decision_', PascalCase: 'Decision', camelCase: 'decision' },
  { type: 'Outcome', Snake_Case: 'Outcome_', PascalCase: 'Outcome', camelCase: 'outcome' },
  { type: 'Assignment', Snake_Case: 'Set_', PascalCase: 'Set', camelCase: 'set' },
  { type: 'Screen', Snake_Case: 'Screen_', PascalCase: 'Screen', camelCase: 'screen' },
  { type: 'Input', Snake_Case: 'Input_', PascalCase: 'Input', camelCase: 'input' },
  { type: 'Section', Snake_Case: 'Section_', PascalCase: 'Section', camelCase: 'section' },
  { type: 'Display', Snake_Case: 'Display_', PascalCase: 'Display', camelCase: 'display' },
  { type: 'Message', Snake_Case: 'Message_', PascalCase: 'Message', camelCase: 'message' },
  { type: 'Repeater', Snake_Case: 'Repeater_', PascalCase: 'Repeater', camelCase: 'repeater' },
  { type: 'LWC', Snake_Case: 'LWC_', PascalCase: 'LWC', camelCase: 'lwc' },
  { type: 'Loop', Snake_Case: 'Loop_', PascalCase: 'Loop', camelCase: 'loop' },
  { type: 'Action', Snake_Case: 'Apex_', PascalCase: 'Apex', camelCase: 'apex' },
  { type: 'Subflow', Snake_Case: 'Subflow_', PascalCase: 'Subflow', camelCase: 'subflow' },
  { type: 'Transform', Snake_Case: 'Transform_', PascalCase: 'Transform', camelCase: 'transform' },
  { type: 'Wait', Snake_Case: 'Wait_', PascalCase: 'Wait', camelCase: 'wait' },
  { type: 'Custom Error', Snake_Case: 'Error_', PascalCase: 'Error', camelCase: 'error' },
  { type: 'Roll Back Records', Snake_Case: 'Rollback_', PascalCase: 'Rollback', camelCase: 'rollback' },
  { type: 'Collection Sort', Snake_Case: 'Sort_', PascalCase: 'Sort', camelCase: 'sort' },
  { type: 'Collection Filter', Snake_Case: 'Filter_', PascalCase: 'Filter', camelCase: 'filter' },

  { type: 'Formula (Text)', Snake_Case: 'CalcString_', PascalCase: 'CalcString', camelCase: 'calcstring' },
  { type: 'Formula (Number)', Snake_Case: 'CalcNum_', PascalCase: 'CalcNum', camelCase: 'calcnum' },
  { type: 'Formula (Currency)', Snake_Case: 'CalcCur_', PascalCase: 'CalcCur', camelCase: 'calccur' },
  { type: 'Formula (Boolean)', Snake_Case: 'CalcCheck_', PascalCase: 'CalcCheck', camelCase: 'calccheck' },
  { type: 'Formula (Date)', Snake_Case: 'CalcDate_', PascalCase: 'CalcDate', camelCase: 'calcdate' },
  { type: 'Formula (Date/Time)', Snake_Case: 'CalcDateTime_', PascalCase: 'CalcDateTime', camelCase: 'calcdatetime' },
  { type: 'Formula (Time)', Snake_Case: 'CalcTime_', PascalCase: 'CalcTime', camelCase: 'calctime' },
  { type: 'Formula', Snake_Case: 'Calc_', PascalCase: 'Calc', camelCase: 'calc' },

  { type: 'Variable (Text)', Snake_Case: 'VarString_', PascalCase: 'VarString', camelCase: 'varstring' },
  { type: 'Variable (Number)', Snake_Case: 'VarNum_', PascalCase: 'VarNum', camelCase: 'varnum' },
  { type: 'Variable (Currency)', Snake_Case: 'VarCur_', PascalCase: 'VarCur', camelCase: 'varcur' },
  { type: 'Variable (Boolean)', Snake_Case: 'VarCheck_', PascalCase: 'VarCheck', camelCase: 'varcheck' },
  { type: 'Variable (Date)', Snake_Case: 'VarDate_', PascalCase: 'VarDate', camelCase: 'vardate' },
  { type: 'Variable (Date/Time)', Snake_Case: 'VarDateTime_', PascalCase: 'VarDateTime', camelCase: 'vardatetime' },
  { type: 'Variable (Time)', Snake_Case: 'VarTime_', PascalCase: 'VarTime', camelCase: 'vartime' },
  { type: 'Variable (Record)', Snake_Case: 'Rec_', PascalCase: 'Rec', camelCase: 'rec' },
  { type: 'Variable (Picklist)', Snake_Case: 'VarPick_', PascalCase: 'VarPick', camelCase: 'varpick' },
  { type: 'Variable (Multi-Select Picklist)', Snake_Case: 'VarMultiPick_', PascalCase: 'VarMultiPick', camelCase: 'varmultipick' },
  { type: 'Variable (Apex-Defined)', Snake_Case: 'VarApex_', PascalCase: 'VarApex', camelCase: 'varapex' },
  { type: 'Variable', Snake_Case: 'Var_', PascalCase: 'Var', camelCase: 'var' },

  { type: 'Collection (Text)', Snake_Case: 'CollString_', PascalCase: 'CollString', camelCase: 'collstring' },
  { type: 'Collection (Number)', Snake_Case: 'CollNum_', PascalCase: 'CollNum', camelCase: 'collnum' },
  { type: 'Collection (Currency)', Snake_Case: 'CollCur_', PascalCase: 'CollCur', camelCase: 'collcur' },
  { type: 'Collection (Boolean)', Snake_Case: 'CollCheck_', PascalCase: 'CollCheck', camelCase: 'collcheck' },
  { type: 'Collection (Date)', Snake_Case: 'CollDate_', PascalCase: 'CollDate', camelCase: 'colldate' },
  { type: 'Collection (Date/Time)', Snake_Case: 'CollDateTime_', PascalCase: 'CollDateTime', camelCase: 'colldatetime' },
  { type: 'Collection (Time)', Snake_Case: 'CollTime_', PascalCase: 'CollTime', camelCase: 'colltime' },
  { type: 'Collection (Record)', Snake_Case: 'RecColl_', PascalCase: 'RecColl', camelCase: 'reccoll' },
  { type: 'Collection (Picklist)', Snake_Case: 'CollPick_', PascalCase: 'CollPick', camelCase: 'collpick' },
  { type: 'Collection (Multi-Select Picklist)', Snake_Case: 'CollMultiPick_', PascalCase: 'CollMultiPick', camelCase: 'collmultipick' },
  { type: 'Collection (Apex-Defined)', Snake_Case: 'CollApex_', PascalCase: 'CollApex', camelCase: 'collapex' },
  { type: 'Collection', Snake_Case: 'Coll_', PascalCase: 'Coll', camelCase: 'coll' },

  { type: 'Constant', Snake_Case: 'Const_', PascalCase: 'Const', camelCase: 'const' },
  { type: 'Text Template', Snake_Case: 'Template_', PascalCase: 'Template', camelCase: 'template' },
  { type: 'Choice', Snake_Case: 'Choice_', PascalCase: 'Choice', camelCase: 'choice' },
  { type: 'Collection Choice Set', Snake_Case: 'CollChoice_', PascalCase: 'CollChoice', camelCase: 'collchoice' },
  { type: 'Record Choice Set', Snake_Case: 'RecChoice_', PascalCase: 'RecChoice', camelCase: 'recchoice' },
  { type: 'Picklist Choice Set', Snake_Case: 'PickList_', PascalCase: 'PickList', camelCase: 'picklist' },
  { type: 'Stage', Snake_Case: 'Stage_', PascalCase: 'Stage', camelCase: 'stage' },
  { type: 'Step', Snake_Case: 'Step_', PascalCase: 'Step', camelCase: 'step' },
]);

// Lightning icon → prefix-table type. Mirrors ICON_TO_TYPE from
// config/api-name-prefixes.js:32-50.
export const ICON_TO_TYPE: Readonly<Record<string, string>> = Object.freeze({
  'standard:record_lookup': 'get records',
  'standard:record_create': 'create records',
  'standard:record_update': 'update records',
  'standard:record_delete': 'delete records',
  'standard:decision': 'decision',
  'standard:assignment': 'assignment',
  'standard:screen': 'screen',
  'standard:loop': 'loop',
  'standard:apex': 'action',
  'standard:custom': 'action',
  'standard:flow': 'subflow',
  'standard:waits': 'wait',
  'standard:custom_notification': 'custom error',
  'standard:record': 'roll back records',
  'standard:data_transforms': 'transform',
  'standard:sales_path': 'stage',
  'standard:work_order_item': 'step',
});
