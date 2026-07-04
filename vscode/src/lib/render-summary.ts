/**
 * Pure renderers turning native sfdt run results into concise markdown
 * summaries (title, counts by status/severity, top findings) for the
 * "SFDT Results" output channel plus a one-line headline for toasts.
 *
 * Deliberately free of any `vscode` import — unit-testable in isolation.
 * All shapes come from the CLI and are handled defensively: a result that
 * doesn't look like the expected snapshot falls back to a generic summary.
 */

import { describeFinding, classCoverageBand } from '@sfdt/flow-core';
import type { SfdtJsonRun } from './run-json.js';
import type { Snapshot, CheckResult } from './snapshots.js';
import { stripAnsi } from './smart-deploy-output.js';

export type SummaryKind = 'audit' | 'monitor' | 'quality' | 'coverage' | 'preflight' | 'generic';
export type Severity = 'info' | 'warn' | 'error';

export interface RenderedSummary {
  /** Short title, e.g. "Org Audit — myorg". */
  title: string;
  /** One-line headline for the information/warning toast. */
  headline: string;
  /** Full markdown body for the results channel. */
  markdown: string;
  severity: Severity;
}

/**
 * How each natively-run command id (from the command catalog) invokes the
 * CLI: which summary renderer applies, whether the command supports `--json`,
 * and whether it accepts `--org`. Commands not listed here keep the terminal
 * path (interactive pickers, deploys, init).
 */
export interface NativeCommandSpec {
  kind: SummaryKind;
  json: boolean;
  org: boolean;
}

export const NATIVE_COMMANDS: Record<string, NativeCommandSpec> = {
  audit: { kind: 'audit', json: true, org: true },
  monitor: { kind: 'monitor', json: true, org: true },
  coverage: { kind: 'coverage', json: true, org: true },
  // `sfdt quality` has no --json/--org yet, and it captures the scanner
  // output internally: on a real run stdout carries only progress chrome and
  // (at most) the "scan was SKIPPED" warning parsed by parseQualityOutput.
  // Violation data comes from the logs/quality-latest.json snapshot the
  // caller reads alongside the run (renderSummary `options.quality`); a run
  // with no data from any source renders as inconclusive — never as a clean
  // success.
  quality: { kind: 'quality', json: false, org: false },
  // `sfdt preflight` has no --json yet — interpret by exit code and render
  // the SFDT_LOG:check:<name>:<status>:<detail> markers it prints on stdout.
  preflight: { kind: 'preflight', json: false, org: false },
};

/**
 * Resolve the native-run spec for a command-catalog entry (tree leaf, palette
 * quick-pick item, or dedicated shortcut). Exact id match first (the palette
 * shortcuts use the parent ids), then the root CLI command (`args[0]`) so
 * every `sfdt audit <check>` / `sfdt monitor <check>` subcommand in the tree
 * gets the same native rendering — each supports `--json`/`--org` and emits
 * the same snapshot shape as `all`. Destructive entries (e.g. `monitor
 * backup`) and non-CLI actions keep the integrated-terminal path.
 */
export function nativeSpecFor(entry: {
  id: string;
  args?: string[];
  destructive?: boolean;
}): NativeCommandSpec | undefined {
  if (!entry.args || entry.args.length === 0 || entry.destructive) return undefined;
  return NATIVE_COMMANDS[entry.id] ?? NATIVE_COMMANDS[entry.args[0]];
}

const KIND_LABEL: Record<SummaryKind, string> = {
  audit: 'Org Audit',
  monitor: 'Org Monitor',
  quality: 'Quality Analysis',
  coverage: 'Code Coverage',
  preflight: 'Preflight',
  generic: 'sfdt',
};

export interface RenderSummaryOptions {
  label?: string;
  /**
   * Pre-resolved quality result (qualityFromRun — envelope, stdout markers,
   * or a fresh logs/quality-latest.json snapshot). Rendered ahead of the
   * run-derived sources when set; only meaningful for `kind: 'quality'`.
   */
  quality?: QualityResult | null;
}

/** Render the summary for a completed (or failed) native run. */
export function renderSummary(
  kind: SummaryKind,
  run: SfdtJsonRun,
  options: RenderSummaryOptions = {},
): RenderedSummary {
  const label = options.label ?? KIND_LABEL[kind] ?? 'sfdt';

  // Preflight communicates its checks via stdout markers and its verdict via
  // the exit code — render the check list even when the run "failed".
  if (kind === 'preflight') {
    const rendered = renderPreflight(label, run);
    if (rendered) return rendered;
  }
  if (!run.ok) return renderFailure(label, run);

  switch (kind) {
    case 'audit':
    case 'monitor': {
      const rendered = renderSnapshot(label, run);
      if (rendered) return rendered;
      break;
    }
    case 'coverage': {
      const rendered = renderCoverage(label, run);
      if (rendered) return rendered;
      break;
    }
    case 'quality': {
      const rendered =
        (options.quality ? renderQualityResult(label, options.quality, run.warnings) : null) ??
        renderQuality(label, run) ??
        renderQualityFromOutput(label, run);
      if (rendered) return rendered;
      // No scan data from any source. Today's `sfdt quality` swallows the
      // scanner output, so this is the normal outcome of a native run whose
      // snapshot didn't update — never report it as a clean success.
      return renderQualityInconclusive(label, run);
    }
  }
  return renderGeneric(label, run);
}

/* ── audit / monitor snapshots ─────────────────────────────────────────── */

function isSnapshot(v: unknown): v is Snapshot {
  const s = v as Snapshot | null;
  return !!s && Array.isArray(s.checks) && !!s.summary && typeof s.summary === 'object';
}

const STATUS_ORDER: Record<string, number> = { fail: 0, error: 1, warn: 2, ok: 3 };

function renderSnapshot(label: string, run: SfdtJsonRun): RenderedSummary | null {
  if (!isSnapshot(run.result)) return null;
  const snap = run.result;
  const s = snap.summary;
  const counts = `${s.ok ?? 0} ok · ${s.warn ?? 0} warn · ${s.fail ?? 0} fail · ${s.error ?? 0} error`;
  const severity: Severity = (s.fail ?? 0) + (s.error ?? 0) > 0 ? 'error' : (s.warn ?? 0) > 0 ? 'warn' : 'info';
  const title = `${label} — ${snap.org ?? 'org'}`;
  const issues = (s.warn ?? 0) + (s.fail ?? 0) + (s.error ?? 0);
  const headline =
    issues === 0
      ? `${label}: all ${s.total ?? snap.checks.length} checks passed (${snap.org ?? 'org'})`
      : `${label}: ${counts} (${snap.org ?? 'org'})`;

  const attention = snap.checks
    .filter((c) => c.status !== 'ok')
    .sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9));
  const passing = snap.checks.filter((c) => c.status === 'ok');

  const lines: string[] = [`# ${title}`, ''];
  if (snap.timestamp) lines.push(`_${snap.timestamp}_`, '');
  lines.push(`**Checks:** ${counts}`, '');
  if (attention.length > 0) {
    lines.push('## Attention needed', '');
    for (const check of attention) lines.push(...renderCheck(check));
  }
  if (passing.length > 0) {
    lines.push('## Passing', '');
    for (const check of passing) lines.push(`- ${check.title} — ${check.summary}`);
    lines.push('');
  }
  lines.push(...renderWarnings(run.warnings));
  return { title, headline, markdown: lines.join('\n').trim(), severity };
}

function renderCheck(check: CheckResult, maxFindings = 5): string[] {
  const lines = [`### ${check.status.toUpperCase()} · ${check.title}`, '', check.summary, ''];
  const findings = Array.isArray(check.findings) ? check.findings : [];
  for (const f of findings.slice(0, maxFindings)) {
    lines.push(`- ${describeFinding(f)}`);
  }
  if (findings.length > maxFindings) lines.push(`- … +${findings.length - maxFindings} more`);
  if (findings.length > 0) lines.push('');
  return lines;
}

/* ── coverage ──────────────────────────────────────────────────────────── */

interface CoverageResult {
  org?: string;
  threshold?: number;
  orgWide?: number | null;
  belowThreshold?: boolean;
  classes?: Array<{ name: string; pct: number | null }>;
}

function renderCoverage(label: string, run: SfdtJsonRun): RenderedSummary | null {
  const r = run.result as CoverageResult | null;
  if (!r || !('orgWide' in r) || !Array.isArray(r.classes)) return null;
  const orgWide = r.orgWide ?? null;
  const orgLabel = orgWide === null ? 'unknown (run tests first)' : `${orgWide}%`;
  const title = `${label} — ${r.org ?? 'org'}`;
  const headline = `${label}: org-wide ${orgLabel} (threshold ${r.threshold ?? '?'}%)`;

  const bands = { green: 0, amber: 0, red: 0, none: 0 };
  for (const c of r.classes) bands[classCoverageBand(c.pct ?? null)]++;
  const severity: Severity = r.belowThreshold ? 'error' : bands.red + bands.none > 0 ? 'warn' : 'info';

  const lines = [
    `# ${title}`,
    '',
    `**Org-wide:** ${orgLabel} (threshold ${r.threshold ?? '?'}%)${r.belowThreshold ? ' — **below threshold**' : ''}`,
    '',
    `**Classes:** ${bands.green} ≥90% · ${bands.amber} 75–90% · ${bands.red} <75% · ${bands.none} no lines`,
    '',
  ];
  const worst = r.classes.filter((c) => classCoverageBand(c.pct ?? null) !== 'green').slice(0, 10);
  if (worst.length > 0) {
    lines.push('## Lowest coverage', '');
    for (const c of worst) {
      const pct = c.pct === null || c.pct === undefined ? 'no lines' : `${Math.round(c.pct * 100)}%`;
      lines.push(`- ${pct} — ${c.name}`);
    }
    lines.push('');
  }
  lines.push(...renderWarnings(run.warnings));
  return { title, headline, markdown: lines.join('\n').trim(), severity };
}

/* ── quality (logs/quality-latest.json `data` shape) ───────────────────── */

export interface QualityResult {
  status?: string;
  summary?: { critical?: number; high?: number; medium?: number; low?: number };
  violations?: Array<{ file?: string; line?: number; rule?: string; severity?: number; message?: string }>;
  unavailableMessage?: string | null;
}

// Strip ANSI color codes so chalk-colored CLI lines still match markers.

/**
 * Shape a Salesforce Code Analyzer JSON payload (`sf scanner run --format
 * json` → `{ result: [{ fileName, violations }] }` or a bare file array, plus
 * the `{"status":"skipped", …}` marker emitted by
 * scripts/quality/code-analyzer.sh) into the quality-latest.json `data` shape.
 * Same contract the GUI applies to the same script output (gui-server
 * parseQualityLines). Returns null for anything else.
 */
function shapeScannerJson(raw: unknown): QualityResult | null {
  const obj = raw as { status?: string; _sfdt_unavailable?: string; reason?: string; result?: unknown } | null;
  const skipped = !!obj && !Array.isArray(obj) && (obj.status === 'skipped' || !!obj._sfdt_unavailable);
  const files = Array.isArray(obj?.result) ? obj.result : Array.isArray(raw) ? raw : null;
  if (!files && !skipped) return null;

  const violations = (files ?? []).flatMap((file: { fileName?: string; violations?: Array<Record<string, unknown>> }) =>
    (file.violations ?? []).map((v) => ({
      file: file.fileName ?? '',
      line: Number(v.line ?? 0),
      rule: String(v.ruleName ?? v.rule ?? ''),
      severity: Number(v.severity ?? 3),
      message: String(v.message ?? ''),
    })),
  );
  const summary = violations.reduce(
    (acc, v) => {
      if (v.severity === 1) acc.critical++;
      else if (v.severity === 2) acc.high++;
      else if (v.severity === 3) acc.medium++;
      else acc.low++;
      return acc;
    },
    { critical: 0, high: 0, medium: 0, low: 0 },
  );
  // A skipped scan (scanner missing or crashed) must never read as a clean
  // PASS — mirror the CLI/GUI guard.
  if (skipped) {
    return {
      status: 'SKIPPED',
      summary,
      violations,
      unavailableMessage: obj?.reason ?? obj?._sfdt_unavailable ?? 'code scan skipped',
    };
  }
  return { status: violations.length === 0 ? 'PASS' : 'FAIL', summary, violations };
}

/**
 * Parse the structured quality result out of raw `sfdt quality` output:
 * a scanner JSON line when the CLI surfaces one, else the CLI's own
 * "static violation scan was SKIPPED — <reason>" warning (quality.js), so a
 * skipped scan is never rendered as a clean success. Returns null when no
 * marker is present — the caller falls back to the generic renderer, never a
 * fabricated PASS.
 */
export function parseQualityOutput(output: string): QualityResult | null {
  const text = stripAnsi(String(output ?? ''));
  let found: QualityResult | null = null;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) continue;
    try {
      const shaped = shapeScannerJson(JSON.parse(trimmed));
      if (shaped) found = shaped;
    } catch {
      // Not a JSON line — keep scanning.
    }
  }
  if (found) return found;
  const skip = text.match(/static violation scan was SKIPPED — ([^\n]+)/);
  if (skip) {
    return {
      status: 'SKIPPED',
      summary: { critical: 0, high: 0, medium: 0, low: 0 },
      violations: [],
      unavailableMessage: skip[1].trim(),
    };
  }
  return null;
}

function renderQualityFromOutput(label: string, run: SfdtJsonRun): RenderedSummary | null {
  const parsed = parseQualityOutput(run.raw);
  return parsed ? renderQualityResult(label, parsed, run.warnings) : null;
}

function renderQuality(label: string, run: SfdtJsonRun): RenderedSummary | null {
  const r = run.result as QualityResult | null;
  if (!r || !Array.isArray(r.violations)) return null;
  return renderQualityResult(label, r, run.warnings);
}

/**
 * Honest fallback for a quality run that finished without surfacing any scan
 * data (no envelope, no stdout markers, no fresh snapshot). We cannot tell a
 * clean scan from one full of critical violations, so this is a `warn`, and
 * the headline says the outcome is unknown instead of claiming success.
 */
function renderQualityInconclusive(label: string, run: SfdtJsonRun): RenderedSummary {
  const headline = `${label} finished, but no scan results were captured — violations may exist`;
  const lines = [
    `# ${label}`,
    '',
    '**Status:** inconclusive — the CLI did not surface scan results for this run.',
    '',
    '> This `sfdt` version does not print machine-readable scanner output. Run the scan',
    '> from the SFDT dashboard (`sfdt ui` → Quality), which writes `logs/quality-latest.json`;',
    '> the extension picks that snapshot up and populates the Problems pane automatically.',
    '',
  ];
  lines.push(...renderWarnings(run.warnings));
  lines.push(...fencedTail(run.raw, 20));
  return {
    title: label,
    headline,
    markdown: lines.join('\n').trim(),
    severity: 'warn',
  };
}

function renderQualityResult(label: string, r: QualityResult, warnings: string[]): RenderedSummary {
  const s = r.summary ?? {};
  const violations = Array.isArray(r.violations) ? r.violations : [];
  const counts = `${s.critical ?? 0} critical · ${s.high ?? 0} high · ${s.medium ?? 0} medium · ${s.low ?? 0} low`;
  const status = (r.status ?? '').toUpperCase();
  const skipped = status === 'SKIPPED';
  const severity: Severity =
    status === 'FAIL' ? 'error' : skipped || violations.length > 0 ? 'warn' : 'info';
  const title = label;
  const headline = skipped
    ? `${label}: scan SKIPPED — ${r.unavailableMessage ?? 'scanner unavailable'}`
    : violations.length === 0
      ? `${label}: no violations`
      : `${label}: ${status || 'FAIL'} — ${counts}`;

  const lines = [`# ${title}`, '', `**Status:** ${status || 'unknown'} — ${counts}`, ''];
  if (skipped && r.unavailableMessage) {
    lines.push(`> Static scan was skipped: ${r.unavailableMessage}`, '');
  }
  const top = [...violations].sort((a, b) => (a.severity ?? 9) - (b.severity ?? 9)).slice(0, 10);
  if (top.length > 0) {
    lines.push('## Top violations', '');
    for (const v of top) {
      const where = v.file ? `${v.file}${v.line ? `:${v.line}` : ''}` : '(unknown file)';
      lines.push(`- [sev ${v.severity ?? '?'}] ${where} — ${v.rule ?? 'rule'}${v.message ? `: ${v.message}` : ''}`);
    }
    if (violations.length > top.length) lines.push(`- … +${violations.length - top.length} more`);
    lines.push('');
  }
  lines.push(...renderWarnings(warnings));
  return { title, headline, markdown: lines.join('\n').trim(), severity };
}

/* ── preflight (SFDT_LOG:check markers on stdout) ──────────────────────── */

export interface PreflightCheck {
  name: string;
  status: string;
  message: string;
}

/**
 * Parse `SFDT_LOG:check:<name>:<PASS|WARN|FAIL>:<detail>` marker lines from
 * preflight stdout (same format `src/lib/log-writer.js` parses server-side).
 */
export function parsePreflightChecks(output: string): PreflightCheck[] {
  const checks: PreflightCheck[] = [];
  for (const line of String(output ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('SFDT_LOG:')) continue;
    const parts = trimmed.split(':');
    if (parts[1] !== 'check') continue;
    checks.push({ name: parts[2] ?? '', status: parts[3] ?? '', message: parts.slice(4).join(':') });
  }
  return checks;
}

function renderPreflight(label: string, run: SfdtJsonRun): RenderedSummary | null {
  const checks = parsePreflightChecks(run.raw);
  if (checks.length === 0) return null;
  const fail = checks.filter((c) => c.status === 'FAIL');
  const warn = checks.filter((c) => c.status === 'WARN');
  const pass = checks.filter((c) => c.status === 'PASS');
  const failed = fail.length > 0 || !run.ok;
  const severity: Severity = failed ? 'error' : warn.length > 0 ? 'warn' : 'info';
  const counts = `${pass.length} pass · ${warn.length} warn · ${fail.length} fail`;
  const headline = failed ? `${label} failed: ${counts}` : `${label} passed: ${counts}`;

  const lines = [`# ${label}`, '', `**Checks:** ${counts}`, ''];
  const section = (heading: string, items: PreflightCheck[]) => {
    if (items.length === 0) return;
    lines.push(`## ${heading}`, '');
    for (const c of items) lines.push(`- ${c.name}${c.message ? ` — ${c.message}` : ''}`);
    lines.push('');
  };
  section('Failed', fail);
  section('Warnings', warn);
  section('Passed', pass);
  if (failed && run.error) lines.push(`> ${run.error}`, '');
  return { title: label, headline, markdown: lines.join('\n').trim(), severity };
}

/* ── failure / generic fallbacks ───────────────────────────────────────── */

function fencedTail(raw: string, maxLines = 40, maxChars = 4000): string[] {
  const text = String(raw ?? '').trim();
  if (!text) return [];
  let picked = text.split('\n').slice(-maxLines).join('\n');
  if (picked.length > maxChars) picked = `…${picked.slice(-maxChars)}`;
  return ['```', picked, '```', ''];
}

function renderWarnings(warnings: string[]): string[] {
  if (!warnings || warnings.length === 0) return [];
  return ['## Warnings', '', ...warnings.map((w) => `- ${w}`), ''];
}

function renderFailure(label: string, run: SfdtJsonRun): RenderedSummary {
  const reason = run.error ?? 'command failed';
  const lines = [`# ${label} failed`, '', `**Error:** ${reason}`, ''];
  lines.push(...renderWarnings(run.warnings));
  lines.push(...fencedTail(run.raw));
  return {
    title: `${label} failed`,
    headline: `${label} failed: ${reason}`,
    markdown: lines.join('\n').trim(),
    severity: 'error',
  };
}

function renderGeneric(label: string, run: SfdtJsonRun): RenderedSummary {
  const severity: Severity = run.warnings.length > 0 ? 'warn' : 'info';
  const lines = [`# ${label}`, '', `**Status:** completed successfully`, ''];
  lines.push(...renderWarnings(run.warnings));
  lines.push(...fencedTail(run.raw, 20));
  return {
    title: label,
    headline: `${label} completed`,
    markdown: lines.join('\n').trim(),
    severity,
  };
}
