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
  it('maps layout metadata', () => {
    expect(getMetadataType('force-app/main/default/layouts/Account-My Layout.layout-meta.xml')).toBe('Layout');
  });
  it('maps ApexPage (.page-meta.xml)', () => {
    expect(getMetadataType('force-app/main/default/pages/MyPage.page-meta.xml')).toBe('ApexPage');
  });
  it('maps ApexComponent (.component-meta.xml)', () => {
    expect(getMetadataType('force-app/main/default/components/MyComp.component-meta.xml')).toBe('ApexComponent');
  });
  it('maps EmailTemplate (.email-meta.xml)', () => {
    expect(getMetadataType('force-app/main/default/email/MyTemplate.email-meta.xml')).toBe('EmailTemplate');
  });
  it('maps CustomApplication (.app-meta.xml)', () => {
    expect(getMetadataType('force-app/main/default/applications/MyApp.app-meta.xml')).toBe('CustomApplication');
  });
  it('maps CustomTab (.tab-meta.xml)', () => {
    expect(getMetadataType('force-app/main/default/tabs/MyTab.tab-meta.xml')).toBe('CustomTab');
  });
  it('maps CustomLabels (.labels-meta.xml)', () => {
    expect(getMetadataType('force-app/main/default/labels/CustomLabels.labels-meta.xml')).toBe('CustomLabels');
  });
  it('maps LightningComponentBundle via .lwc-meta.xml', () => {
    expect(getMetadataType('force-app/main/default/lwc/myComp/myComp.lwc-meta.xml')).toBe('LightningComponentBundle');
  });
  it('maps CustomMetadata via .customMetadata-meta.xml', () => {
    expect(getMetadataType('force-app/main/default/customMetadata/MyType.MyRecord.customMetadata-meta.xml')).toBe('CustomMetadata');
  });
  it('maps CustomMetadata via .md-meta.xml', () => {
    expect(getMetadataType('force-app/main/default/customMetadata/Foo.md-meta.xml')).toBe('CustomMetadata');
  });
  it('maps ExternalServiceRegistration', () => {
    expect(getMetadataType('force-app/main/default/externalServiceRegistrations/MyESR.externalServiceRegistration-meta.xml')).toBe('ExternalServiceRegistration');
  });
  it('maps ValidationRule', () => {
    expect(getMetadataType('force-app/main/default/objects/Account/validationRules/MyRule.validationRule-meta.xml')).toBe('ValidationRule');
  });
  it('maps RecordType', () => {
    expect(getMetadataType('force-app/main/default/objects/Account/recordTypes/MyType.recordType-meta.xml')).toBe('RecordType');
  });
  it('maps Workflow', () => {
    expect(getMetadataType('force-app/main/default/workflows/Account.workflow-meta.xml')).toBe('Workflow');
  });
  it('maps QuickAction', () => {
    expect(getMetadataType('force-app/main/default/quickActions/MyAction.quickAction-meta.xml')).toBe('QuickAction');
  });
  it('maps GlobalValueSet', () => {
    expect(getMetadataType('force-app/main/default/globalValueSets/MyValueSet.globalValueSet-meta.xml')).toBe('GlobalValueSet');
  });
  it('maps StaticResource', () => {
    expect(getMetadataType('force-app/main/default/staticresources/MyResource.staticresource-meta.xml')).toBe('StaticResource');
  });
  it('maps Profile', () => {
    expect(getMetadataType('force-app/main/default/profiles/Admin.profile-meta.xml')).toBe('Profile');
  });
  it('maps Role', () => {
    expect(getMetadataType('force-app/main/default/roles/CEO.role-meta.xml')).toBe('Role');
  });
  it('maps Group', () => {
    expect(getMetadataType('force-app/main/default/groups/MyGroup.group-meta.xml')).toBe('Group');
  });
  it('maps Queue', () => {
    expect(getMetadataType('force-app/main/default/queues/SupportQueue.queue-meta.xml')).toBe('Queue');
  });
  it('maps FlexiPage', () => {
    expect(getMetadataType('force-app/main/default/flexipages/MyPage.flexipage-meta.xml')).toBe('FlexiPage');
  });
  it('maps CustomObject (.object-meta.xml)', () => {
    expect(getMetadataType('force-app/main/default/objects/Account/Account.object-meta.xml')).toBe('CustomObject');
  });
  it('maps ApexTrigger via .trigger-meta.xml', () => {
    expect(getMetadataType('force-app/main/default/triggers/MyTrigger.trigger-meta.xml')).toBe('ApexTrigger');
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
  it('returns folder name for Aura bundles', () => {
    expect(
      getMemberName(
        'force-app/main/default/aura/myAuraComp/myAuraComp.cmp',
        'AuraDefinitionBundle',
      ),
    ).toBe('myAuraComp');
  });
  it('handles CustomField with no matching object path gracefully', () => {
    const result = getMemberName('fields/Custom__c.field-meta.xml', 'CustomField');
    expect(result).toBe('Custom__c');
  });
  it('strips .flow-meta.xml suffix', () => {
    expect(getMemberName('flows/MyFlow.flow-meta.xml', 'Flow')).toBe('MyFlow');
  });
  it('strips .permissionset-meta.xml suffix', () => {
    expect(getMemberName('permissionsets/MyPerm.permissionset-meta.xml', 'PermissionSet')).toBe('MyPerm');
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
  it('returns empty maps for null/undefined input', () => {
    const result = parseDiffToMetadata(null);
    expect(result.additive).toEqual({});
    expect(result.destructive).toEqual({});
    expect(result.unknown).toEqual([]);
  });
  it('skips __tests__ files in diff output', () => {
    const diff = 'A\tforce-app/main/default/lwc/myComp/__tests__/myComp.test.js';
    const result = parseDiffToMetadata(diff);
    expect(result.additive).toEqual({});
    expect(result.unknown).toEqual([]);
  });
  it('filters by sourcePath — excludes files not under the source path or force-app/', () => {
    const diff = [
      'A\tforce-app/main/default/classes/InApp.cls',
      'A\tsrc/main/default/classes/InSrc.cls',
      'A\tsome/other/path/Excluded.cls',
    ].join('\n');
    const result = parseDiffToMetadata(diff, { sourcePath: 'src/main/default' });
    expect(result.additive.ApexClass).toContain('InApp');
    expect(result.additive.ApexClass).toContain('InSrc');
    expect(result.additive.ApexClass).not.toContain('Excluded');
  });
  it('handles lines without a tab separator gracefully', () => {
    const diff = 'malformed line with no tab';
    const result = parseDiffToMetadata(diff);
    expect(result.additive).toEqual({});
    expect(result.unknown).toEqual([]);
  });
  it('groups multiple deleted members under destructive type', () => {
    const diff = [
      'D\tforce-app/main/default/classes/AlphaService.cls',
      'D\tforce-app/main/default/classes/BetaService.cls',
    ].join('\n');
    const result = parseDiffToMetadata(diff);
    expect(result.destructive.ApexClass).toEqual(['AlphaService', 'BetaService']);
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
    const classPos = xml.indexOf('ApexClass');
    const flowPos = xml.indexOf('Flow');
    expect(classPos).toBeLessThan(flowPos);
    const alphaPos = xml.indexOf('Alpha');
    const zebraPos = xml.indexOf('Zebra');
    expect(alphaPos).toBeLessThan(zebraPos);
  });
  it('uses 63.0 as the default API version', () => {
    const xml = renderPackageXml({ ApexClass: ['Foo'] });
    expect(xml).toContain('<version>63.0</version>');
  });
  it('wraps members in <members> tags', () => {
    const xml = renderPackageXml({ Flow: ['MyFlow'] }, '61.0');
    expect(xml).toContain('<members>MyFlow</members>');
  });
  it('renders the Package xmlns attribute', () => {
    const xml = renderPackageXml({}, '61.0');
    expect(xml).toContain('xmlns="http://soap.sforce.com/2006/04/metadata"');
  });
  it('handles empty metadata map without crashing', () => {
    const xml = renderPackageXml({}, '61.0');
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<version>61.0</version>');
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
