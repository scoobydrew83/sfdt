import fs from 'fs-extra';
import path from 'path';
const SFDX_PROJECT_FILE = 'sfdx-project.json';
export function resolveLogDir(config) {
  if (config.logDir) {
    return path.isAbsolute(config.logDir)
      ? config.logDir
      : path.join(config._projectRoot, config.logDir);
  }
  return path.join(config._projectRoot, 'logs');
}
export async function buildProjectContext(config) {
  const lines = [];
  if (config.projectName) lines.push(`- Project: ${config.projectName}`);
  if (config.defaultOrg) lines.push(`- Org: ${config.defaultOrg}`);
  if (config.sourceApiVersion) lines.push(`- API Version: ${config.sourceApiVersion}`);
  if (config.defaultSourcePath) lines.push(`- Source Path: ${config.defaultSourcePath}`);
  const threshold = config.deployment?.coverageThreshold ?? config.testConfig?.coverageThreshold;
  if (threshold != null) lines.push(`- Coverage Threshold: ${threshold}%`);
  if (config.testConfig?.testLevel) lines.push(`- Test Level: ${config.testConfig.testLevel}`);
  const testClasses = config.testConfig?.testClasses;
  if (Array.isArray(testClasses) && testClasses.length) {
    lines.push(`- Test Classes: ${testClasses.join(', ')}`);
  }
  const apexClasses = config.testConfig?.apexClasses;
  if (Array.isArray(apexClasses) && apexClasses.length) {
    lines.push(`- Apex Classes Under Test: ${apexClasses.join(', ')}`);
  }
  try {
    const sfdxPath = path.join(config._projectRoot, SFDX_PROJECT_FILE);
    const sfdxProject = await fs.readJson(sfdxPath);
    if (sfdxProject.namespace) lines.push(`- Namespace: ${sfdxProject.namespace}`);
  } catch {
  }
  if (!lines.length) return '';
  return '## PROJECT CONTEXT\n' + lines.join('\n');
}
export async function readLatestTestRuns(config, limit = 3) {
  const logDir = resolveLogDir(config);
  const resultsDir = path.join(logDir, 'test-results');
  if (!(await fs.pathExists(resultsDir))) return [];
  let entries;
  try {
    entries = await fs.readdir(resultsDir);
  } catch {
    return [];
  }
  const jsonFiles = entries.filter((f) => f.endsWith('.json') && f !== 'latest.json').sort().reverse();
  const runs = [];
  for (const file of jsonFiles) {
    if (runs.length >= limit) break;
    let raw;
    try {
      raw = await fs.readJson(path.join(resultsDir, file));
    } catch {
      continue;
    }
    if (raw?.schemaVersion === '1' && raw.type === 'test-run') {
      const d = raw.data ?? {};
      runs.push({
        date: raw.timestamp,
        passed: d.passed ?? 0,
        failed: d.failed ?? 0,
        errors: d.errors ?? 0,
        coverage: d.coverage ?? undefined,
        duration: raw.durationMs ?? undefined,
      });
      continue;
    }
    if (raw?.result?.summary) {
      const s = raw.result.summary;
      runs.push({
        date: s.testStartTime ?? raw.timestamp ?? file,
        passed: s.passing ?? 0,
        failed: s.failing ?? 0,
        errors: s.skipped ?? 0,
        coverage: s.testRunCoverage ? parseFloat(s.testRunCoverage) : undefined,
        duration: s.testExecutionTimeInMs,
      });
    } else if (raw?.summary) {
      const s = raw.summary;
      runs.push({
        date: s.testStartTime ?? raw.timestamp ?? file,
        passed: s.passing ?? 0,
        failed: s.failing ?? 0,
        errors: s.skipped ?? 0,
        coverage: s.testRunCoverage ? parseFloat(s.testRunCoverage) : undefined,
        duration: s.testExecutionTimeInMs,
      });
    } else if (Array.isArray(raw) && raw.length) {
      runs.push({
        date: raw[0]?.testTimestamp ?? file,
        passed: raw.filter((t) => t.outcome === 'Pass').length,
        failed: raw.filter((t) => t.outcome === 'Fail').length,
        errors: 0,
      });
    }
  }
  return runs;
}
export async function readLatestPreflight(config) {
  const logDir = resolveLogDir(config);
  let raw = null;
  try {
    const primary = path.join(logDir, 'preflight-latest.json');
    if (await fs.pathExists(primary)) raw = await fs.readJson(primary);
  } catch {
  }
  if (!raw) {
    try {
      const entries = await fs.readdir(logDir);
      const candidates = entries
        .filter((f) => f.startsWith('preflight_') && f.endsWith('.json'))
        .sort()
        .reverse();
      if (candidates.length) raw = await fs.readJson(path.join(logDir, candidates[0]));
    } catch {
    }
  }
  if (!raw) return null;
  if (raw?.schemaVersion === '1') {
    return { date: raw.timestamp, status: raw.data?.status, checks: raw.data?.checks ?? [] };
  }
  return raw;
}
export async function readDeployHistory(config, limit = 3) {
  const logDir = resolveLogDir(config);
  try {
    const history = await fs.readJson(path.join(logDir, 'deploy-history.json'));
    if (!Array.isArray(history)) return [];
    return history.slice(0, limit);
  } catch {
    return [];
  }
}
export function buildContextBlock(sections) {
  return sections.filter(Boolean).join('\n\n');
}
export function formatTestRunsSection(runs) {
  if (!runs.length) return '';
  const lines = runs.map((r) => {
    const cov = r.coverage != null ? ` — ${r.coverage.toFixed(1)}% coverage` : '';
    const date = typeof r.date === 'string' ? r.date.split('T')[0] : r.date;
    return `- ${date}: ${r.passed} passed, ${r.failed} failed${cov}`;
  });
  return '## RECENT TEST RUNS\n' + lines.join('\n');
}
export function formatPreflightSection(preflight) {
  if (!preflight) return '';
  const header = `## LATEST PREFLIGHT (${preflight.date?.split?.('T')?.[0] ?? preflight.date ?? 'unknown'} — ${preflight.status ?? 'unknown'})`;
  if (!Array.isArray(preflight.checks) || !preflight.checks.length) return header;
  const lines = preflight.checks.map((c) => `- ${(c.status ?? '?').padEnd(5)} ${c.name}${c.message ? `: ${c.message}` : ''}`);
  return header + '\n' + lines.join('\n');
}
export function formatDeployHistorySection(history) {
  if (!history.length) return '';
  const lines = history.map((d) => {
    const date = typeof d.date === 'string' ? d.date.split('T')[0] : d.date;
    const org = d.org ?? 'unknown org';
    const outcome = d.exitCode === 0 ? 'SUCCESS' : `FAILED (exit ${d.exitCode})`;
    const flags = [d.dryRun ? 'dry-run' : null, d.skipPreflight ? 'skip-preflight' : null]
      .filter(Boolean)
      .join(', ');
    return `- ${date}: ${org} — ${outcome}${flags ? ` [${flags}]` : ''}`;
  });
  return '## RECENT DEPLOY HISTORY\n' + lines.join('\n');
}
export function formatMetadataTypesSection(parsed) {
  const lines = [];
  for (const [type, members] of Object.entries(parsed.additive ?? {})) {
    if (members.length) lines.push(`- ${type}: ${members.join(', ')}`);
  }
  for (const [type, members] of Object.entries(parsed.destructive ?? {})) {
    if (members.length) lines.push(`- ${type} (deleted): ${members.join(', ')}`);
  }
  if (!lines.length) return '';
  return '## AFFECTED METADATA TYPES\n' + lines.join('\n');
}
