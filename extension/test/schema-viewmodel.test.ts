import { describe, it, expect } from 'vitest';
import { toObjectListVM, toFieldTableVM } from '../lib/schema-viewmodel.js';
import type { GlobalDescribe, SObjectDescribe, FieldDescribe } from '../lib/describe-cache.js';

function field(partial: Partial<FieldDescribe> & { name: string; type: string }): FieldDescribe {
  return {
    label: partial.name,
    relationshipName: null,
    referenceTo: [],
    picklistValues: [],
    nillable: true,
    calculated: false,
    ...partial,
  };
}

describe('schema-viewmodel — toObjectListVM', () => {
  it('maps sobjects and derives custom from the __c suffix', () => {
    const global: GlobalDescribe = {
      sobjects: [
        { name: 'Account', label: 'Account', keyPrefix: '001' },
        { name: 'Widget__c', label: 'Widget', keyPrefix: 'a01' },
      ],
    };
    const vm = toObjectListVM(global);
    expect(vm).toEqual([
      { name: 'Account', label: 'Account', keyPrefix: '001', custom: false },
      { name: 'Widget__c', label: 'Widget', keyPrefix: 'a01', custom: true },
    ]);
  });

  it('tolerates a missing sobjects array', () => {
    expect(toObjectListVM({} as GlobalDescribe)).toEqual([]);
  });
});

describe('schema-viewmodel — toFieldTableVM', () => {
  const describe_: SObjectDescribe = {
    name: 'Account',
    label: 'Account',
    fields: [
      field({ name: 'BillingAddress', type: 'address', label: 'Billing Address' }),
      field({ name: 'BillingStreet', type: 'string', compoundFieldName: 'BillingAddress', length: 255 }),
      field({ name: 'BillingCity', type: 'string', compoundFieldName: 'BillingAddress', length: 40 }),
      field({
        name: 'Industry',
        type: 'picklist',
        picklistValues: [
          { value: 'Tech', label: 'Technology' },
          { value: 'Finance', label: 'Finance' },
        ],
      }),
      field({
        name: 'OwnerId',
        type: 'reference',
        relationshipName: 'Owner',
        referenceTo: ['User'],
      }),
      field({
        name: 'FullName__c',
        type: 'string',
        calculated: true,
        calculatedFormula: 'FirstName & " " & LastName',
      }),
    ],
    childRelationships: [
      { childSObject: 'Contact', field: 'AccountId', relationshipName: 'Contacts' },
      { childSObject: 'Opportunity', field: 'AccountId', relationshipName: 'Opportunities' },
    ],
  };

  const vm = toFieldTableVM(describe_);
  const byName = (n: string) => vm.fields.find((f) => f.name === n)!;

  it('flattens compound fields — parent lists its components', () => {
    expect(byName('BillingAddress').components).toEqual(['BillingStreet', 'BillingCity']);
    expect(byName('BillingStreet').compoundFieldName).toBe('BillingAddress');
    expect(byName('BillingCity').compoundFieldName).toBe('BillingAddress');
  });

  it('expands picklist values to plain strings', () => {
    expect(byName('Industry').picklistValues).toEqual(['Tech', 'Finance']);
  });

  it('resolves reference targets and relationship name', () => {
    const owner = byName('OwnerId');
    expect(owner.referenceTo).toEqual(['User']);
    expect(owner.relationshipName).toBe('Owner');
  });

  it('extracts formula source', () => {
    expect(byName('FullName__c').formula).toBe('FirstName & " " & LastName');
    expect(byName('FullName__c').custom).toBe(true);
  });

  it('carries the child-relationship list', () => {
    expect(vm.childRelationships).toHaveLength(2);
    expect(vm.childRelationships[0]).toEqual({
      childSObject: 'Contact',
      field: 'AccountId',
      relationshipName: 'Contacts',
    });
  });

  it('carries field length when present', () => {
    expect(byName('BillingStreet').length).toBe(255);
  });

  it('tolerates a missing fields/childRelationships', () => {
    const vmEmpty = toFieldTableVM({ name: 'X', label: 'X', fields: [] } as SObjectDescribe);
    expect(vmEmpty.fields).toEqual([]);
    expect(vmEmpty.childRelationships).toEqual([]);
  });
});
