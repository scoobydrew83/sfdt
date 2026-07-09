/**
 * Parsing helpers for `sfdt deploy --smart` output, plus the Quick Deploy
 * terminal-command builder.
 *
 * `sfdt deploy` has no `--json` mode, so the extension captures the CLI's
 * textual output from `sfdt deploy --smart --dry-run` and parses the summary
 * lines the CLI prints (see `runSmartDeploy` in the CLI's
 * `src/commands/deploy.js`). This module only *reads* what the CLI reported —
 * it never recomputes deltas or test levels itself (thin-UI rule).
 *
 * Deliberately free of any `vscode` import so it can be unit-tested under
 * vitest against canned CLI output.
 */

import { shellQuote } from './terminal.js';

/** Remove ANSI escape sequences (colors survive capture when forced). */
export function stripAnsi(text: string): string {
  return text.replace(/\u001B\[[0-9;]*[A-Za-z]/g, '');
}

/** Parsed view of one `sfdt deploy --smart --dry-run` run's output. */
export interface SmartDeploySummary {
  /** Base git ref from the "Smart deploy (base...head)" header. */
  base?: string;
  /** Head git ref from the header. */
  head?: string;
  /** Target org alias, as the CLI resolved and reported it. */
  org?: string;
  /** True when the output flagged the org as `[PRODUCTION]` anywhere. */
  production: boolean;
  /** Additive component count from the "Delta:" line; null when not printed. */
  addCount: number | null;
  /** Destructive component count from the "Delta:" line; null when not printed. */
  delCount: number | null;
  /** Count from the "Overwrite-protected (skipped):" line (0 when absent). */
  overwriteProtected: number;
  /** Count of changed files the CLI could not map to a metadata type. */
  unmappedCount: number;
  /** Chosen test level (e.g. RunLocalTests, RunSpecifiedTests). */
  testLevel?: string;
  /** Specified test classes when testLevel is RunSpecifiedTests. */
  tests: string[];
  /** The CLI's stated reason for the test level. */
  testReason?: string;
  /** True when the CLI reported no metadata changes between the refs. */
  noChanges: boolean;
  /** True when the validate/deploy step reported success. */
  succeeded: boolean;
  /** True when the CLI reported a failure (deploy, preflight, or setup). */
  failed: boolean;
  /** Human-readable failure detail when one was printed. */
  failureDetail?: string;
}

// Exact shapes printed by the CLI's runSmartDeploy (src/commands/deploy.js):
//   Smart deploy (main...HEAD) → myorg [PRODUCTION] [validate]
//   Delta: 3 additive, 1 destructive component(s).
//   Overwrite-protected (skipped): 2 component(s).
//   Test level: RunSpecifiedTests (FooTest, BarTest) — only Apex test classes changed
//   2 changed file(s) could not be mapped to a metadata type (skipped).
//   No metadata changes detected between refs — nothing to deploy.
//   Validation succeeded — no changes applied.
//   Smart deploy completed successfully.
//   Smart deploy failed.
//   Preflight failed — aborting deploy: <message>
//   Deployment failed: <message>
const HEADER_RE = /^Smart deploy \((.+?)\.\.\.(.+?)\) → (.+?)( \[PRODUCTION\])?( \[validate\])?$/;
const DELTA_RE = /^Delta: (\d+) additive, (\d+) destructive component\(s\)\.$/;
const PROTECTED_RE = /^Overwrite-protected \(skipped\): (\d+) component\(s\)\.$/;
const TEST_LEVEL_RE = /^Test level: (\S+?)(?: \(([^)]*)\))? — (.+)$/;
const UNMAPPED_RE = /^(\d+) changed file\(s\) could not be mapped to a metadata type \(skipped\)\.$/;
const NO_CHANGES_RE = /^No metadata changes detected between refs — nothing to deploy\.$/;
const SUCCESS_RE = /^(?:Validation succeeded — no changes applied\.|Smart deploy completed successfully\.)$/;
const FAILED_RE = /^Smart deploy failed\.$/;
const PREFLIGHT_FAIL_RE = /^Preflight failed — aborting deploy: (.+)$/;
const DEPLOY_FAIL_RE = /^Deployment failed: (.+)$/;

/**
 * Parse the captured stdout(+stderr) of `sfdt deploy --smart --dry-run` into a
 * structured summary. Tolerates ANSI colors, the CLI's two-space indentation,
 * header rules, and stray subprocess lines — unrecognised lines are skipped.
 */
export function parseSmartDeployOutput(output: string): SmartDeploySummary {
  const summary: SmartDeploySummary = {
    production: false,
    addCount: null,
    delCount: null,
    overwriteProtected: 0,
    unmappedCount: 0,
    tests: [],
    noChanges: false,
    succeeded: false,
    failed: false,
  };
  const clean = stripAnsi(output ?? '');
  for (const raw of clean.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let m: RegExpMatchArray | null;
    if ((m = line.match(HEADER_RE))) {
      summary.base = m[1];
      summary.head = m[2];
      summary.org = m[3];
      if (m[4]) summary.production = true;
    } else if ((m = line.match(DELTA_RE))) {
      summary.addCount = Number(m[1]);
      summary.delCount = Number(m[2]);
    } else if ((m = line.match(PROTECTED_RE))) {
      summary.overwriteProtected = Number(m[1]);
    } else if ((m = line.match(TEST_LEVEL_RE))) {
      summary.testLevel = m[1];
      summary.tests = m[2] ? m[2].split(',').map((t) => t.trim()).filter(Boolean) : [];
      summary.testReason = m[3];
    } else if ((m = line.match(UNMAPPED_RE))) {
      summary.unmappedCount = Number(m[1]);
    } else if (NO_CHANGES_RE.test(line)) {
      summary.noChanges = true;
    } else if (SUCCESS_RE.test(line)) {
      summary.succeeded = true;
    } else if (FAILED_RE.test(line)) {
      summary.failed = true;
    } else if ((m = line.match(PREFLIGHT_FAIL_RE)) || (m = line.match(DEPLOY_FAIL_RE))) {
      summary.failed = true;
      if (!summary.failureDetail) summary.failureDetail = m[1];
    }
  }
  // Belt-and-braces: the org marker is the production signal the confirm
  // dialog keys off, so honour it wherever it appeared in the raw output.
  if (clean.includes('[PRODUCTION]')) summary.production = true;
  return summary;
}

/** Human-readable lines describing a parsed summary (for pickers/dialogs). */
export function summaryLines(summary: SmartDeploySummary): string[] {
  const lines: string[] = [];
  if (summary.org) lines.push(`Org: ${summary.org}${summary.production ? '  ⚠ PRODUCTION' : ''}`);
  if (summary.base && summary.head) lines.push(`Delta range: ${summary.base}...${summary.head}`);
  if (summary.noChanges) {
    lines.push('No metadata changes detected — nothing to deploy.');
    return lines;
  }
  if (summary.addCount !== null && summary.delCount !== null) {
    lines.push(`Delta: ${summary.addCount} additive, ${summary.delCount} destructive component(s)`);
  }
  if (summary.testLevel) {
    const tests = summary.tests.length ? ` (${summary.tests.join(', ')})` : '';
    lines.push(`Test level: ${summary.testLevel}${tests}${summary.testReason ? ` — ${summary.testReason}` : ''}`);
  }
  if (summary.overwriteProtected > 0) lines.push(`Overwrite-protected (skipped): ${summary.overwriteProtected} component(s)`);
  if (summary.unmappedCount > 0) lines.push(`Unmapped changed files (skipped): ${summary.unmappedCount}`);
  if (summary.failed) lines.push(`Validation failed${summary.failureDetail ? `: ${summary.failureDetail}` : ''}`);
  return lines;
}

/**
 * Validate a Salesforce deploy-request (validation job) ID: `0Af` prefix,
 * 15 or 18 alphanumeric characters total — the shape `sf project deploy
 * quick --job-id` accepts and the CLI's quick-deploy path expects.
 */
export function isValidationJobId(id: string): boolean {
  return /^0Af[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(id);
}

export interface QuickDeployCommandOptions {
  /** Target org alias. */
  org?: string;
  /** The validated deploy request ID (0Af…). */
  jobId: string;
}

/**
 * Build the terminal command line for a Quick Deploy.
 *
 * This deliberately targets the sf CLI directly (`sf project deploy quick`)
 * instead of routing through the sfdt CLI's `deployment-assistant.sh`. That
 * script path cannot promote a smart-deploy validation job:
 *
 * - its quick-deploy confirmation `read` is NOT gated on
 *   `SFDT_NON_INTERACTIVE`, so under the script's `set -euo pipefail` a
 *   non-TTY stdin (EOF) aborts the run with exit 1 before the deploy starts;
 * - its non-interactive branch requires a version-named release manifest
 *   under `manifest/release/` (the smart validate's manifest lives in a temp
 *   dir the CLI deletes after the run), exiting 1 when none exists — and when
 *   an unrelated older release manifest does exist, a successful quick deploy
 *   would archive it as "deployed" and tag from its version.
 *
 * Quick Deploy is a single sf command with no sfdt-side computation, so
 * invoking sf directly (as the extension already does for `sf org list` /
 * `sf org display`) stays within the thin-UI rule without inheriting the
 * release-flow side effects. Plain argv (no env prefixes, no redirects) also
 * works in every shell, PowerShell/cmd included.
 */
export function buildQuickDeployCommand(options: QuickDeployCommandOptions): string {
  const { org, jobId } = options;
  const argv = ['sf', 'project', 'deploy', 'quick', '--job-id', jobId];
  if (org) argv.push('--target-org', org);
  return argv.map(shellQuote).join(' ');
}
