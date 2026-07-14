import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs-extra';

vi.mock('../../src/lib/org-query.js', () => ({ query: vi.fn() }));
vi.mock('../../src/lib/org-release.js', () => ({ detectOrgRelease: vi.fn() }));

import { query } from '../../src/lib/org-query.js';
import { detectOrgRelease } from '../../src/lib/org-release.js';
import { scanLocalApiVersions, fetchOrgApiVersions, buildReport } from '../../src/lib/api-versions.js';

const meta = (v) => `<?xml version="1.0"?><root><apiVersion>${v}</apiVersion></root>`;

let tmp;
beforeEach(async () => {
  vi.resetAllMocks();
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sfdt-apiver-'));
});
afterEach(() => fs.remove(tmp));

describe('scanLocalApiVersions', () => {
  it('scans apex/trigger/flow/lwc/aura meta files across package-root and direct layouts', async () => {
    // package-root layout (metadata under main/default) — like sfdx "force-app"
    const base = path.join(tmp, 'force-app', 'main', 'default');
    await fs.outputFile(path.join(base, 'classes', 'Foo.cls-meta.xml'), meta('58.0'));
    await fs.outputFile(path.join(base, 'triggers', 'Bar.trigger-meta.xml'), meta('45.0'));
    await fs.outputFile(path.join(base, 'flows', 'My_Flow.flow-meta.xml'), meta('60.0'));
    await fs.outputFile(path.join(base, 'lwc', 'cmp', 'cmp.js-meta.xml'), meta('61.0'));
    await fs.outputFile(path.join(base, 'aura', 'aur', 'aur.cmp-meta.xml'), meta('40.0'));
    // aura meta variant WITHOUT apiVersion must be dropped, not counted
    await fs.outputFile(path.join(base, 'aura', 'aur', 'aur.design-meta.xml'), '<?xml version="1.0"?><design/>');

    const config = {
      _projectRoot: tmp,
      // sfdx-project.json shape: objects with path/absolutePath
      packageDirectories: [{ path: 'force-app', absolutePath: path.join(tmp, 'force-app') }],
      sourceApiVersion: '66.0',
    };
    const { components, sourceApiVersion } = await scanLocalApiVersions(config);
    expect(sourceApiVersion).toBe('66.0');
    expect(components.map((c) => [c.type, c.name, c.apiVersion])).toEqual([
      ['ApexClass', 'Foo', 58],
      ['ApexTrigger', 'Bar', 45],
      ['Flow', 'My_Flow', 60],
      ['LWC', 'cmp', 61],
      ['Aura', 'aur', 40], // bundle name — the .cmp-meta.xml suffix strips entirely
    ]);
    expect(components.every((c) => typeof c.file === 'string' && !path.isAbsolute(c.file))).toBe(true);
  });

  it('buckets meta files without apiVersion as unspecified (null), never below-floor', async () => {
    const base = path.join(tmp, 'src');
    await fs.outputFile(path.join(base, 'classes', 'NoVer.cls-meta.xml'), '<?xml version="1.0"?><ApexClass/>');
    const config = { _projectRoot: tmp, packageDirectories: [], defaultSourcePath: 'src' };
    const { components } = await scanLocalApiVersions(config);
    expect(components).toHaveLength(1);
    expect(components[0].apiVersion).toBeNull();
    const report = buildReport({ components, sourceApiVersion: '66.0' }, null, { minApiVersion: 45 });
    expect(report.local.unspecified).toBe(1);
    expect(report.local.outliers).toHaveLength(0);
  });

  it('scans multiple package directories and skips missing ones', async () => {
    await fs.outputFile(path.join(tmp, 'pkg-a', 'classes', 'A.cls-meta.xml'), meta('50.0'));
    await fs.outputFile(path.join(tmp, 'pkg-b', 'classes', 'B.cls-meta.xml'), meta('51.0'));
    const config = {
      _projectRoot: tmp,
      packageDirectories: [{ path: 'pkg-a' }, { path: 'pkg-b' }, { path: 'gone' }],
    };
    const { components } = await scanLocalApiVersions(config);
    expect(components.map((c) => c.name).sort()).toEqual(['A', 'B']);
  });
});

describe('fetchOrgApiVersions', () => {
  it('collects per-type rows and the ceiling', async () => {
    detectOrgRelease.mockResolvedValue({ release: "Summer '26", apiVersion: 67, preview: false });
    query.mockImplementation(async (org, soql) => {
      if (soql.includes('ApexClass')) return [{ Name: 'Foo', ApiVersion: 58 }];
      if (soql.includes('ApexTrigger')) return [];
      return [{ Definition: { DeveloperName: 'My_Flow' }, ApiVersion: 60 }];
    });
    const org = await fetchOrgApiVersions('dev');
    expect(org.ceiling).toBe(67);
    expect(org.release).toBe("Summer '26");
    expect(org.byType.ApexClass).toEqual([{ name: 'Foo', apiVersion: 58 }]);
    expect(org.byType.Flow).toEqual([{ name: 'My_Flow', apiVersion: 60 }]);
    expect(org.degraded).toEqual([]);
  });

  it('degrades per type — a Flow failure still returns Apex results', async () => {
    detectOrgRelease.mockResolvedValue(null);
    query.mockImplementation(async (org, soql) => {
      if (soql.includes('FROM Flow')) throw new Error('not supported');
      return [];
    });
    const org = await fetchOrgApiVersions('dev');
    expect(org.ceiling).toBeNull();
    expect(org.degraded).toEqual(['Flow']);
    expect(org.byType.ApexClass).toEqual([]);
  });
});

describe('buildReport', () => {
  const local = {
    sourceApiVersion: '66.0',
    components: [
      { type: 'ApexClass', name: 'Ancient', apiVersion: 30, file: 'x' },
      { type: 'ApexClass', name: 'Lagging', apiVersion: 58, file: 'y' },
      { type: 'ApexClass', name: 'Fresh', apiVersion: 66, file: 'z' },
      { type: 'Flow', name: 'NoVer', apiVersion: null, file: 'w' },
    ],
  };

  it('offline mode: floor-only classification, org is null', () => {
    const r = buildReport(local, null, { minApiVersion: 45, warnBehind: 5 });
    expect(r.org).toBeNull();
    // no ceiling → warnBehind cannot raise the floor
    expect(r.thresholds.effectiveFloor).toBe(45);
    expect(r.local.outliers).toEqual([
      expect.objectContaining({ name: 'Ancient', reason: 'below-floor' }),
    ]);
    expect(r.local.byType.ApexClass.histogram).toEqual([
      { version: '30', count: 1 },
      { version: '58', count: 1 },
      { version: '66', count: 1 },
    ]);
    expect(r.local.byType.Flow.histogram).toEqual([{ version: 'unspecified', count: 1 }]);
  });

  it('org mode: warnBehind raises the floor and tags behind-ceiling', () => {
    const org = { ceiling: 67, release: "Summer '26", preview: false, byType: { ApexClass: [{ name: 'OrgOld', apiVersion: 40 }] }, degraded: [] };
    const r = buildReport(local, org, { minApiVersion: 45, warnBehind: 5 });
    expect(r.thresholds.effectiveFloor).toBe(62);
    expect(r.local.outliers.map((o) => [o.name, o.reason])).toEqual([
      ['Ancient', 'below-floor'],
      ['Lagging', 'behind-ceiling'],
    ]);
    expect(r.org.outliers).toEqual([
      expect.objectContaining({ name: 'OrgOld', reason: 'below-floor' }),
    ]);
  });
});
