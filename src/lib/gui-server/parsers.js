import fs from 'fs-extra';
import path from 'path';
import { readLatestLog } from '../log-writer.js';
import { tryReadJson, safeReaddir } from './shared.js';
export function parseTestRunLines(lines) {
  const jsonLine = lines.find((l) => {
    try { const p = JSON.parse(l); return p && (p.result || p.summary || Array.isArray(p)); }
    catch { return false; }
  });
  if (!jsonLine) return { passed: 0, failed: 0, errors: 0, skipped: 0, coverage: null, tests: [], classCoverage: [] };
  const raw = JSON.parse(jsonLine);
  const summary = raw.result?.summary ?? raw.summary ?? {};
  const tests = (raw.result?.tests ?? raw.tests ?? []).map((t) => ({
    name: t.FullName ?? t.methodName ?? t.name ?? 'unknown',
    status: (t.Outcome ?? t.outcome ?? t.status ?? 'unknown').toLowerCase(),
    durationMs: t.RunTime ?? t.runTime ?? null,
    message: t.Message ?? t.message ?? null,
  }));
  const rawCoverageArr =
    raw.result?.codeCoverage ??
    raw.result?.details?.runTestResult?.codeCoverage ??
    raw.result?.coverage?.coverage ??
    [];
  const classCoverage = rawCoverageArr.map((c) => {
    if (c.numLocations != null) {
      const total = c.numLocations;
      const notCovered = c.numLocationsNotCovered ?? 0;
      const covered = total - notCovered;
      return { name: c.name ?? '', coveredLines: covered, totalLines: total, percent: total > 0 ? Math.round((covered / total) * 100) : 0 };
    }
    const lineEntries = Object.entries(c.lines ?? {});
    const total = lineEntries.length || (c.totalLines ?? 0);
    const covered = lineEntries.filter(([, v]) => v === 1).length;
    const uncoveredLines = lineEntries.filter(([, v]) => v === 0).map(([k]) => parseInt(k, 10)).sort((a, b) => a - b);
    return { name: c.name ?? '', coveredLines: covered, totalLines: total, percent: total > 0 ? Math.round((covered / total) * 100) : 0, uncoveredLines };
  }).sort((a, b) => a.percent - b.percent);
  return {
    passed: summary.passing ?? 0,
    failed: summary.failing ?? 0,
    errors: 0,
    skipped: summary.skipped ?? 0,
    coverage: summary.testRunCoverage ? parseFloat(summary.testRunCoverage) : null,
    tests,
    classCoverage,
  };
}
export function parseQualityLines(lines) {
  const jsonLine = lines.find((l) => {
    try { const p = JSON.parse(l); return p && (Array.isArray(p.result) || Array.isArray(p)); }
    catch { return false; }
  });
  if (!jsonLine) return { status: 'PASS', summary: { critical: 0, high: 0, medium: 0, low: 0 }, violations: [] };
  const raw = JSON.parse(jsonLine);
  const rawViolations = Array.isArray(raw.result) ? raw.result : Array.isArray(raw) ? raw : [];
  const violations = rawViolations.flatMap((file) =>
    (file.violations ?? []).map((v) => ({
      file: file.fileName ?? '',
      line: v.line ?? 0,
      rule: v.ruleName ?? v.rule ?? '',
      severity: v.severity ?? 3,
      message: v.message ?? '',
    }))
  );
  const summary = violations.reduce(
    (acc, v) => {
      if (v.severity === 1) acc.critical++;
      else if (v.severity === 2) acc.high++;
      else if (v.severity === 3) acc.medium++;
      else acc.low++;
      return acc;
    },
    { critical: 0, high: 0, medium: 0, low: 0 }
  );
  const result = {
    status: violations.length === 0 ? 'PASS' : 'FAIL',
    summary,
    violations,
  };
  if (raw._sfdt_unavailable) result.unavailableMessage = raw._sfdt_unavailable;
  return result;
}
export async function readTestRuns(logDir) {
  const resultsDir = path.join(logDir, 'test-results');
  if (!(await fs.pathExists(resultsDir))) return [];
  let entries;
  try {
    entries = await fs.readdir(resultsDir);
  } catch {
    return [];
  }
  const jsonFiles = entries
    .filter((f) => f.endsWith('.json') && f !== 'latest.json' && !f.startsWith('batch_') && !f.startsWith('local_'))
    .sort()
    .reverse();
  const runs = [];
  for (const file of jsonFiles) {
    const raw = await tryReadJson(path.join(resultsDir, file));
    if (!raw) continue;
    if (raw.schemaVersion === '1' && raw.type === 'test-run') {
      const d = raw.data ?? {};
      runs.push({
        file,
        date: raw.timestamp,
        passed: d.passed ?? 0,
        failed: d.failed ?? 0,
        errors: d.errors ?? 0,
        coverage: d.coverage ?? undefined,
        duration: raw.durationMs ?? undefined,
        tests: d.tests ?? [],
        classCoverage: d.classCoverage ?? [],
      });
      continue;
    }
    if (raw.result) {
      const r = raw.result;
      runs.push({
        file,
        date: r.summary?.testStartTime ?? raw.timestamp ?? file,
        passed: r.summary?.passing ?? 0,
        failed: r.summary?.failing ?? 0,
        errors: 0,
        skipped: r.summary?.skipped ?? 0,
        coverage: r.summary?.testRunCoverage ? parseFloat(r.summary.testRunCoverage) : undefined,
        duration: r.summary?.testExecutionTimeInMs ?? undefined,
      });
    } else if (raw.summary) {
      runs.push({
        file,
        date: raw.summary.testStartTime ?? raw.timestamp ?? file,
        passed: raw.summary.passing ?? 0,
        failed: raw.summary.failing ?? 0,
        errors: 0,
        skipped: raw.summary.skipped ?? 0,
        coverage: raw.summary.testRunCoverage ? parseFloat(raw.summary.testRunCoverage) : undefined,
        duration: raw.summary.testExecutionTimeInMs ?? undefined,
      });
    } else if (Array.isArray(raw)) {
      const passed = raw.filter((t) => t.outcome === 'Pass').length;
      const failed = raw.filter((t) => t.outcome === 'Fail').length;
      runs.push({ file, date: raw[0]?.testTimestamp ?? file, passed, failed, errors: 0 });
    }
  }
  return runs;
}
export async function readPreflight(logDir) {
  const log = await readLatestLog(logDir, 'preflight');
  if (log) {
    return {
      date: log.timestamp,
      status: log.data.status,
      checks: (log.data.checks ?? []).map((c) => ({
        name: c.name,
        status: c.status,
        message: c.message || null,
      })),
    };
  }
  const files = await safeReaddir(logDir);
  const legacyFiles = files
    .filter((f) => f.startsWith('preflight_') && f.endsWith('.json'))
    .sort()
    .reverse();
  if (!legacyFiles.length) return null;
  return tryReadJson(path.join(logDir, legacyFiles[0]));
}
export async function readQuality(logDir) {
  const log = await readLatestLog(logDir, 'quality');
  if (log) {
    return {
      date: log.timestamp,
      status: log.data.status,
      summary: log.data.summary ?? { critical: 0, high: 0, medium: 0, low: 0 },
      violations: log.data.violations ?? [],
      unavailableMessage: log.data.unavailableMessage ?? null,
    };
  }
  return null;
}
export async function readDrift(logDir) {
  const log = await readLatestLog(logDir, 'drift');
  if (log) {
    return {
      date: log.timestamp,
      status: log.data.status,
      components: log.data.components ?? [],
    };
  }
  const files = await safeReaddir(logDir);
  const legacyFiles = files
    .filter((f) => f.startsWith('drift_') && f.endsWith('.json'))
    .sort()
    .reverse();
  if (!legacyFiles.length) return null;
  return tryReadJson(path.join(logDir, legacyFiles[0]));
}
export async function readCompare(logDir) {
  return tryReadJson(path.join(logDir, 'compare-latest.json'));
}
export async function readScan(logDir) {
  return tryReadJson(path.join(logDir, 'scan-latest.json'));
}
