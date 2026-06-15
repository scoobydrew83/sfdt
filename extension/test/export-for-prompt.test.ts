import { describe, it, expect } from 'vitest';
import { _exportForPromptTestApi } from '../features/export-for-prompt.js';

const { buildSchemaMarkdown, escapeCell, extractSetupObject } = _exportForPromptTestApi();

describe('export-for-prompt — buildSchemaMarkdown', () => {
  it('renders a dense field table with required + description columns', () => {
    const md = buildSchemaMarkdown('Account', {
      name: 'Account',
      label: 'Account',
      fields: [
        { name: 'Name', label: 'Account Name', type: 'string', nillable: false, inlineHelpText: null },
        { name: 'Industry', label: 'Industry', type: 'picklist', nillable: true, inlineHelpText: 'The sector' },
      ],
    });
    expect(md).toContain('# Schema: Account');
    expect(md).toContain('| Field | Label | Type | Required | Description |');
    expect(md).toContain('| `Name` | Account Name | string | Yes |  |');
    expect(md).toContain('| `Industry` | Industry | picklist | No | The sector |');
  });

  it('reports when describe returns no fields', () => {
    const md = buildSchemaMarkdown('Empty__c', { name: 'Empty__c', label: 'Empty', fields: [] });
    expect(md).toContain('# Schema: Empty__c');
    expect(md).toContain('_No fields returned from describe._');
  });

  it('escapes pipes and newlines so they cannot break the table', () => {
    expect(escapeCell('a | b')).toBe('a \\| b');
    expect(escapeCell('line1\nline2')).toBe('line1 line2');
    const md = buildSchemaMarkdown('Account', {
      name: 'Account',
      label: 'Account',
      fields: [
        { name: 'Notes', label: 'Notes | Extra', type: 'textarea', nillable: true, inlineHelpText: 'see\nthis' },
      ],
    });
    expect(md).toContain('| `Notes` | Notes \\| Extra | textarea | No | see this |');
  });
});

describe('export-for-prompt — extractSetupObject', () => {
  it('extracts a standard object from an Object Manager URL', () => {
    expect(
      extractSetupObject(
        'https://my.lightning.force.com/lightning/setup/ObjectManager/Account/FieldsAndRelationships/view',
      ),
    ).toBe('Account');
  });

  it('extracts a custom object API name', () => {
    expect(
      extractSetupObject(
        'https://my.lightning.force.com/lightning/setup/ObjectManager/Broker__c/Details/view',
      ),
    ).toBe('Broker__c');
  });

  it('extracts a durable entity id segment', () => {
    expect(
      extractSetupObject(
        'https://my.lightning.force.com/lightning/setup/ObjectManager/01I5g000000abcdEAA/Details/view',
      ),
    ).toBe('01I5g000000abcdEAA');
  });

  it('returns null for the Object Manager landing page', () => {
    expect(
      extractSetupObject('https://my.lightning.force.com/lightning/setup/ObjectManager/home/list'),
    ).toBeNull();
  });

  it('returns null for non–Object Manager URLs', () => {
    expect(
      extractSetupObject('https://my.lightning.force.com/lightning/r/Account/001xx/view'),
    ).toBeNull();
    expect(
      extractSetupObject('https://my.lightning.force.com/lightning/setup/FlowDefinition/home'),
    ).toBeNull();
  });
});
