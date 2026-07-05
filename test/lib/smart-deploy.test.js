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
    readdir: vi.fn().mockResolvedValue([]),
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
  selectAnnotatedTests,
  scanTestClassSources,
  checkTestForHints,
  runTestForHintsCheck,
  prepareSmartDeploy,
  RELEVANT_TESTS_BETA_API,
  RELEVANT_TESTS_GA_API,
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

  it('never emits RunRelevantTests for production while beta (no GA)', () => {
    const r = selectTestLevel({ ApexClass: ['Foo'] }, { isProd: true, useRelevantTests: true });
    expect(r.testLevel).toBe('RunLocalTests');
  });

  it('allows RunRelevantTests on production once GA is detected', () => {
    const r = selectTestLevel(
      { ApexClass: ['Foo'] },
      { isProd: true, useRelevantTests: true, relevantTestsGa: true },
    );
    expect(r.testLevel).toBe('RunRelevantTests');
    expect(r.reason).toContain('GA');
  });

  it('GA alone (no opt-in) keeps RunLocalTests on production', () => {
    const r = selectTestLevel({ ApexClass: ['Foo'] }, { isProd: true, relevantTestsGa: true });
    expect(r.testLevel).toBe('RunLocalTests');
  });

  it('GA + opt-in also overrides downgradeTestsOnNonProd=false', () => {
    const r = selectTestLevel(
      { ApexClass: ['Foo'] },
      { isProd: false, downgradeTestsOnNonProd: false, useRelevantTests: true, relevantTestsGa: true },
    );
    expect(r.testLevel).toBe('RunRelevantTests');
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

describe('selectAnnotatedTests', () => {
  it('selects tests whose testFor targets a component in the delta', () => {
    const sources = {
      FooCoverage: "@IsTest(testFor='ApexClass:Foo')\nprivate class FooCoverage {}",
      BarCoverage: "@IsTest(testFor='ApexClass:Bar')\nprivate class BarCoverage {}",
    };
    expect(selectAnnotatedTests({ ApexClass: ['Foo'] }, sources)).toEqual(['FooCoverage']);
  });

  it('parses comma/space-separated multi-target testFor values', () => {
    const sources = {
      MultiTest: "@IsTest(testFor='ApexClass:Foo, Flow:My_Flow  CustomObject:Acct__c')\nclass MultiTest {}",
    };
    expect(selectAnnotatedTests({ Flow: ['My_Flow'] }, sources)).toEqual(['MultiTest']);
    expect(selectAnnotatedTests({ CustomObject: ['Acct__c'] }, sources)).toEqual(['MultiTest']);
    expect(selectAnnotatedTests({ ApexClass: ['Other'] }, sources)).toEqual([]);
  });

  it('treats a bare (colon-free) target as an ApexClass name', () => {
    const sources = { LooseTest: '@IsTest(testFor="Foo")\nclass LooseTest {}' };
    expect(selectAnnotatedTests({ ApexClass: ['Foo'] }, sources)).toEqual(['LooseTest']);
  });

  it('always selects critical=true tests regardless of the delta', () => {
    const sources = {
      CriticalTest: '@IsTest(critical=true)\nprivate class CriticalTest {}',
      OtherTest: '@IsTest\nprivate class OtherTest {}',
    };
    expect(selectAnnotatedTests({ Layout: ['L'] }, sources)).toEqual(['CriticalTest']);
    expect(selectAnnotatedTests({}, sources)).toEqual(['CriticalTest']);
  });

  it('matches targets and annotation keywords case-insensitively', () => {
    const sources = {
      MixedTest: "@istest(TESTFOR='apexclass:foo')\nclass MixedTest {}",
      LoudTest: '@ISTEST(CRITICAL = TRUE)\nclass LoudTest {}',
    };
    expect(selectAnnotatedTests({ ApexClass: ['Foo'] }, sources)).toEqual(['LoudTest', 'MixedTest']);
  });

  it('handles method-level annotations, dedupes, and returns a sorted list', () => {
    const sources = {
      ZTest: [
        '@IsTest',
        'private class ZTest {',
        "  @IsTest(testFor='ApexClass:Foo')",
        '  static void a() {}',
        "  @IsTest(testFor='ApexClass:Foo', critical=true)",
        '  static void b() {}',
        '}',
      ].join('\n'),
      ATest: "@IsTest(critical=true)\nclass ATest {}",
    };
    expect(selectAnnotatedTests({ ApexClass: ['Foo'] }, sources)).toEqual(['ATest', 'ZTest']);
  });

  it('ignores malformed annotations and empty inputs without throwing', () => {
    const sources = {
      Broken: "@IsTest(testFor=)\nclass Broken {}",
      NoArgs: '@IsTest\nclass NoArgs {}',
      NotCritical: '@IsTest(critical=false)\nclass NotCritical {}',
    };
    expect(selectAnnotatedTests({ ApexClass: ['Foo'] }, sources)).toEqual([]);
    expect(selectAnnotatedTests(undefined, undefined)).toEqual([]);
  });
});

describe('scanTestClassSources', () => {
  const dirent = (name, dir = false) => ({ name, isDirectory: () => dir, isFile: () => !dir });

  it('collects @IsTest .cls sources from package directories, skipping non-test classes', async () => {
    fs.pathExists.mockResolvedValue(true);
    fs.readdir.mockImplementation(async (p) => {
      if (p === '/p/force-app/main/default') return [dirent('classes', true), dirent('.hidden', true)];
      if (p === '/p/force-app/main/default/classes')
        return [dirent('FooTest.cls', false), dirent('Helper.cls', false), dirent('Foo.trigger', false)];
      return [];
    });
    fs.readFile.mockImplementation(async (p) => {
      if (p.endsWith('FooTest.cls')) return '@IsTest\nprivate class FooTest {}';
      return 'public class Helper {}';
    });
    const sources = await scanTestClassSources('/p', config);
    expect(Object.keys(sources)).toEqual(['FooTest']);
    expect(sources.FooTest).toContain('@IsTest');
  });

  it('skips unreadable directories instead of throwing', async () => {
    fs.pathExists.mockResolvedValue(true);
    fs.readdir.mockRejectedValue(new Error('EACCES'));
    await expect(scanTestClassSources('/p', config)).resolves.toEqual({});
  });
});

describe('prepareSmartDeploy annotation-aware test selection', () => {
  const dirent = (name, dir = false) => ({ name, isDirectory: () => dir, isFile: () => !dir });

  const mockProject = (files) => {
    fs.mkdtemp.mockResolvedValue('/tmp/sfdt-smart-x');
    fs.writeFile.mockResolvedValue(undefined);
    fs.pathExists.mockResolvedValue(true);
    fs.readdir.mockImplementation(async (p) => {
      if (p === '/p/force-app/main/default') return [dirent('classes', true)];
      if (p === '/p/force-app/main/default/classes') return Object.keys(files).map((n) => dirent(n));
      return [];
    });
    fs.readFile.mockImplementation(async (p) => files[p.split('/').pop()] ?? '');
  };

  it('widens RunSpecifiedTests with testFor-matching and critical tests, deduped', async () => {
    diffNameStatus.mockResolvedValueOnce({
      exitCode: 0,
      stdout: [
        'A\tforce-app/main/default/classes/BarTest.cls',
        'A\tforce-app/main/default/objects/Acct__c/Acct__c.object-meta.xml',
      ].join('\n'),
      stderr: '',
    });
    mockProject({
      'BarTest.cls': '@IsTest\nprivate class BarTest {}',
      'AcctCoverageTest.cls': "@IsTest(testFor='CustomObject:Acct__c')\nprivate class AcctCoverageTest {}",
      'CriticalTest.cls': '@IsTest(critical=true)\nprivate class CriticalTest {}',
      'UnrelatedTest.cls': "@IsTest(testFor='ApexClass:Other')\nprivate class UnrelatedTest {}",
      'Helper.cls': 'public class Helper {}',
    });
    const prep = await prepareSmartDeploy({ base: 'main', projectRoot: '/p', config });
    expect(prep.testLevel).toBe('RunSpecifiedTests');
    expect(prep.tests).toEqual(['BarTest', 'AcctCoverageTest', 'CriticalTest']);
  });

  it('keeps the name-heuristic selection when the source scan fails', async () => {
    diffNameStatus.mockResolvedValueOnce({
      exitCode: 0,
      stdout: 'A\tforce-app/main/default/classes/BarTest.cls',
      stderr: '',
    });
    fs.mkdtemp.mockResolvedValue('/tmp/sfdt-smart-x');
    fs.writeFile.mockResolvedValue(undefined);
    fs.pathExists.mockRejectedValue(new Error('boom'));
    const prep = await prepareSmartDeploy({ base: 'main', projectRoot: '/p', config });
    expect(prep.testLevel).toBe('RunSpecifiedTests');
    expect(prep.tests).toEqual(['BarTest']);
  });

  it('does not scan sources when the test level is not RunSpecifiedTests', async () => {
    diffNameStatus.mockResolvedValueOnce({
      exitCode: 0,
      stdout: 'A\tforce-app/main/default/classes/Foo.cls',
      stderr: '',
    });
    fs.mkdtemp.mockResolvedValue('/tmp/sfdt-smart-x');
    fs.writeFile.mockResolvedValue(undefined);
    fs.pathExists.mockResolvedValue(false);
    const prep = await prepareSmartDeploy({ base: 'main', projectRoot: '/p', config });
    expect(prep.testLevel).toBe('RunLocalTests');
    expect(fs.readdir).not.toHaveBeenCalled();
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
