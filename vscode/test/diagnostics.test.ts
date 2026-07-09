import { describe, it, expect } from 'vitest';
import {
  severityFor,
  qualityFromRun,
  qualityFromSnapshot,
  qualityToDiagnostics,
  groupByFile,
  type DiagnosticEntry,
  type QualityLogEnvelope,
} from '../src/lib/diagnostics.js';
import type { QualityResult } from '../src/lib/render-summary.js';
import type { SfdtJsonRun } from '../src/lib/run-json.js';

const ROOT = '/work/my-sf-project';

function quality(violations: QualityResult['violations'], status = 'FAIL'): QualityResult {
  return { status, summary: { critical: 0, high: 0, medium: 0, low: 0 }, violations };
}

function run(extra: Partial<SfdtJsonRun> = {}): SfdtJsonRun {
  return { ok: true, status: 0, result: null, warnings: [], raw: '', noEnvelope: true, timedOut: false, ...extra };
}

describe('severityFor', () => {
  it('maps scanner severity 1 to error, 2 to warning, 3+ to info', () => {
    expect(severityFor(1)).toBe('error');
    expect(severityFor(2)).toBe('warning');
    expect(severityFor(3)).toBe('info');
    expect(severityFor(4)).toBe('info');
    expect(severityFor(5)).toBe('info');
  });

  it('treats a missing severity as info', () => {
    expect(severityFor(undefined)).toBe('info');
  });
});

describe('qualityToDiagnostics', () => {
  it('maps violations to entries with source/code and resolved paths', () => {
    const result = quality([
      { file: 'force-app/main/default/classes/Foo.cls', line: 12, rule: 'ApexCRUDViolation', severity: 1, message: 'CRUD check missing' },
      { file: 'force-app/main/default/classes/Bar.cls', line: 3, rule: 'EmptyCatchBlock', severity: 2, message: 'Empty catch' },
      { file: 'force-app/main/default/classes/Baz.cls', line: 7, rule: 'ExcessiveParameterList', severity: 3, message: 'Too many params' },
    ]);
    const entries = qualityToDiagnostics(result, ROOT);
    expect(entries).toEqual([
      {
        file: `${ROOT}/force-app/main/default/classes/Foo.cls`,
        line: 12,
        severity: 'error',
        message: 'CRUD check missing',
        source: 'sfdt',
        code: 'ApexCRUDViolation',
      },
      {
        file: `${ROOT}/force-app/main/default/classes/Bar.cls`,
        line: 3,
        severity: 'warning',
        message: 'Empty catch',
        source: 'sfdt',
        code: 'EmptyCatchBlock',
      },
      {
        file: `${ROOT}/force-app/main/default/classes/Baz.cls`,
        line: 7,
        severity: 'info',
        message: 'Too many params',
        source: 'sfdt',
        code: 'ExcessiveParameterList',
      },
    ]);
  });

  it('keeps absolute scanner paths as-is (normalized)', () => {
    const abs = `${ROOT}/force-app/main/default/classes/Abs.cls`;
    const entries = qualityToDiagnostics(
      quality([{ file: `${ROOT}/force-app/main/default/classes/../classes/Abs.cls`, line: 1, rule: 'R', severity: 2, message: 'm' }]),
      ROOT,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].file).toBe(abs);
  });

  it('skips violations without a usable file path', () => {
    const entries = qualityToDiagnostics(
      quality([
        { file: '', line: 1, rule: 'R', severity: 1, message: 'no file' },
        { file: '   ', line: 2, rule: 'R', severity: 1, message: 'blank file' },
        { line: 3, rule: 'R', severity: 1, message: 'missing file' },
        { file: 'classes/Ok.cls', line: 4, rule: 'R', severity: 1, message: 'kept' },
      ]),
      ROOT,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].message).toBe('kept');
  });

  it('skips relative paths when no workspace root is available', () => {
    const abs = '/elsewhere/classes/Abs.cls';
    const entries = qualityToDiagnostics(
      quality([
        { file: 'classes/Rel.cls', line: 1, rule: 'R', severity: 1, message: 'relative' },
        { file: abs, line: 2, rule: 'R', severity: 1, message: 'absolute' },
      ]),
      undefined,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].file).toBe(abs);
  });

  it('returns an empty list for a SKIPPED scan', () => {
    const skipped: QualityResult = {
      status: 'SKIPPED',
      summary: { critical: 0, high: 0, medium: 0, low: 0 },
      violations: [{ file: 'classes/Foo.cls', line: 1, rule: 'R', severity: 1, message: 'ignored' }],
      unavailableMessage: 'scanner not installed',
    };
    expect(qualityToDiagnostics(skipped, ROOT)).toEqual([]);
  });

  it('returns an empty list for null/undefined results and missing violations', () => {
    expect(qualityToDiagnostics(null, ROOT)).toEqual([]);
    expect(qualityToDiagnostics(undefined, ROOT)).toEqual([]);
    expect(qualityToDiagnostics({ status: 'PASS' } as QualityResult, ROOT)).toEqual([]);
  });

  it('clamps missing or bogus line numbers to 1', () => {
    const entries = qualityToDiagnostics(
      quality([
        { file: 'a.cls', rule: 'R', severity: 1, message: 'no line' },
        { file: 'b.cls', line: 0, rule: 'R', severity: 1, message: 'zero' },
        { file: 'c.cls', line: -4, rule: 'R', severity: 1, message: 'negative' },
        { file: 'd.cls', line: 2.7, rule: 'R', severity: 1, message: 'fractional' },
      ]),
      ROOT,
    );
    expect(entries.map((e) => e.line)).toEqual([1, 1, 1, 2]);
  });

  it('falls back to the rule name when the message is empty', () => {
    const entries = qualityToDiagnostics(
      quality([{ file: 'a.cls', line: 1, rule: 'ApexDoc', severity: 3, message: '' }]),
      ROOT,
    );
    expect(entries[0].message).toBe('ApexDoc');
    expect(entries[0].code).toBe('ApexDoc');
  });
});

/** logs/quality-latest.json envelope as written by src/lib/log-writer.js. */
function snapshotEnvelope(data: QualityResult, timestamp = '2026-07-04T10:00:00.000Z'): QualityLogEnvelope {
  return { schemaVersion: '1', type: 'quality', timestamp, data };
}

/**
 * What `sfdt quality` actually prints on a real violations run today: chalk
 * chrome only — the scanner JSON is captured internally by quality.js and
 * never re-emitted. There is nothing parseable here by design.
 */
const REAL_CLI_VIOLATIONS_RUN_STDOUT = [
  '\u001b[1mQuality Analysis\u001b[22m',
  'Running Code Analyzer...',
  '\u001b[32m✔ Code Analyzer completed.\u001b[39m',
].join('\n');

describe('qualityFromRun', () => {
  it('prefers a structured envelope result carrying violations', () => {
    const result = quality([{ file: 'a.cls', line: 1, rule: 'R', severity: 1, message: 'm' }]);
    expect(qualityFromRun(run({ result, noEnvelope: false }))).toBe(result);
  });

  it('returns null for a real violations run (chrome-only stdout) with no snapshot', () => {
    // The caller must then CLEAR previously published diagnostics — see
    // extension.ts runNative — never keep stale ones or fabricate a result.
    expect(qualityFromRun(run({ raw: REAL_CLI_VIOLATIONS_RUN_STDOUT }))).toBeNull();
  });

  it('parses the CLI skip warning the real CLI does print on stdout', () => {
    const raw = `${REAL_CLI_VIOLATIONS_RUN_STDOUT}\n\u001b[33mCode Analyzer: static violation scan was SKIPPED — sf code-analyzer not installed.\u001b[39m`;
    const parsed = qualityFromRun(run({ raw }));
    expect(parsed?.status).toBe('SKIPPED');
  });

  it('parses scanner JSON out of raw output when a CLI version surfaces it', () => {
    const raw = [
      'Running scanner…',
      JSON.stringify({ result: [{ fileName: 'classes/Foo.cls', violations: [{ line: 5, ruleName: 'EmptyCatchBlock', severity: 2, message: 'Empty catch' }] }] }),
    ].join('\n');
    const parsed = qualityFromRun(run({ raw }));
    expect(parsed?.status).toBe('FAIL');
    expect(parsed?.violations).toEqual([
      { file: 'classes/Foo.cls', line: 5, rule: 'EmptyCatchBlock', severity: 2, message: 'Empty catch' },
    ]);
  });

  it('falls back to a quality snapshot written during the run', () => {
    const data = quality([{ file: 'classes/Foo.cls', line: 5, rule: 'R', severity: 2, message: 'm' }]);
    const parsed = qualityFromRun(run({ raw: REAL_CLI_VIOLATIONS_RUN_STDOUT }), {
      snapshot: snapshotEnvelope(data, '2026-07-04T10:00:05.000Z'),
      since: '2026-07-04T10:00:00.000Z',
    });
    expect(parsed).toBe(data);
  });

  it('ignores a snapshot written before the run started (stale scan data)', () => {
    const data = quality([{ file: 'classes/Old.cls', line: 1, rule: 'R', severity: 1, message: 'old' }]);
    const parsed = qualityFromRun(run({ raw: REAL_CLI_VIOLATIONS_RUN_STDOUT }), {
      snapshot: snapshotEnvelope(data, '2026-07-03T10:00:00.000Z'),
      since: '2026-07-04T10:00:00.000Z',
    });
    expect(parsed).toBeNull();
  });

  it('returns null when no source has a quality shape', () => {
    expect(qualityFromRun(run({ raw: 'plain text output' }))).toBeNull();
  });
});

describe('qualityFromSnapshot', () => {
  const data = quality([{ file: 'classes/Foo.cls', line: 5, rule: 'R', severity: 2, message: 'm' }]);

  it('accepts a quality envelope and returns its data payload', () => {
    expect(qualityFromSnapshot(snapshotEnvelope(data))).toBe(data);
  });

  it('accepts any timestamp when no since gate is given', () => {
    expect(qualityFromSnapshot(snapshotEnvelope(data, '2020-01-01T00:00:00.000Z'))).toBe(data);
  });

  it('rejects envelopes of another type, malformed payloads, and non-objects', () => {
    expect(qualityFromSnapshot({ ...snapshotEnvelope(data), type: 'preflight' })).toBeNull();
    expect(qualityFromSnapshot({ schemaVersion: '1', type: 'quality', data: { status: 'PASS' } })).toBeNull();
    expect(qualityFromSnapshot(null)).toBeNull();
    expect(qualityFromSnapshot('garbage')).toBeNull();
    expect(qualityFromSnapshot([snapshotEnvelope(data)])).toBeNull();
  });

  it('rejects a stale or untimestamped envelope when since is given', () => {
    expect(
      qualityFromSnapshot(snapshotEnvelope(data, '2026-07-04T09:59:59.000Z'), { since: '2026-07-04T10:00:00.000Z' }),
    ).toBeNull();
    expect(
      qualityFromSnapshot({ schemaVersion: '1', type: 'quality', data }, { since: '2026-07-04T10:00:00.000Z' }),
    ).toBeNull();
  });

  it('accepts an envelope written at or after since', () => {
    expect(
      qualityFromSnapshot(snapshotEnvelope(data, '2026-07-04T10:00:00.000Z'), { since: '2026-07-04T10:00:00.000Z' }),
    ).toBe(data);
  });
});

describe('groupByFile', () => {
  it('buckets entries per absolute path, preserving order', () => {
    const a1: DiagnosticEntry = { file: '/r/a.cls', line: 1, severity: 'error', message: '1', source: 'sfdt', code: 'R' };
    const b1: DiagnosticEntry = { file: '/r/b.cls', line: 2, severity: 'info', message: '2', source: 'sfdt', code: 'R' };
    const a2: DiagnosticEntry = { file: '/r/a.cls', line: 3, severity: 'warning', message: '3', source: 'sfdt', code: 'R' };
    const grouped = groupByFile([a1, b1, a2]);
    expect([...grouped.keys()]).toEqual(['/r/a.cls', '/r/b.cls']);
    expect(grouped.get('/r/a.cls')).toEqual([a1, a2]);
    expect(grouped.get('/r/b.cls')).toEqual([b1]);
  });

  it('returns an empty map for no entries', () => {
    expect(groupByFile([]).size).toBe(0);
  });
});
