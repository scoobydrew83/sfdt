/**
 * Test-run history for the Status view's "Test Runs" section.
 *
 * The sfdt CLI persists Apex test runs as JSON files under
 * `logs/test-results/` in three shapes (the same set the GUI's
 * `src/lib/gui-server/parsers.js readTestRuns` handles — that parser is the
 * authoritative reference and this module mirrors its rules without importing
 * it):
 *
 *  1. the structured log envelope written by `src/lib/log-writer.js`
 *     (`{ schemaVersion: '1', type: 'test-run', timestamp, durationMs, org,
 *     data: { passed, failed, errors, coverage, … } }`),
 *  2. a raw `sf apex run test --json` capture (`{ result: { summary } }` or a
 *     bare `{ summary }`), and
 *  3. a bare array of per-test rows (`[{ outcome, testTimestamp, … }]`).
 *
 * Deliberately free of any `vscode` import so it is unit-testable in
 * isolation; the extension wires the resulting TreeNodes into the Status tree.
 */

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { readJsonIfExists, logsDir } from './io.js';
import type { CheckStatus, TreeNode } from './snapshots.js';

/** One shaped test run (superset of the GUI's run rows — adds `org`). */
export interface TestRunSummary {
  /** Source filename inside logs/test-results/ (also its stable identity). */
  file: string;
  /** ISO-ish timestamp when known; falls back to the filename. */
  date?: string;
  passed: number;
  failed: number;
  errors: number;
  skipped?: number;
  /** Test-run coverage percent (0–100) when the run captured it. */
  coverage?: number;
  /** Run duration in milliseconds when known. */
  duration?: number;
  /** Org alias the run targeted (only the schemaVersion-1 envelope has it). */
  org?: string;
}

/**
 * Whether a directory entry is a readable run file. Mirrors the GUI filter:
 * `latest.json` is a duplicate of the newest archive, and `batch_*`/`local_*`
 * files are intermediate artifacts of the parallel test runner.
 */
export function isTestRunFile(name: string): boolean {
  return (
    name.endsWith('.json') && name !== 'latest.json' && !name.startsWith('batch_') && !name.startsWith('local_')
  );
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Shape an `sf apex run test` summary object into a run row. */
function fromSfSummary(file: string, s: Record<string, unknown>, timestamp?: unknown): TestRunSummary {
  const coverage =
    typeof s.testRunCoverage === 'string' || typeof s.testRunCoverage === 'number'
      ? parseFloat(String(s.testRunCoverage))
      : NaN;
  return {
    file,
    date:
      (typeof s.testStartTime === 'string' && s.testStartTime) ||
      (typeof timestamp === 'string' && timestamp) ||
      file,
    passed: num(s.passing),
    failed: num(s.failing),
    errors: 0,
    skipped: typeof s.skipped === 'number' ? s.skipped : undefined,
    coverage: Number.isFinite(coverage) ? coverage : undefined,
    duration: typeof s.testExecutionTimeInMs === 'number' ? s.testExecutionTimeInMs : undefined,
  };
}

/**
 * Shape one parsed JSON payload into a run row, or null when it matches none
 * of the known shapes (corrupt/foreign files are skipped, never rendered).
 */
export function shapeTestRun(file: string, raw: unknown): TestRunSummary | null {
  if (!raw || typeof raw !== 'object') return null;

  // Shape 3: bare array of per-test rows.
  if (Array.isArray(raw)) {
    const rows = raw as Array<{ outcome?: unknown; testTimestamp?: unknown }>;
    const passed = rows.filter((t) => t?.outcome === 'Pass').length;
    const failed = rows.filter((t) => t?.outcome === 'Fail').length;
    const first = rows[0]?.testTimestamp;
    return { file, date: typeof first === 'string' ? first : file, passed, failed, errors: 0 };
  }

  const o = raw as Record<string, unknown>;

  // Shape 1: structured log envelope (log-writer.js).
  if (o.schemaVersion === '1' && o.type === 'test-run') {
    const d = (o.data ?? {}) as Record<string, unknown>;
    return {
      file,
      date: typeof o.timestamp === 'string' ? o.timestamp : file,
      passed: num(d.passed),
      failed: num(d.failed),
      errors: num(d.errors),
      coverage: typeof d.coverage === 'number' ? d.coverage : undefined,
      duration: typeof o.durationMs === 'number' ? o.durationMs : undefined,
      org: typeof o.org === 'string' && o.org ? o.org : undefined,
    };
  }

  // Shape 2: raw sf apex run test capture ({ result: { summary } } wins).
  const result = o.result as Record<string, unknown> | undefined;
  if (result && typeof result === 'object') {
    return fromSfSummary(file, (result.summary ?? {}) as Record<string, unknown>, o.timestamp);
  }
  if (o.summary && typeof o.summary === 'object') {
    return fromSfSummary(file, o.summary as Record<string, unknown>, o.timestamp);
  }
  return null;
}

/** Resolve the test-results directory for a workspace root. */
export function testResultsDir(projectRoot: string): string {
  return path.join(logsDir(projectRoot), 'test-results');
}

/**
 * Read the most recent test runs (newest first). Missing directory, unreadable
 * entries, and unknown shapes all degrade to fewer (or zero) rows — never a
 * throw, so the Status tree renders regardless.
 */
export async function readTestRuns(projectRoot: string, limit = 10): Promise<TestRunSummary[]> {
  const dir = testResultsDir(projectRoot);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  // Archive filenames are timestamp-prefixed, so a lexicographic sort is a
  // chronological sort; newest first.
  const files = entries.filter(isTestRunFile).sort().reverse();
  const runs: TestRunSummary[] = [];
  for (const file of files) {
    if (runs.length >= limit) break;
    const raw = await readJsonIfExists<unknown>(path.join(dir, file));
    const run = raw === null ? null : shapeTestRun(file, raw);
    if (run) runs.push(run);
  }
  return runs;
}

/** Whether the run passed cleanly (failures and errors both count against it). */
export function testRunStatus(run: TestRunSummary): CheckStatus {
  return run.failed + run.errors > 0 ? 'fail' : 'ok';
}

/** Compact "12 passed · 1 failed" counts, omitting zero categories (except passed). */
export function testRunCounts(run: TestRunSummary): string {
  const parts = [`${run.passed} passed`];
  if (run.failed > 0) parts.push(`${run.failed} failed`);
  if (run.errors > 0) parts.push(`${run.errors} errored`);
  if ((run.skipped ?? 0) > 0) parts.push(`${run.skipped} skipped`);
  return parts.join(' · ');
}

/** Render an ISO-ish date compactly ("2026-07-01 12:33"); pass through anything else. */
export function formatRunDate(date?: string): string {
  if (!date) return 'unknown time';
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * Build the "Test Runs" section for the Status tree. Each run node opens its
 * raw JSON file (the `__open` sentinel — see statusTree.ts); the empty-state
 * child offers to run `sfdt test`.
 */
export function testRunsSection(runs: TestRunSummary[], resultsDir?: string): TreeNode {
  if (runs.length === 0) {
    return {
      id: 'status.tests',
      label: 'Test Runs',
      description: 'none yet',
      children: [
        {
          id: 'status.tests.empty',
          label: 'Run tests to populate…',
          command: ['test'],
          tooltip: 'Run: sfdt test',
        },
      ],
    };
  }
  const latest = runs[0];
  const latestStatus = testRunStatus(latest);
  return {
    id: 'status.tests',
    label: 'Test Runs',
    description: `last: ${latestStatus === 'ok' ? 'PASS' : 'FAIL'} · ${testRunCounts(latest)}`,
    status: latestStatus,
    tooltip: `Recent Apex test runs from logs/test-results (newest first).`,
    children: runs.map((run) => {
      const status = testRunStatus(run);
      const details = [
        formatRunDate(run.date),
        ...(run.org ? [run.org] : []),
        ...(typeof run.coverage === 'number' ? [`${run.coverage}% cov`] : []),
      ];
      return {
        id: `status.tests.${run.file}`,
        label: `${status === 'ok' ? 'PASS' : 'FAIL'} · ${testRunCounts(run)}`,
        description: details.join(' · '),
        status,
        command: resultsDir ? ['__open', path.join(resultsDir, run.file)] : undefined,
        tooltip: `${run.file}\n${details.join(' · ')}${
          typeof run.duration === 'number' ? `\nDuration: ${Math.round(run.duration / 1000)}s` : ''
        }${resultsDir ? '\n\nClick to open the raw result JSON' : ''}`,
      };
    }),
  };
}
