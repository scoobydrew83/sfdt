import { describe, it, expect } from 'vitest';
import {
  classifyOfflineSource,
  isSelfDefinition,
  fieldReferenceRegex,
  buildOfflineUsageVM,
  type OfflineHit,
} from '../src/field-usage-offline.js';

// Offline mode has exactly two ways to be worthless, and both are silent:
//
//   1. Counting profiles, permission sets and layouts as "use" — they name every
//      field they expose, so everything comes back referenced.
//   2. Matching field names by substring — `Region__c` occurs inside
//      `Sub_Region__c`, so short fields never appear as candidates.
//
// Most of what follows guards those two.

const FIELDS = [
  { name: 'Region__c', label: 'Region', type: 'Picklist' },
  { name: 'Sub_Region__c', label: 'Sub Region', type: 'Text' },
  { name: 'Legacy__c', label: 'Legacy', type: 'Text' },
];

describe('classifyOfflineSource', () => {
  it('treats behaviour metadata as logical use', () => {
    for (const [p, type] of [
      ['force-app/main/default/classes/AccountService.cls', 'ApexClass'],
      ['force-app/main/default/triggers/AccountTrigger.trigger', 'ApexTrigger'],
      ['force-app/main/default/flows/Set_Region.flow-meta.xml', 'Flow'],
      ['force-app/main/default/objects/Account/validationRules/Req.validationRule-meta.xml', 'ValidationRule'],
      ['force-app/main/default/reports/Sales/Pipeline.report-meta.xml', 'Report'],
      ['force-app/main/default/lwc/regionPicker/regionPicker.js', 'LightningComponentBundle'],
    ] as const) {
      expect(classifyOfflineSource(p)).toEqual({ type, kind: 'logical' });
    }
  });

  it('treats access and presentation metadata as STRUCTURAL, not use', () => {
    // The distinction the whole mode rests on. A profile names a field because
    // it exists, not because anything depends on its value.
    for (const p of [
      'force-app/main/default/layouts/Account-Account Layout.layout-meta.xml',
      'force-app/main/default/profiles/Admin.profile-meta.xml',
      'force-app/main/default/permissionsets/Sales.permissionset-meta.xml',
      'force-app/main/default/objects/Account/fieldSets/Compact.fieldSet-meta.xml',
    ]) {
      expect(classifyOfflineSource(p)?.kind).toBe('structural');
    }
  });

  it('never scans the object file, where every field is named by definition', () => {
    expect(classifyOfflineSource('force-app/main/default/objects/Account/Account.object-meta.xml')).toBeNull();
  });

  it('does scan field files, because another field\'s formula is real use', () => {
    expect(classifyOfflineSource('force-app/main/default/objects/Account/fields/Region__c.field-meta.xml'))
      .toEqual({ type: 'CustomField', kind: 'logical' });
  });

  it('ignores files that are not metadata at all', () => {
    expect(classifyOfflineSource('README.md')).toBeNull();
    expect(classifyOfflineSource('force-app/main/default/staticresources/logo.png')).toBeNull();
  });

  it('classifies Windows-style paths identically', () => {
    expect(classifyOfflineSource('force-app\\main\\default\\classes\\A.cls')).toEqual({
      type: 'ApexClass',
      kind: 'logical',
    });
  });
});

describe('isSelfDefinition', () => {
  it('recognises a field\'s own metadata file', () => {
    const p = 'force-app/main/default/objects/Account/fields/Region__c.field-meta.xml';
    expect(isSelfDefinition(p, 'Region__c')).toBe(true);
    // A DIFFERENT field's file is a genuine reference candidate (a formula).
    expect(isSelfDefinition(p, 'Legacy__c')).toBe(false);
  });
});

describe('fieldReferenceRegex', () => {
  it('does not match a field name embedded in a longer one', () => {
    // `\b` alone fails here: `_` is a word character, so `\bRegion__c\b` still
    // matches inside `Sub_Region__c` and every short field stays alive forever.
    const re = fieldReferenceRegex('Region__c');
    expect(re.test('acc.Region__c = x;')).toBe(true);
    expect(re.test('acc.Sub_Region__c = x;')).toBe(false);
    expect(re.test('<field>Region__c</field>')).toBe(true);
    expect(re.test('MyRegion__cSuffix')).toBe(false);
  });

  it('escapes regex metacharacters in the field name', () => {
    expect(() => fieldReferenceRegex('Weird.Name')).not.toThrow();
    expect(fieldReferenceRegex('Weird.Name').test('WeirdXName')).toBe(false);
  });
});

describe('buildOfflineUsageVM', () => {
  const hit = (field: string, path: string, type: string, kind: 'logical' | 'structural'): OfflineHit =>
    ({ field, path, type, kind });

  it('counts a field referenced only by a profile and a layout as UNREFERENCED', () => {
    // The headline behaviour. Anything else makes the mode useless.
    const vm = buildOfflineUsageVM({
      object: 'Account',
      fields: FIELDS,
      hits: [
        hit('Legacy__c', 'profiles/Admin.profile-meta.xml', 'Profile', 'structural'),
        hit('Legacy__c', 'layouts/Account.layout-meta.xml', 'Layout', 'structural'),
      ],
    });
    const row = vm.rows.find((r) => r.name === 'Legacy__c')!;

    expect(row.unreferenced).toBe(true);
    // …but the structural hits are still reported, because removing the field
    // means removing those entries too.
    expect(row.referenceCount).toBe(2);
    expect(row.references.map((g) => g.type)).toEqual(['Layout (structural)', 'Profile (structural)']);
    expect(vm.notes.some((n) => n.includes('ONLY in layouts, profiles'))).toBe(true);
  });

  it('counts a field referenced by Apex as referenced', () => {
    const vm = buildOfflineUsageVM({
      object: 'Account',
      fields: FIELDS,
      hits: [hit('Region__c', 'classes/AccountService.cls', 'ApexClass', 'logical')],
    });

    expect(vm.rows.find((r) => r.name === 'Region__c')!.unreferenced).toBe(false);
    expect(vm.counts.unreferenced).toBe(2);
  });

  it('NEVER reports a field as safe to remove from a repo scan alone', () => {
    // There is no data to count offline, and a field unreferenced in source may
    // hold millions of values in every org it is deployed to.
    const vm = buildOfflineUsageVM({ object: 'Account', fields: FIELDS, hits: [] });

    expect(vm.rows.every((r) => r.safeToRemove === null)).toBe(true);
    expect(vm.counts.safeToRemove).toBe(0);
    expect(vm.notes.some((n) => n.includes('no field is reported as safe to remove'))).toBe(true);
  });

  it('always states that a text match is not a reference', () => {
    const vm = buildOfflineUsageVM({ object: 'Account', fields: FIELDS, hits: [] });
    expect(vm.notes.some((n) => n.includes('ALWAYS inferred'))).toBe(true);
    // Dynamic SOQL is invisible to any text scan; say so rather than let a
    // clean result imply completeness.
    expect(vm.notes.some((n) => n.includes('dynamic'))).toBe(true);
  });

  it('sorts unreferenced fields first', () => {
    const vm = buildOfflineUsageVM({
      object: 'Account',
      fields: FIELDS,
      hits: [hit('Region__c', 'classes/A.cls', 'ApexClass', 'logical')],
    });
    expect(vm.rows.map((r) => r.name)).toEqual(['Legacy__c', 'Sub_Region__c', 'Region__c']);
  });

  it('produces the same VM shape as the org sweep so both render identically', () => {
    const vm = buildOfflineUsageVM({ object: 'Account', fields: FIELDS, hits: [] });
    expect(Object.keys(vm.counts).sort()).toEqual(
      ['safeToRemove', 'scanned', 'total', 'unknown', 'unreferenced'].sort(),
    );
    expect(vm.rows[0]).toHaveProperty('keepReason');
    expect(vm.rows[0]).toHaveProperty('populated');
  });
});
