import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('execa', () => ({ execa: vi.fn() }));
vi.mock('glob', () => ({ glob: vi.fn() }));
vi.mock('../../src/lib/metadata-mapper.js', () => ({
  getMetadataType: vi.fn(),
  getMemberName: vi.fn(),
}));

import { execa } from 'execa';
import { glob } from 'glob';
import { getMetadataType, getMemberName } from '../../src/lib/metadata-mapper.js';
import { fetchInventory, fetchOrgInventory, fetchLocalInventory } from '../../src/lib/org-inventory.js';

const BASE_CONFIG = {
  _projectRoot: '/project',
  defaultSourcePath: 'force-app/main/default',
};

beforeEach(() => vi.resetAllMocks());

describe('fetchOrgInventory', () => {
  it('returns a Map with member Sets per type', async () => {
    // First call: list metadata types
    execa.mockResolvedValueOnce({
      stdout: JSON.stringify({
        status: 0,
        result: {
          metadataObjects: [
            { xmlName: 'ApexClass' },
            { xmlName: 'Flow' },
          ],
        },
      }),
    });
    // Second call: list ApexClass members
    execa.mockResolvedValueOnce({
      stdout: JSON.stringify({
        status: 0,
        result: [{ fullName: 'MyClass' }, { fullName: 'OtherClass' }],
      }),
    });
    // Third call: list Flow members
    execa.mockResolvedValueOnce({
      stdout: JSON.stringify({ status: 0, result: [] }),
    });

    const map = await fetchOrgInventory('dev', BASE_CONFIG);

    expect(map.get('ApexClass')).toEqual(new Set(['MyClass', 'OtherClass']));
    expect(map.has('Flow')).toBe(false); // empty types omitted
  });

  it('ignores types that return empty results', async () => {
    execa.mockResolvedValueOnce({
      stdout: JSON.stringify({
        status: 0,
        result: { metadataObjects: [{ xmlName: 'CustomObject' }] },
      }),
    });
    execa.mockResolvedValueOnce({
      stdout: JSON.stringify({ status: 0, result: [] }),
    });

    const map = await fetchOrgInventory('dev', BASE_CONFIG);
    expect(map.size).toBe(0);
  });
});

describe('fetchLocalInventory', () => {
  it('returns a Map of type → Set<member> from globbed files', async () => {
    glob.mockResolvedValue([
      'classes/MyClass.cls-meta.xml',
      'classes/OtherClass.cls-meta.xml',
      'flows/MyFlow.flow-meta.xml',
    ]);
    getMetadataType
      .mockReturnValueOnce('ApexClass')
      .mockReturnValueOnce('ApexClass')
      .mockReturnValueOnce('Flow');
    getMemberName
      .mockReturnValueOnce('MyClass')
      .mockReturnValueOnce('OtherClass')
      .mockReturnValueOnce('MyFlow');

    const map = await fetchLocalInventory(BASE_CONFIG);

    expect(map.get('ApexClass')).toEqual(new Set(['MyClass', 'OtherClass']));
    expect(map.get('Flow')).toEqual(new Set(['MyFlow']));
  });

  it('skips files with SKIP or UNKNOWN type', async () => {
    glob.mockResolvedValue(['__tests__/Foo.test.js', 'unknown/file.xml']);
    getMetadataType.mockReturnValueOnce('SKIP').mockReturnValueOnce('UNKNOWN');

    const map = await fetchLocalInventory(BASE_CONFIG);
    expect(map.size).toBe(0);
  });
});

describe('fetchInventory', () => {
  it('calls fetchLocalInventory when source is "local"', async () => {
    glob.mockResolvedValue([]);
    const map = await fetchInventory('local', BASE_CONFIG);
    expect(map instanceof Map).toBe(true);
    expect(execa).not.toHaveBeenCalled();
  });

  it('calls fetchOrgInventory when source is an org alias', async () => {
    execa.mockResolvedValueOnce({
      stdout: JSON.stringify({ status: 0, result: { metadataObjects: [] } }),
    });
    const map = await fetchInventory('prod', BASE_CONFIG);
    expect(map instanceof Map).toBe(true);
    expect(execa).toHaveBeenCalledWith(
      'sf',
      expect.arrayContaining(['org', 'list', 'metadata-types']),
    );
  });
});

describe('fetchOrgInventory withDates mode', () => {
  it('returns Map<type, Map<name, lastModifiedDate>> when withDates is true', async () => {
    execa.mockResolvedValueOnce({
      stdout: JSON.stringify({ status: 0, result: { metadataObjects: [{ xmlName: 'ApexClass' }] } }),
    });
    execa.mockResolvedValueOnce({
      stdout: JSON.stringify({ status: 0, result: [{ fullName: 'MyClass', lastModifiedDate: '2026-04-01T00:00:00.000Z' }] }),
    });

    const map = await fetchOrgInventory('dev', null, { withDates: true });
    expect(map.get('ApexClass')).toBeInstanceOf(Map);
    expect(map.get('ApexClass').get('MyClass')).toBe('2026-04-01T00:00:00.000Z');
  });

  it('still returns Map<type, Set<name>> by default (no regression)', async () => {
    execa.mockResolvedValueOnce({
      stdout: JSON.stringify({ status: 0, result: { metadataObjects: [{ xmlName: 'ApexClass' }] } }),
    });
    execa.mockResolvedValueOnce({
      stdout: JSON.stringify({ status: 0, result: [{ fullName: 'MyClass', lastModifiedDate: '2026-04-01T00:00:00.000Z' }] }),
    });

    const map = await fetchOrgInventory('dev', BASE_CONFIG);
    expect(map.get('ApexClass')).toBeInstanceOf(Set);
    expect(map.get('ApexClass').has('MyClass')).toBe(true);
  });
});
