import { describe, it, expect } from 'vitest';
import {
  escapeSoql,
  METADATA_TYPES,
  resolveQueryFor,
  referencesQuery,
  referencedByQuery,
  groupByType,
} from '../src/dependencies.js';

describe('escapeSoql', () => {
  it('escapes single-quotes and backslashes', () => {
    expect(escapeSoql("O'Brien")).toBe("O\\'Brien");
    expect(escapeSoql('a\\b')).toBe('a\\\\b');
  });
});

describe('resolveQueryFor', () => {
  it('keys Apex types on Name and Flow/LWC/CustomField on DeveloperName', () => {
    expect(resolveQueryFor('ApexClass', 'AccountSvc')).toBe(
      "SELECT Id FROM ApexClass WHERE Name='AccountSvc'",
    );
    expect(resolveQueryFor('Flow', 'My_Flow')).toBe(
      "SELECT Id FROM FlowDefinition WHERE DeveloperName='My_Flow'",
    );
  });
  it('escapes the name and throws on unsupported types', () => {
    expect(resolveQueryFor('ApexClass', "x'y")).toContain("Name='x\\'y'");
    expect(() => resolveQueryFor('Nope', 'x')).toThrow(/Unsupported/);
  });
  it('exposes the picker order', () => {
    expect(METADATA_TYPES).toContain('ApexClass');
    expect(METADATA_TYPES).toContain('LightningComponentBundle');
  });
});

describe('reference queries', () => {
  it('build the two MetadataComponentDependency directions with the Id', () => {
    expect(referencesQuery('01p000000000001')).toContain("MetadataComponentId = '01p000000000001'");
    expect(referencedByQuery('01p000000000001')).toContain("RefMetadataComponentId = '01p000000000001'");
  });
});

describe('groupByType', () => {
  it('collapses rows into per-type groups sorted by type then name', () => {
    const groups = groupByType(
      [
        { RefMetadataComponentName: 'Zeta', RefMetadataComponentType: 'ApexClass' },
        { RefMetadataComponentName: 'Alpha', RefMetadataComponentType: 'ApexClass' },
        { RefMetadataComponentName: 'Beta', RefMetadataComponentType: 'Flow' },
      ],
      'RefMetadataComponentName',
      'RefMetadataComponentType',
    );
    expect(groups).toEqual([
      { type: 'ApexClass', names: ['Alpha', 'Zeta'] },
      { type: 'Flow', names: ['Beta'] },
    ]);
  });
});
