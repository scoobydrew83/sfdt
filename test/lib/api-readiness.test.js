import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs-extra';
import {
  sanitizeApexSource,
  analyzeApexSource,
  summarizeFindings,
  shouldFailBuild,
  scanApexReadiness,
  API_V67,
} from '../../src/lib/api-readiness.js';

describe('sanitizeApexSource', () => {
  it('preserves line count exactly', () => {
    const src = "public class A {\n  // comment\n  String s = 'x';\n}\n";
    const sanitized = sanitizeApexSource(src);
    expect(sanitized.split('\n').length).toBe(src.split('\n').length);
  });

  it('strips single-quoted string contents including escaped quotes', () => {
    const sanitized = sanitizeApexSource("String s = 'it\\'s WITH SECURITY_ENFORCED'; Integer i = 1;");
    expect(sanitized).not.toContain('SECURITY_ENFORCED');
    expect(sanitized).toContain('Integer i = 1;');
  });

  it('strips // line comments but keeps code before them', () => {
    const sanitized = sanitizeApexSource('Integer i = 1; // WITH SECURITY_ENFORCED');
    expect(sanitized).toContain('Integer i = 1;');
    expect(sanitized).not.toContain('SECURITY_ENFORCED');
  });

  it("strips '''...''' multiline string blocks across lines", () => {
    const src = "String q = '''\n  SELECT Id FROM Account\n  WITH SECURITY_ENFORCED\n''';\nInteger i = 2;";
    const sanitized = sanitizeApexSource(src);
    expect(sanitized).not.toContain('SECURITY_ENFORCED');
    expect(sanitized).toContain('Integer i = 2;');
    expect(sanitized.split('\n').length).toBe(src.split('\n').length);
  });

  it('strips block comments spanning multiple lines', () => {
    const src = '/*\n  [SELECT Id FROM Case WITH SECURITY_ENFORCED]\n*/\nInteger i = 3;';
    const sanitized = sanitizeApexSource(src);
    expect(sanitized).not.toContain('SECURITY_ENFORCED');
    expect(sanitized).toContain('Integer i = 3;');
  });
});

describe('analyzeApexSource — security-enforced', () => {
  it('flags WITH SECURITY_ENFORCED with file, line, and snippet', () => {
    const src = [
      'public with sharing class Svc {',
      '  List<Account> fetch() {',
      '    return [SELECT Id FROM Account WITH SECURITY_ENFORCED];',
      '  }',
      '}',
    ].join('\n');
    const findings = analyzeApexSource(src, 'classes/Svc.cls');
    const se = findings.filter((f) => f.type === 'security-enforced');
    expect(se).toHaveLength(1);
    expect(se[0]).toMatchObject({
      file: 'classes/Svc.cls',
      line: 3,
      severity: 'error',
    });
    expect(se[0].snippet).toContain('WITH SECURITY_ENFORCED');
  });

  it('is case-insensitive and tolerates extra whitespace', () => {
    const src = 'public with sharing class A { Object o = [SELECT Id FROM Case with   Security_Enforced]; }';
    const findings = analyzeApexSource(src, 'A.cls');
    expect(findings.filter((f) => f.type === 'security-enforced')).toHaveLength(1);
  });

  it('does not flag usage inside // comments', () => {
    const src = [
      'public with sharing class A {',
      '  // return [SELECT Id FROM Account WITH SECURITY_ENFORCED];',
      '}',
    ].join('\n');
    expect(analyzeApexSource(src, 'A.cls')).toHaveLength(0);
  });

  it('does not flag usage inside block comments', () => {
    const src = [
      'public with sharing class A {',
      '  /*',
      '   * [SELECT Id FROM Account WITH SECURITY_ENFORCED]',
      '   */',
      '}',
    ].join('\n');
    expect(analyzeApexSource(src, 'A.cls')).toHaveLength(0);
  });

  it("does not flag usage inside '''...''' multiline strings", () => {
    const src = [
      'public with sharing class A {',
      "  String q = '''",
      '    SELECT Id FROM Account WITH SECURITY_ENFORCED',
      "  ''';",
      '}',
    ].join('\n');
    expect(analyzeApexSource(src, 'A.cls')).toHaveLength(0);
  });

  it('does not flag usage inside single-quoted string literals (dynamic SOQL limitation)', () => {
    const src =
      "public with sharing class A { Object o = Database.query('SELECT Id FROM Account WITH SECURITY_ENFORCED'); }";
    const findings = analyzeApexSource(src, 'A.cls');
    expect(findings.filter((f) => f.type === 'security-enforced')).toHaveLength(0);
  });

  it('flags occurrences in trigger files too', () => {
    const src = 'trigger AccTrig on Account (before insert) {\n  List<Case> c = [SELECT Id FROM Case WITH SECURITY_ENFORCED];\n}';
    const findings = analyzeApexSource(src, 'triggers/AccTrig.trigger');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ type: 'security-enforced', line: 2 });
  });
});

describe('analyzeApexSource — missing-sharing', () => {
  it('warns for a top-level class with no sharing keyword', () => {
    const src = 'public class Plain {\n  Integer i = 1;\n}';
    const findings = analyzeApexSource(src, 'Plain.cls');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      type: 'missing-sharing',
      line: 1,
      severity: 'warn',
    });
  });

  it.each(['with sharing', 'without sharing', 'inherited sharing'])(
    'does not warn when "%s" is declared',
    (kw) => {
      const src = `public ${kw} class Declared {\n}`;
      const findings = analyzeApexSource(src, 'Declared.cls');
      expect(findings.filter((f) => f.type === 'missing-sharing')).toHaveLength(0);
    },
  );

  it('handles modifiers on a separate line from the class keyword', () => {
    const src = 'public with sharing\nclass Split {\n}';
    const findings = analyzeApexSource(src, 'Split.cls');
    expect(findings.filter((f) => f.type === 'missing-sharing')).toHaveLength(0);
  });

  it('ignores a sharing keyword that only appears in a comment', () => {
    const src = '// without sharing on purpose? no:\npublic class Sneaky {\n}';
    const findings = analyzeApexSource(src, 'Sneaky.cls');
    expect(findings.filter((f) => f.type === 'missing-sharing')).toHaveLength(1);
    expect(findings[0].line).toBe(2);
  });

  it('excludes @IsTest classes', () => {
    const src = '@IsTest\nprivate class MyServiceTest {\n}';
    expect(analyzeApexSource(src, 'MyServiceTest.cls')).toHaveLength(0);
  });

  it('excludes @isTest (any casing) with parameters', () => {
    const src = '@isTest(SeeAllData=false)\nprivate class OtherTest {\n}';
    expect(analyzeApexSource(src, 'OtherTest.cls')).toHaveLength(0);
  });

  it('does not warn for interfaces or enums', () => {
    expect(analyzeApexSource('public interface Api {\n}', 'Api.cls')).toHaveLength(0);
    expect(analyzeApexSource('public enum Status { OPEN, CLOSED }', 'Status.cls')).toHaveLength(0);
  });

  it('does not apply sharing checks to trigger files', () => {
    const src = 'trigger T on Account (before insert) {\n}';
    expect(analyzeApexSource(src, 'T.trigger')).toHaveLength(0);
  });

  it('only inspects the first (top-level) class declaration', () => {
    const src = [
      'public with sharing class Outer {',
      '  public class Inner {', // nested, no sharing keyword — must not warn
      '  }',
      '}',
    ].join('\n');
    expect(analyzeApexSource(src, 'Outer.cls')).toHaveLength(0);
  });
});

describe('analyzeApexSource — system-mode-dml', () => {
  it('flags a without-sharing class containing SOQL as info', () => {
    const src = [
      'public without sharing class Sys {',
      '  List<Account> all() { return [SELECT Id FROM Account]; }',
      '}',
    ].join('\n');
    const findings = analyzeApexSource(src, 'Sys.cls');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ type: 'system-mode-dml', severity: 'info', line: 1 });
  });

  it('flags a without-sharing class containing DML statements', () => {
    const src = 'public without sharing class Dml {\n  void go(Account a) { update a; }\n}';
    const findings = analyzeApexSource(src, 'Dml.cls');
    expect(findings.filter((f) => f.type === 'system-mode-dml')).toHaveLength(1);
  });

  it('flags a without-sharing class using Database.* methods', () => {
    const src = "public without sharing class Db {\n  void go() { Database.query('SELECT Id FROM Account'); }\n}";
    const findings = analyzeApexSource(src, 'Db.cls');
    expect(findings.filter((f) => f.type === 'system-mode-dml')).toHaveLength(1);
  });

  it('does not flag a without-sharing class with no SOQL/DML', () => {
    const src = 'public without sharing class Pure {\n  Integer add(Integer a, Integer b) { return a + b; }\n}';
    expect(analyzeApexSource(src, 'Pure.cls')).toHaveLength(0);
  });

  it('does not treat method calls like foo.update() as DML', () => {
    const src = 'public without sharing class NotDml {\n  void go(MyWrapper w) { w.update(1); }\n}';
    expect(analyzeApexSource(src, 'NotDml.cls')).toHaveLength(0);
  });
});

describe('summarizeFindings / shouldFailBuild', () => {
  it('tallies by severity', () => {
    const summary = summarizeFindings([
      { severity: 'error' },
      { severity: 'error' },
      { severity: 'warn' },
      { severity: 'info' },
    ]);
    expect(summary).toEqual({ errors: 2, warnings: 1, info: 1 });
  });

  it('fails only when errors exist AND apiVersion >= 67', () => {
    expect(shouldFailBuild({ apiVersion: 67, summary: { errors: 1 } })).toBe(true);
    expect(shouldFailBuild({ apiVersion: 68.0, summary: { errors: 3 } })).toBe(true);
    expect(shouldFailBuild({ apiVersion: 66, summary: { errors: 1 } })).toBe(false);
    expect(shouldFailBuild({ apiVersion: null, summary: { errors: 1 } })).toBe(false);
    expect(shouldFailBuild({ apiVersion: 67, summary: { errors: 0 } })).toBe(false);
  });

  it('exports the v67 threshold constant', () => {
    expect(API_V67).toBe(67);
  });
});

describe('scanApexReadiness', () => {
  let tmpRoot;

  beforeAll(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sfdt-api67-'));
    const clsDir = path.join(tmpRoot, 'force-app', 'main', 'default', 'classes');
    const trgDir = path.join(tmpRoot, 'pkg-b', 'main', 'default', 'triggers');
    await fs.ensureDir(clsDir);
    await fs.ensureDir(trgDir);
    await fs.writeFile(
      path.join(clsDir, 'Svc.cls'),
      'public with sharing class Svc {\n  Object o = [SELECT Id FROM Account WITH SECURITY_ENFORCED];\n}\n',
    );
    await fs.writeFile(path.join(clsDir, 'Plain.cls'), 'public class Plain {\n}\n');
    await fs.writeFile(
      path.join(trgDir, 'T.trigger'),
      'trigger T on Account (before insert) {\n  Object o = [SELECT Id FROM Case WITH SECURITY_ENFORCED];\n}\n',
    );
    // Non-Apex file must be ignored.
    await fs.writeFile(path.join(clsDir, 'Svc.cls-meta.xml'), '<ApexClass/>');
  });

  afterAll(async () => {
    await fs.remove(tmpRoot);
  });

  it('scans all packageDirectories and aggregates findings with relative paths', async () => {
    const config = {
      _projectRoot: tmpRoot,
      sourceApiVersion: '67.0',
      packageDirectories: [
        { path: 'force-app', absolutePath: path.join(tmpRoot, 'force-app') },
        { path: 'pkg-b', absolutePath: path.join(tmpRoot, 'pkg-b') },
      ],
    };
    const report = await scanApexReadiness(config);
    expect(report.apiVersion).toBe(67);
    expect(report.summary).toEqual({ errors: 2, warnings: 1, info: 0 });
    const files = report.findings.map((f) => f.file);
    expect(files).toContain(path.join('force-app', 'main', 'default', 'classes', 'Svc.cls'));
    expect(files).toContain(path.join('pkg-b', 'main', 'default', 'triggers', 'T.trigger'));
    expect(files.some((f) => f.endsWith('-meta.xml'))).toBe(false);
  });

  it('falls back to defaultSourcePath when packageDirectories is absent', async () => {
    const config = {
      _projectRoot: tmpRoot,
      defaultSourcePath: 'force-app/main/default',
    };
    const report = await scanApexReadiness(config);
    // Only the classes dir this time — the pkg-b trigger is out of scope.
    expect(report.summary).toEqual({ errors: 1, warnings: 1, info: 0 });
    expect(report.apiVersion).toBeNull();
  });

  it('returns an empty report when no source directories exist', async () => {
    const report = await scanApexReadiness({
      _projectRoot: path.join(tmpRoot, 'does-not-exist'),
      sourceApiVersion: '66.0',
    });
    expect(report.findings).toEqual([]);
    expect(report.summary).toEqual({ errors: 0, warnings: 0, info: 0 });
    expect(report.apiVersion).toBe(66);
  });
});
