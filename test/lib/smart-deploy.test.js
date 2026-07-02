import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/git-utils.js', () => ({
  isSafeGitRef: vi.fn(() => true),
  resolveBaseRef: vi.fn(async (base) => base),
  diffNameStatus: vi.fn(),
}));

vi.mock('fs-extra', () => ({
  default: {
    mkdtemp: vi.fn().mockResolvedValue('/tmp/sfdt-smart-x'),
    writeFile: vi.fn().mockResolvedValue(undefined),
    pathExists: vi.fn().mockResolvedValue(false),
    readFile: vi.fn().mockResolvedValue(''),
    remove: vi.fn().mockResolvedValue(undefined),
  },
}));

import fs from 'fs-extra';
import { diffNameStatus, isSafeGitRef } from '../../src/lib/git-utils.js';
import {
  computeDelta,
  parseNoOverwrite,
  applyOverwriteRules,
  selectTestLevel,
  prepareSmartDeploy,
} from '../../src/lib/smart-deploy.js';

const config = { defaultSourcePath: 'force-app/main/default', packageDirectories: [{ path: 'force-app/main/default' }] };

beforeEach(() => {
  vi.resetAllMocks();
  isSafeGitRef.mockReturnValue(true);
});

describe('computeDelta', () => {
  it('parses additive and destructive members from the diff', async () => {
    diffNameStatus.mockResolvedValueOnce({
      exitCode: 0,
      stdout: [
        'A\tforce-app/main/default/classes/Foo.cls',
        'D\tforce-app/main/default/classes/Bar.cls',
      ].join('\n'),
      stderr: '',
    });
    const { addCount, delCount, additive, destructive } = await computeDelta({ base: 'main', projectRoot: '/p', config });
    expect(addCount).toBe(1);
    expect(delCount).toBe(1);
    expect(additive.ApexClass).toEqual(['Foo']);
    expect(destructive.ApexClass).toEqual(['Bar']);
  });

  it('throws on an unsafe git ref', async () => {
    isSafeGitRef.mockReturnValue(false);
    await expect(computeDelta({ base: '--evil', projectRoot: '/p', config })).rejects.toThrow('Invalid git ref');
  });

  it('throws when git diff fails', async () => {
    diffNameStatus.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'fatal' });
    await expect(computeDelta({ base: 'main', projectRoot: '/p', config })).rejects.toThrow('git diff failed');
  });
});

describe('parseNoOverwrite + applyOverwriteRules', () => {
  it('parses a package-no-overwrite.xml into a type→members map', () => {
    const xml = `<?xml version="1.0"?><Package>
      <types><members>Locked</members><members>AlsoLocked</members><name>ApexClass</name></types>
      <types><members>*</members><name>Profile</name></types>
    </Package>`;
    const map = parseNoOverwrite(xml);
    expect(map.ApexClass.has('Locked')).toBe(true);
    expect(map.Profile.has('*')).toBe(true);
  });

  it('removes protected members (and honours wildcard) from the additive map', () => {
    const additive = { ApexClass: ['Foo', 'Locked'], Profile: ['Admin'] };
    const noOverwrite = { ApexClass: new Set(['Locked']), Profile: new Set(['*']) };
    const { additive: filtered, removed } = applyOverwriteRules(additive, noOverwrite);
    expect(filtered.ApexClass).toEqual(['Foo']);
    expect(filtered.Profile).toBeUndefined();
    expect(removed).toEqual(expect.arrayContaining(['ApexClass:Locked', 'Profile:Admin']));
  });
});

describe('selectTestLevel', () => {
  it('returns RunLocalTests for production regardless of changes', () => {
    const r = selectTestLevel({ CustomObject: ['Acct__c'] }, { isProd: true });
    expect(r.testLevel).toBe('RunLocalTests');
  });

  it('returns NoTestRun when no impacting metadata changed (non-prod)', () => {
    const r = selectTestLevel({ CustomObject: ['Acct__c'], Layout: ['L'] }, { isProd: false });
    expect(r.testLevel).toBe('NoTestRun');
  });

  it('runs only the changed test classes when only Apex test classes changed', () => {
    const r = selectTestLevel({ ApexClass: ['FooTest', 'BarTest'] }, { isProd: false });
    expect(r.testLevel).toBe('RunSpecifiedTests');
    expect(r.tests).toEqual(['FooTest', 'BarTest']);
  });

  it('falls back to RunLocalTests when non-test Apex changed', () => {
    const r = selectTestLevel({ ApexClass: ['Foo', 'FooTest'] }, { isProd: false });
    expect(r.testLevel).toBe('RunLocalTests');
  });

  it('falls back to RunLocalTests when a Flow changed', () => {
    const r = selectTestLevel({ Flow: ['My_Flow'] }, { isProd: false });
    expect(r.testLevel).toBe('RunLocalTests');
  });

  it('respects downgradeTestsOnNonProd=false', () => {
    const r = selectTestLevel({ CustomObject: ['Acct__c'] }, { isProd: false, downgradeTestsOnNonProd: false });
    expect(r.testLevel).toBe('RunLocalTests');
  });

  it('emits RunRelevantTests instead of the RunLocalTests fallback when opted in (non-prod)', () => {
    const r = selectTestLevel({ ApexClass: ['Foo'] }, { isProd: false, useRelevantTests: true });
    expect(r.testLevel).toBe('RunRelevantTests');
    expect(r.tests).toEqual([]);
  });

  it('never emits RunRelevantTests for production', () => {
    const r = selectTestLevel({ ApexClass: ['Foo'] }, { isProd: true, useRelevantTests: true });
    expect(r.testLevel).toBe('RunLocalTests');
  });

  it('keeps the more-minimal branches when opted in', () => {
    expect(selectTestLevel({ Layout: ['L'] }, { isProd: false, useRelevantTests: true }).testLevel).toBe('NoTestRun');
    expect(
      selectTestLevel({ ApexClass: ['FooTest'] }, { isProd: false, useRelevantTests: true }).testLevel,
    ).toBe('RunSpecifiedTests');
  });
});

describe('prepareSmartDeploy useRelevantTests API gate', () => {
  const mockApexDiff = () => {
    diffNameStatus.mockResolvedValueOnce({
      exitCode: 0,
      stdout: 'A\tforce-app/main/default/classes/Foo.cls',
      stderr: '',
    });
    fs.mkdtemp.mockResolvedValue('/tmp/sfdt-smart-x');
    fs.pathExists.mockResolvedValue(false);
    fs.writeFile.mockResolvedValue(undefined);
  };

  it('activates RunRelevantTests when sourceApiVersion >= 66', async () => {
    mockApexDiff();
    const cfg = { ...config, sourceApiVersion: '66.0', deployment: { smart: { useRelevantTests: true } } };
    const prep = await prepareSmartDeploy({ base: 'main', projectRoot: '/p', config: cfg });
    expect(prep.testLevel).toBe('RunRelevantTests');
  });

  it('falls back to RunLocalTests when sourceApiVersion < 66', async () => {
    mockApexDiff();
    const cfg = { ...config, sourceApiVersion: '65.0', deployment: { smart: { useRelevantTests: true } } };
    const prep = await prepareSmartDeploy({ base: 'main', projectRoot: '/p', config: cfg });
    expect(prep.testLevel).toBe('RunLocalTests');
  });
});

describe('prepareSmartDeploy temp-dir cleanup', () => {
  it('removes the temp dir it created if a manifest write fails', async () => {
    diffNameStatus.mockResolvedValueOnce({
      exitCode: 0,
      stdout: 'A\tforce-app/main/default/classes/Foo.cls',
      stderr: '',
    });
    // beforeEach's resetAllMocks clears the module-level fs defaults — re-set them.
    fs.mkdtemp.mockResolvedValue('/tmp/sfdt-smart-x');
    fs.pathExists.mockResolvedValue(false);
    fs.remove.mockResolvedValue(undefined);
    fs.writeFile.mockRejectedValueOnce(new Error('disk full'));
    await expect(prepareSmartDeploy({ base: 'main', projectRoot: '/p', config })).rejects.toThrow('disk full');
    expect(fs.remove).toHaveBeenCalledWith('/tmp/sfdt-smart-x');
  });
});
