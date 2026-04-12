import { describe, it, expect } from 'vitest';
import {
  getMetadataType,
  getMemberName,
  parseDiffToMetadata,
  renderPackageXml,
  countMembers,
} from '../src/lib/metadata-mapper.js';

describe('getMetadataType', () => {
  it('maps .cls files to ApexClass', () => {
    expect(getMetadataType('force-app/main/default/classes/AccountHelper.cls')).toBe('ApexClass');
    expect(getMetadataType('force-app/main/default/classes/AccountHelper.cls-meta.xml')).toBe(
      'ApexClass',
    );
  });

  it('maps .trigger files to ApexTrigger', () => {
    expect(getMetadataType('force-app/main/default/triggers/AccountTrigger.trigger')).toBe(
      'ApexTrigger',
    );
  });

  it('maps flow metadata', () => {
    expect(getMetadataType('force-app/main/default/flows/MyFlow.flow-meta.xml')).toBe('Flow');
  });

  it('maps field metadata to CustomField', () => {
    expect(
      getMetadataType(
        'force-app/main/default/objects/Account/fields/Custom__c.field-meta.xml',
      ),
    ).toBe('CustomField');
  });

  it('maps LWC by directory pattern', () => {
    expect(getMetadataType('force-app/main/default/lwc/myComponent/myComponent.js')).toBe(
      'LightningComponentBundle',
    );
  });

  it('maps Aura by directory pattern', () => {
    expect(getMetadataType('force-app/main/default/aura/myAura/myAura.cmp')).toBe(
      'AuraDefinitionBundle',
    );
  });

  it('returns SKIP for __tests__ files', () => {
    expect(
      getMetadataType(
        'force-app/main/default/lwc/myComponent/__tests__/myComponent.test.js',
      ),
    ).toBe('SKIP');
  });

  it('returns UNKNOWN for unrecognised files', () => {
    expect(getMetadataType('README.md')).toBe('UNKNOWN');
  });

  it('returns UNKNOWN for null/empty input', () => {
    expect(getMetadataType(null)).toBe('UNKNOWN');
    expect(getMetadataType('')).toBe('UNKNOWN');
  });

  it('maps permissionset metadata', () => {
    expect(
      getMetadataType('force-app/main/default/permissionsets/MyPerm.permissionset-meta.xml'),
    ).toBe('PermissionSet');
  });
});

describe('getMemberName', () => {
  it('strips suffixes for standard types', () => {
    expect(
      getMemberName('force-app/main/default/classes/AccountHelper.cls', 'ApexClass'),
    ).toBe('AccountHelper');
    expect(
      getMemberName(
        'force-app/main/default/classes/AccountHelper.cls-meta.xml',
        'ApexClass',
      ),
    ).toBe('AccountHelper');
  });

  it('returns Object.Field for CustomField', () => {
    expect(
      getMemberName(
        'force-app/main/default/objects/Account/fields/Custom__c.field-meta.xml',
        'CustomField',
      ),
    ).toBe('Account.Custom__c');
  });

  it('returns folder name for LWC bundles', () => {
    expect(
      getMemberName(
        'force-app/main/default/lwc/myComponent/myComponent.js',
        'LightningComponentBundle',
      ),
    ).toBe('myComponent');
  });
});

describe('parseDiffToMetadata', () => {
  it('parses additive and destructive entries', () => {
    const diff = [
      'A\tforce-app/main/default/classes/AccountHelper.cls',
      'A\tforce-app/main/default/classes/AccountHelper.cls-meta.xml',
      'M\tforce-app/main/default/flows/MyFlow.flow-meta.xml',
      'D\tforce-app/main/default/classes/OldService.cls',
      'D\tforce-app/main/default/classes/OldService.cls-meta.xml',
    ].join('\n');

    const result = parseDiffToMetadata(diff);

    expect(result.additive.ApexClass).toEqual(['AccountHelper']);
    expect(result.additive.Flow).toEqual(['MyFlow']);
    expect(result.destructive.ApexClass).toEqual(['OldService']);
  });

  it('deduplicates LWC bundle members', () => {
    const diff = [
      'A\tforce-app/main/default/lwc/myLwc/myLwc.js',
      'A\tforce-app/main/default/lwc/myLwc/myLwc.html',
      'A\tforce-app/main/default/lwc/myLwc/myLwc.css',
    ].join('\n');

    const result = parseDiffToMetadata(diff);
    expect(result.additive.LightningComponentBundle).toEqual(['myLwc']);
  });

  it('populates unknown list for unmapped files', () => {
    const diff = 'A\tforce-app/main/default/somethingNew/file.xyz';
    const result = parseDiffToMetadata(diff);
    expect(result.unknown).toContain('force-app/main/default/somethingNew/file.xyz');
  });

  it('returns empty maps for empty input', () => {
    const result = parseDiffToMetadata('');
    expect(result.additive).toEqual({});
    expect(result.destructive).toEqual({});
    expect(result.unknown).toEqual([]);
  });

  it('handles rename status lines (R100)', () => {
    const diff = 'R100\tforce-app/main/default/classes/Old.cls\tforce-app/main/default/classes/New.cls';
    const result = parseDiffToMetadata(diff);
    expect(result.additive.ApexClass).toEqual(['New']);
  });
});

describe('renderPackageXml', () => {
  it('generates valid XML with sorted types and members', () => {
    const xml = renderPackageXml(
      {
        Flow: ['MyFlow'],
        ApexClass: ['Zebra', 'Alpha'],
      },
      '63.0',
    );

    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<name>ApexClass</name>');
    expect(xml).toContain('<name>Flow</name>');
    expect(xml).toContain('<version>63.0</version>');

    // ApexClass should appear before Flow (alphabetical)
    const classPos = xml.indexOf('ApexClass');
    const flowPos = xml.indexOf('Flow');
    expect(classPos).toBeLessThan(flowPos);

    // Members should be sorted
    const alphaPos = xml.indexOf('Alpha');
    const zebraPos = xml.indexOf('Zebra');
    expect(alphaPos).toBeLessThan(zebraPos);
  });
});

describe('countMembers', () => {
  it('sums members across all types', () => {
    expect(countMembers({ ApexClass: ['A', 'B'], Flow: ['F1'] })).toBe(3);
  });

  it('returns 0 for empty map', () => {
    expect(countMembers({})).toBe(0);
  });
});
