import { describe, it, expect } from 'vitest';
import {
  renderSummary,
  parsePreflightChecks,
  parseQualityOutput,
  nativeSpecFor,
  NATIVE_COMMANDS,
} from '../src/lib/render-summary.js';
import type { SfdtJsonRun } from '../src/lib/run-json.js';
import { flattenCommands } from '../src/lib/commands.js';

function okRun(result: unknown, extra: Partial<SfdtJsonRun> = {}): SfdtJsonRun {
  return { ok: true, status: 0, result, warnings: [], raw: '', noEnvelope: false, timedOut: false, ...extra };
}

function failRun(error: string, extra: Partial<SfdtJsonRun> = {}): SfdtJsonRun {
  return {
    ok: false,
    status: 1,
    result: null,
    warnings: [],
    raw: 'some raw output\nlast line',
    error,
    noEnvelope: false,
    timedOut: false,
    ...extra,
  };
}

/** Snapshot shape produced by audit-runner/monitor-runner. */
const auditSnapshot = {
  timestamp: '2026-07-04T10:00:00.000Z',
  org: 'devhub',
  checks: [
    {
      id: 'mfa',
      title: 'MFA Coverage',
      status: 'fail',
      summary: '4 users without MFA',
      findings: [
        { username: 'a@x.com' },
        { username: 'b@x.com' },
        { username: 'c@x.com' },
        { username: 'd@x.com' },
        { username: 'e@x.com' },
        { username: 'f@x.com' },
      ],
    },
    { id: 'licenses', title: 'License Usage', status: 'warn', summary: '1 license near limit', findings: [] },
    { id: 'audittrail', title: 'Setup Audit Trail', status: 'ok', summary: 'no suspicious activity', findings: [] },
  ],
  summary: { total: 3, ok: 1, warn: 1, fail: 1, error: 0 },
};

describe('renderSummary — audit/monitor snapshots', () => {
  it('renders counts, issue checks, and top findings', () => {
    const s = renderSummary('audit', okRun(auditSnapshot));
    expect(s.title).toBe('Org Audit — devhub');
    expect(s.severity).toBe('error');
    expect(s.headline).toContain('1 fail');
    expect(s.headline).toContain('devhub');
    expect(s.markdown).toContain('**Checks:** 1 ok · 1 warn · 1 fail · 0 error');
    expect(s.markdown).toContain('### FAIL · MFA Coverage');
    expect(s.markdown).toContain('4 users without MFA');
    // Findings are capped at 5 with a "+n more" marker.
    expect(s.markdown).toContain('… +1 more');
    // Passing checks are listed compactly.
    expect(s.markdown).toContain('- Setup Audit Trail — no suspicious activity');
  });

  it('orders attention section worst-first (fail before warn)', () => {
    const s = renderSummary('audit', okRun(auditSnapshot));
    const failIdx = s.markdown.indexOf('FAIL · MFA Coverage');
    const warnIdx = s.markdown.indexOf('WARN · License Usage');
    expect(failIdx).toBeGreaterThan(-1);
    expect(warnIdx).toBeGreaterThan(failIdx);
  });

  it('is info severity with an all-clear headline when everything passes', () => {
    const clean = {
      ...auditSnapshot,
      checks: [auditSnapshot.checks[2]],
      summary: { total: 1, ok: 1, warn: 0, fail: 0, error: 0 },
    };
    const s = renderSummary('monitor', okRun(clean));
    expect(s.severity).toBe('info');
    expect(s.title).toBe('Org Monitor — devhub');
    expect(s.headline).toContain('all 1 checks passed');
  });

  it('is warn severity when only warnings exist', () => {
    const warnOnly = {
      ...auditSnapshot,
      checks: [auditSnapshot.checks[1]],
      summary: { total: 1, ok: 0, warn: 1, fail: 0, error: 0 },
    };
    expect(renderSummary('audit', okRun(warnOnly)).severity).toBe('warn');
  });

  it('falls back to a generic summary when the result is not a snapshot', () => {
    const s = renderSummary('audit', okRun({ unexpected: true }));
    expect(s.severity).toBe('info');
    expect(s.headline).toContain('completed');
  });
});

describe('renderSummary — coverage', () => {
  const coverage = {
    org: 'devhub',
    threshold: 75,
    orgWide: 68,
    belowThreshold: true,
    classes: [
      { name: 'GoodClass', covered: 95, uncovered: 5, total: 100, pct: 0.95 },
      { name: 'BadClass', covered: 10, uncovered: 90, total: 100, pct: 0.1 },
      { name: 'NoLines', covered: 0, uncovered: 0, total: 0, pct: null },
    ],
  };

  it('renders the org-wide figure, band counts, and worst classes', () => {
    const s = renderSummary('coverage', okRun(coverage));
    expect(s.severity).toBe('error');
    expect(s.headline).toContain('org-wide 68%');
    expect(s.headline).toContain('threshold 75%');
    expect(s.markdown).toContain('1 ≥90%');
    expect(s.markdown).toContain('- 10% — BadClass');
    expect(s.markdown).toContain('- no lines — NoLines');
    expect(s.markdown).not.toContain('GoodClass'); // green classes are not listed
  });

  it('is info severity when above threshold with healthy classes', () => {
    const healthy = {
      ...coverage,
      orgWide: 92,
      belowThreshold: false,
      classes: [{ name: 'GoodClass', covered: 95, uncovered: 5, total: 100, pct: 0.95 }],
    };
    expect(renderSummary('coverage', okRun(healthy)).severity).toBe('info');
  });
});

describe('renderSummary — quality', () => {
  const quality = {
    status: 'FAIL',
    summary: { critical: 1, high: 2, medium: 0, low: 0 },
    violations: [
      { file: 'classes/A.cls', line: 10, rule: 'ApexCRUDViolation', severity: 1, message: 'no CRUD check' },
      { file: 'classes/B.cls', line: 5, rule: 'AvoidSoqlInLoops', severity: 2, message: 'SOQL in loop' },
      { file: 'classes/C.cls', line: 1, rule: 'X', severity: 2, message: 'y' },
    ],
  };

  it('renders severity counts and top violations (worst first)', () => {
    const s = renderSummary('quality', okRun(quality));
    expect(s.severity).toBe('error');
    expect(s.headline).toContain('1 critical · 2 high');
    expect(s.markdown).toContain('[sev 1] classes/A.cls:10 — ApexCRUDViolation: no CRUD check');
    expect(s.markdown.indexOf('A.cls')).toBeLessThan(s.markdown.indexOf('B.cls'));
  });

  it('marks a skipped scan as warn, never a clean pass', () => {
    const skipped = {
      status: 'SKIPPED',
      summary: { critical: 0, high: 0, medium: 0, low: 0 },
      violations: [],
      unavailableMessage: 'scanner not installed',
    };
    const s = renderSummary('quality', okRun(skipped));
    expect(s.severity).toBe('warn');
    expect(s.headline).toContain('SKIPPED');
    expect(s.markdown).toContain('scanner not installed');
  });

  it('is info with no violations', () => {
    const clean = { status: 'PASS', summary: { critical: 0, high: 0, medium: 0, low: 0 }, violations: [] };
    const s = renderSummary('quality', okRun(clean));
    expect(s.severity).toBe('info');
    expect(s.headline).toContain('no violations');
  });

  it('renders violations parsed from raw scanner JSON when there is no envelope result', () => {
    const raw = [
      'Running Code Analyzer...',
      JSON.stringify({
        result: [
          {
            fileName: 'classes/A.cls',
            violations: [{ line: 10, ruleName: 'ApexCRUDViolation', severity: 1, message: 'no CRUD check' }],
          },
        ],
      }),
      'Code Analyzer completed.',
    ].join('\n');
    const s = renderSummary('quality', okRun(null, { raw, noEnvelope: true }));
    expect(s.severity).toBe('error');
    expect(s.headline).toContain('1 critical');
    expect(s.markdown).toContain('[sev 1] classes/A.cls:10 — ApexCRUDViolation: no CRUD check');
  });

  it('renders the CLI skip warning as SKIPPED (warn), never a clean pass', () => {
    const raw = 'Code Analyzer: static violation scan was SKIPPED — sf code-analyzer not installed. Install the scanner';
    const s = renderSummary('quality', okRun(null, { raw, noEnvelope: true }));
    expect(s.severity).toBe('warn');
    expect(s.headline).toContain('SKIPPED');
  });

  it('renders a pre-resolved quality result (e.g. from the quality snapshot) ahead of run output', () => {
    // Today's `sfdt quality` swallows the scanner output, so the caller
    // resolves violations from logs/quality-latest.json and passes them in.
    const s = renderSummary('quality', okRun(null, { raw: 'chrome only', noEnvelope: true }), { quality });
    expect(s.severity).toBe('error');
    expect(s.headline).toContain('1 critical · 2 high');
    expect(s.markdown).toContain('[sev 1] classes/A.cls:10 — ApexCRUDViolation: no CRUD check');
  });

  it('is inconclusive (warn, no success claim) when no source yields scan data', () => {
    // A real violations run prints only progress chrome — the outcome is
    // unknown, so it must never toast as an info-level clean success.
    const s = renderSummary('quality', okRun(null, { raw: 'Quality Analysis\nall done', noEnvelope: true }));
    expect(s.severity).toBe('warn');
    expect(s.headline).toContain('no scan results were captured');
    expect(s.headline).not.toContain('completed successfully');
    expect(s.markdown).toContain('inconclusive');
  });
});

describe('parseQualityOutput', () => {
  it('parses the sf scanner JSON envelope and counts severities', () => {
    const out = [
      'noise',
      JSON.stringify({
        result: [
          {
            fileName: 'classes/A.cls',
            violations: [
              { line: 1, ruleName: 'R1', severity: 1, message: 'm1' },
              { line: 2, rule: 'R2', severity: 3, message: 'm2' },
            ],
          },
        ],
      }),
    ].join('\n');
    const r = parseQualityOutput(out);
    expect(r).not.toBeNull();
    expect(r?.status).toBe('FAIL');
    expect(r?.summary).toEqual({ critical: 1, high: 0, medium: 1, low: 0 });
    expect(r?.violations).toHaveLength(2);
    expect(r?.violations?.[0]).toEqual({ file: 'classes/A.cls', line: 1, rule: 'R1', severity: 1, message: 'm1' });
  });

  it('parses a bare file array and reports PASS when violation-free', () => {
    const out = JSON.stringify([{ fileName: 'classes/B.cls', violations: [] }]);
    const r = parseQualityOutput(out);
    expect(r?.status).toBe('PASS');
    expect(r?.violations).toEqual([]);
  });

  it('maps the code-analyzer.sh skipped marker to SKIPPED with the reason', () => {
    const out = '{"status":"skipped","reason":"sf code-analyzer not installed","result":[],"_sfdt_unavailable":"sf scanner plugin not installed."}';
    const r = parseQualityOutput(out);
    expect(r?.status).toBe('SKIPPED');
    expect(r?.unavailableMessage).toBe('sf code-analyzer not installed');
  });

  it('detects the CLI skip warning line even when chalk-colored', () => {
    const out = '\u001b[33mCode Analyzer: static violation scan was SKIPPED — scanner missing.\u001b[39m';
    const r = parseQualityOutput(out);
    expect(r?.status).toBe('SKIPPED');
    expect(r?.unavailableMessage).toBe('scanner missing.');
  });

  it('returns null (never a fabricated PASS) when no marker is present', () => {
    expect(parseQualityOutput('Quality Analysis\nOverall quality: GOOD')).toBeNull();
    expect(parseQualityOutput('{"status":0,"result":{"unrelated":true}}')).toBeNull();
  });
});

describe('parsePreflightChecks', () => {
  it('parses SFDT_LOG:check marker lines and keeps colons in the detail', () => {
    const out = [
      'some banner',
      'SFDT_LOG:check:Git working directory is clean:PASS:',
      'SFDT_LOG:check:CHANGELOG.md:WARN:no unreleased content: see docs',
      'SFDT_LOG:component:Foo:ApexClass:changed', // not a check
      'noise',
    ].join('\n');
    expect(parsePreflightChecks(out)).toEqual([
      { name: 'Git working directory is clean', status: 'PASS', message: '' },
      { name: 'CHANGELOG.md', status: 'WARN', message: 'no unreleased content: see docs' },
    ]);
  });

  it('returns an empty list for output without markers', () => {
    expect(parsePreflightChecks('nothing here')).toEqual([]);
  });
});

describe('renderSummary — preflight', () => {
  const markers = [
    'SFDT_LOG:check:Git clean:PASS:',
    'SFDT_LOG:check:Branch naming:WARN:feature/x does not match',
    'SFDT_LOG:check:Apex tests:FAIL:coverage 60% below 75%',
  ].join('\n');

  it('renders check sections even when the run failed (non-zero exit)', () => {
    const s = renderSummary('preflight', failRun('exit 1', { raw: markers, noEnvelope: true }));
    expect(s.severity).toBe('error');
    expect(s.headline).toContain('failed');
    expect(s.headline).toContain('1 pass · 1 warn · 1 fail');
    expect(s.markdown).toContain('## Failed');
    expect(s.markdown).toContain('- Apex tests — coverage 60% below 75%');
    expect(s.markdown).toContain('## Warnings');
    expect(s.markdown).toContain('## Passed');
  });

  it('is warn when checks pass with warnings', () => {
    const raw = 'SFDT_LOG:check:Git clean:PASS:\nSFDT_LOG:check:Branch naming:WARN:odd branch';
    const s = renderSummary('preflight', okRun(null, { raw, noEnvelope: true }));
    expect(s.severity).toBe('warn');
    expect(s.headline).toContain('passed');
  });

  it('is info when every check passes', () => {
    const raw = 'SFDT_LOG:check:Git clean:PASS:';
    const s = renderSummary('preflight', okRun(null, { raw, noEnvelope: true }));
    expect(s.severity).toBe('info');
  });

  it('falls back to the failure renderer when no markers were captured', () => {
    const s = renderSummary('preflight', failRun('sfdt exited with code 1'));
    expect(s.severity).toBe('error');
    expect(s.headline).toContain('sfdt exited with code 1');
  });
});

describe('renderSummary — failures and generic', () => {
  it('renders CLI failures with the error and a fenced raw tail', () => {
    const s = renderSummary('audit', failRun('No org specified'));
    expect(s.severity).toBe('error');
    expect(s.title).toBe('Org Audit failed');
    expect(s.headline).toContain('No org specified');
    expect(s.markdown).toContain('```');
    expect(s.markdown).toContain('last line');
  });

  it('renders timeouts through the failure path', () => {
    const s = renderSummary('monitor', failRun('sfdt timed out before completing', { timedOut: true }));
    expect(s.headline).toContain('timed out');
  });

  it('renders a generic success with warnings elevated to warn severity', () => {
    const s = renderSummary('generic', okRun(null, { warnings: ['heads up'], raw: 'done' }), {
      label: 'My Command',
    });
    expect(s.severity).toBe('warn');
    expect(s.headline).toBe('My Command completed');
    expect(s.markdown).toContain('- heads up');
  });
});

describe('NATIVE_COMMANDS', () => {
  it('covers the dedicated shortcuts and matches CLI capabilities', () => {
    expect(NATIVE_COMMANDS.audit).toEqual({ kind: 'audit', json: true, org: true });
    expect(NATIVE_COMMANDS.monitor).toEqual({ kind: 'monitor', json: true, org: true });
    expect(NATIVE_COMMANDS.coverage).toEqual({ kind: 'coverage', json: true, org: true });
    // preflight and quality support neither --json nor --org today — passing
    // them would make Commander reject the invocation.
    expect(NATIVE_COMMANDS.preflight).toEqual({ kind: 'preflight', json: false, org: false });
    expect(NATIVE_COMMANDS.quality).toEqual({ kind: 'quality', json: false, org: false });
    // Interactive commands must NOT be routed natively.
    expect(NATIVE_COMMANDS.deploy).toBeUndefined();
    expect(NATIVE_COMMANDS.init).toBeUndefined();
  });
});

describe('nativeSpecFor', () => {
  it('matches the parent shortcuts by id', () => {
    expect(nativeSpecFor({ id: 'audit', args: ['audit', 'all'] })?.kind).toBe('audit');
    expect(nativeSpecFor({ id: 'monitor', args: ['monitor', 'all'] })?.kind).toBe('monitor');
    expect(nativeSpecFor({ id: 'preflight', args: ['preflight'] })?.kind).toBe('preflight');
    expect(nativeSpecFor({ id: 'coverage', args: ['coverage'] })?.kind).toBe('coverage');
    expect(nativeSpecFor({ id: 'quality', args: ['quality'] })?.kind).toBe('quality');
  });

  it('routes audit/monitor subcommand entries (tree leaves) via args[0]', () => {
    expect(nativeSpecFor({ id: 'audit-mfa', args: ['audit', 'mfa'] })?.kind).toBe('audit');
    expect(nativeSpecFor({ id: 'audit-all', args: ['audit', 'all'] })?.kind).toBe('audit');
    expect(nativeSpecFor({ id: 'monitor-limits', args: ['monitor', 'limits'] })?.kind).toBe('monitor');
  });

  it('keeps the terminal for interactive, destructive, and non-CLI entries', () => {
    expect(nativeSpecFor({ id: 'deploy', args: ['deploy'], destructive: true })).toBeUndefined();
    expect(nativeSpecFor({ id: 'deploy-smart', args: ['deploy', '--smart', '--dry-run'] })).toBeUndefined();
    // `monitor backup` is destructive — never run it silently in the background.
    expect(nativeSpecFor({ id: 'backup', args: ['monitor', 'backup'], destructive: true })).toBeUndefined();
    expect(nativeSpecFor({ id: 'dashboard' })).toBeUndefined();
    expect(nativeSpecFor({ id: 'init', args: ['init'] })).toBeUndefined();
  });

  it('resolves every audit/monitor/quality/coverage/preflight catalog leaf natively and no destructive one', () => {
    const kindByRoot: Record<string, string> = {
      audit: 'audit',
      monitor: 'monitor',
      quality: 'quality',
      coverage: 'coverage',
      preflight: 'preflight',
    };
    for (const entry of flattenCommands()) {
      const spec = nativeSpecFor(entry);
      const root = entry.args?.[0];
      if (entry.destructive || !root) {
        expect(spec, entry.id).toBeUndefined();
      } else if (kindByRoot[root]) {
        expect(spec?.kind, entry.id).toBe(kindByRoot[root]);
      }
    }
  });
});
