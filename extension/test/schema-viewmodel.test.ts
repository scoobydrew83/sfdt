import { describe, it, expect } from 'vitest';
import {
  toObjectListVM,
  toFieldTableVM,
  toObjectMetaVM,
  buildObjectGraphVM,
  typeDisplay,
  MAX_GRAPH_NEIGHBOURS,
} from '../lib/schema-viewmodel.js';
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

describe('schema-viewmodel — flag mapping', () => {
  it('reads the optional flags as `=== true`, so absent means no', () => {
    // These are optional on FieldDescribe. A truthiness check would be the same
    // here but `!== false` would flip an absent value to "yes", which for
    // externalId/unique is a claim about the schema that isn't in the data.
    const vm = toFieldTableVM({
      name: 'Account',
      label: 'Account',
      fields: [
        field({ name: 'A', type: 'string' }),
        field({ name: 'B', type: 'string', unique: true, externalId: true, autoNumber: true }),
        field({ name: 'C', type: 'string', inlineHelpText: 'Ask finance.' }),
      ],
    });
    expect(vm.fields[0]).toMatchObject({ unique: false, externalId: false, autoNumber: false, helpText: '' });
    expect(vm.fields[1]).toMatchObject({ unique: true, externalId: true, autoNumber: true });
    expect(vm.fields[2]!.helpText).toBe('Ask finance.');
  });
});

describe('schema-viewmodel — typeDisplay', () => {
  it('speaks the Setup vocabulary, not the wire types', () => {
    expect(typeDisplay({ type: 'string', length: 255 })).toBe('Text(255)');
    expect(typeDisplay({ type: 'textarea', length: 32768 })).toBe('Long Text(32768)');
    expect(typeDisplay({ type: 'double', precision: 18, scale: 2 })).toBe('Number(18,2)');
    expect(typeDisplay({ type: 'currency', precision: 18, scale: 0 })).toBe('Currency(18,0)');
    expect(typeDisplay({ type: 'reference' })).toBe('Lookup');
    expect(typeDisplay({ type: 'boolean' })).toBe('Checkbox');
    expect(typeDisplay({ type: 'multipicklist' })).toBe('Multi-Picklist');
  });

  it('omits a size that carries no information', () => {
    // A length of 0 on a picklist is not "Picklist(0)".
    expect(typeDisplay({ type: 'picklist', length: 0 })).toBe('Picklist');
    expect(typeDisplay({ type: 'string' })).toBe('Text');
    expect(typeDisplay({ type: 'double', precision: 0 })).toBe('Number');
  });

  it('degrades to the raw type rather than to nothing', () => {
    // A field type Salesforce adds after this map was written must still render.
    expect(typeDisplay({ type: 'someFutureType' })).toBe('someFutureType');
  });
});

describe('schema-viewmodel — toObjectMetaVM', () => {
  it('maps the describe attributes the rail shows', () => {
    const meta = toObjectMetaVM({
      name: 'Widget__c',
      label: 'Widget',
      labelPlural: 'Widgets',
      keyPrefix: 'a01',
      custom: true,
      searchable: true,
      queryable: true,
      createable: true,
      updateable: false,
      deletable: false,
      fields: [
        field({ name: 'Name', type: 'string' }),
        field({ name: 'Size__c', type: 'double' }),
        field({ name: 'Colour__c', type: 'string' }),
      ],
    });
    expect(meta).toMatchObject({
      name: 'Widget__c',
      labelPlural: 'Widgets',
      keyPrefix: 'a01',
      custom: true,
      updateable: false,
      fieldCount: 3,
      customFieldCount: 2,
    });
  });

  it('falls back to the singular label and a null prefix', () => {
    const meta = toObjectMetaVM({ name: 'Account', label: 'Account', fields: [] });
    expect(meta.labelPlural).toBe('Account');
    expect(meta.keyPrefix).toBeNull();
    expect(meta.custom).toBe(false);
  });
});

describe('schema-viewmodel — buildObjectGraphVM', () => {
  const vm = (over: Partial<ReturnType<typeof toFieldTableVM>> = {}) => ({
    fields: [],
    childRelationships: [],
    ...over,
  });

  it('lays children left, the object centre, and its lookups right', () => {
    // Columns follow the direction of reference, which is what makes every
    // rendered arrow run left-to-right with no special casing.
    const g = buildObjectGraphVM('Account', vm({
      fields: [{ name: 'OwnerId', label: 'Owner', type: 'reference', custom: false, nillable: true, unique: false, externalId: false, autoNumber: false, calculated: false, helpText: '', referenceTo: ['User'] }],
      childRelationships: [{ childSObject: 'Contact', field: 'AccountId', relationshipName: 'Contacts' }],
    }));
    expect(g.maxDepth.get('Contact')).toBe(0);
    expect(g.maxDepth.get('Account')).toBe(1);
    expect(g.maxDepth.get('User')).toBe(2);
    expect(g.nodes.get('Contact')!.outgoing).toEqual([{ id: 'Account', missing: false }]);
    expect(g.nodes.get('Account')!.outgoing).toEqual([{ id: 'User', missing: false }]);
  });

  it('drops self-references rather than drawing a backwards loop', () => {
    // Account.ParentId → Account. The field row's Details cell already shows it.
    const g = buildObjectGraphVM('Account', vm({
      fields: [{ name: 'ParentId', label: 'Parent', type: 'reference', custom: false, nillable: true, unique: false, externalId: false, autoNumber: false, calculated: false, helpText: '', referenceTo: ['Account'] }],
    }));
    expect(g.nodes.get('Account')!.outgoing).toEqual([]);
    expect(g.nodes.size).toBe(1);
  });

  it('caps neighbours and REPORTS what it dropped', () => {
    // A silent cap reads as "this is everything". An Account has 60+ children.
    const children = Array.from({ length: MAX_GRAPH_NEIGHBOURS + 5 }, (_, i) => ({
      childSObject: `Child${String(i).padStart(2, '0')}`,
      field: 'AccountId',
      relationshipName: null,
    }));
    const g = buildObjectGraphVM('Account', vm({ childRelationships: children }));
    expect(g.truncated.children).toBe(5);
    expect(g.nodes.size).toBe(MAX_GRAPH_NEIGHBOURS + 1);
  });

  it('declares no cycles — a parent lookup is not a defect', () => {
    // The renderer paints cycles in the error colour. That is right for a Flow
    // calling itself and wrong for an object hierarchy.
    expect(buildObjectGraphVM('Account', vm()).cycles).toEqual([]);
  });

  it('deduplicates repeated targets', () => {
    const g = buildObjectGraphVM('Case', vm({
      childRelationships: [
        { childSObject: 'Task', field: 'WhatId', relationshipName: 'Tasks' },
        { childSObject: 'Task', field: 'WhoId', relationshipName: 'Tasks2' },
      ],
    }));
    expect(g.nodes.size).toBe(2);
  });
});
