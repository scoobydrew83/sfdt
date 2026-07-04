/**
 * Map sfdt quality results (Salesforce Code Analyzer violations surfaced by
 * `sfdt quality`) into plain diagnostic entries for the VS Code Problems pane.
 *
 * Deliberately free of any `vscode` import — the extension layer converts
 * these entries into `vscode.Diagnostic`s. Audit/monitor findings are org
 * inventory (usernames, license types, component names), not file locations,
 * so quality violations are the only source of file-anchored diagnostics.
 */

import * as path from 'node:path';
import type { SfdtJsonRun } from './run-json.js';
import { parseQualityOutput, type QualityResult } from './render-summary.js';

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface DiagnosticEntry {
  /** Absolute file path (relative scanner paths resolved against the workspace root). */
  file: string;
  /** 1-based line number (always ≥ 1). */
  line: number;
  severity: DiagnosticSeverity;
  message: string;
  /** Problems-pane "source" column. */
  source: string;
  /** Rule id (Problems-pane "code" column); empty when the scanner gave none. */
  code: string;
}

/** Scanner severity → Problems-pane severity: 1 = error, 2 = warning, 3+ = info. */
export function severityFor(severity: number | undefined): DiagnosticSeverity {
  if (severity === 1) return 'error';
  if (severity === 2) return 'warning';
  return 'info';
}

/**
 * Envelope shape of `logs/quality-latest.json` as written by the CLI's
 * log-writer (`{ schemaVersion, type: 'quality', timestamp, data }`, where
 * `data` is the QualityResult shape). This is the snapshot the GUI writes
 * after a dashboard quality run and the MCP server reads back — the same
 * file the extension consumes here.
 */
export interface QualityLogEnvelope {
  schemaVersion?: string;
  type?: string;
  timestamp?: string;
  data?: QualityResult | null;
}

/**
 * Extract the quality result from a parsed `logs/quality-latest.json`
 * envelope. Returns null for anything that is not a quality envelope with a
 * violations array. When `since` is given, an envelope written before that
 * instant (or with an unparseable timestamp) is rejected — used after a
 * native run so a stale snapshot from an older scan is never attributed to
 * the run that just finished.
 */
export function qualityFromSnapshot(
  envelope: unknown,
  options: { since?: string } = {},
): QualityResult | null {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return null;
  const env = envelope as QualityLogEnvelope;
  if (env.type !== 'quality') return null;
  const data = env.data;
  if (!data || typeof data !== 'object' || !Array.isArray(data.violations)) return null;
  if (options.since) {
    const written = Date.parse(env.timestamp ?? '');
    const since = Date.parse(options.since);
    if (!Number.isFinite(written) || !Number.isFinite(since) || written < since) return null;
  }
  return data;
}

/** Optional extra sources consulted when the run itself carries no result. */
export interface QualitySources {
  /** Parsed `logs/quality-latest.json` envelope, when the caller read one. */
  snapshot?: unknown;
  /** ISO start-of-run timestamp; a snapshot older than this is ignored. */
  since?: string;
}

/**
 * Extract the structured quality result for a native `sfdt quality` run.
 * Sources, in order:
 *
 * 1. the `--json` envelope payload, when it carries the violations shape
 *    (future-proofing — `sfdt quality` has no `--json` today);
 * 2. scanner JSON / skip markers parsed out of raw stdout. NOTE: today's CLI
 *    captures the code-analyzer output internally and re-emits only the
 *    "static violation scan was SKIPPED — …" warning, so on a real run this
 *    path yields SKIPPED at most — never violations;
 * 3. a fresh `logs/quality-latest.json` snapshot written during the run —
 *    the only place the suite persists real violation data today.
 *
 * Null when no source produced a result (the caller should then clear any
 * previously published diagnostics rather than leave them stale).
 */
export function qualityFromRun(run: SfdtJsonRun, sources: QualitySources = {}): QualityResult | null {
  const r = run.result as QualityResult | null;
  if (r && Array.isArray(r.violations)) return r;
  return (
    parseQualityOutput(run.raw) ??
    qualityFromSnapshot(sources.snapshot, { since: sources.since })
  );
}

/**
 * Convert a quality result into diagnostic entries. A SKIPPED scan (scanner
 * missing/crashed) yields no entries — there is nothing file-anchored to
 * show. Violations without a usable file path are skipped, as are relative
 * paths when no workspace root is available to resolve them against (a
 * dangling relative Uri would open the wrong file — or none).
 */
export function qualityToDiagnostics(
  result: QualityResult | null | undefined,
  workspaceRoot: string | undefined,
): DiagnosticEntry[] {
  if (!result || (result.status ?? '').toUpperCase() === 'SKIPPED') return [];
  const violations = Array.isArray(result.violations) ? result.violations : [];
  const entries: DiagnosticEntry[] = [];
  for (const v of violations) {
    const rawFile = typeof v.file === 'string' ? v.file.trim() : '';
    if (!rawFile) continue;
    let file: string;
    if (path.isAbsolute(rawFile)) {
      file = path.normalize(rawFile);
    } else if (workspaceRoot) {
      file = path.resolve(workspaceRoot, rawFile);
    } else {
      continue;
    }
    const line = Number.isFinite(v.line) && Number(v.line) >= 1 ? Math.floor(Number(v.line)) : 1;
    const rule = v.rule ?? '';
    entries.push({
      file,
      line,
      severity: severityFor(v.severity),
      message: v.message || rule || 'code analyzer violation',
      source: 'sfdt',
      code: rule,
    });
  }
  return entries;
}

/** Group entries per absolute file path — one Problems-pane bucket per Uri. */
export function groupByFile(entries: DiagnosticEntry[]): Map<string, DiagnosticEntry[]> {
  const byFile = new Map<string, DiagnosticEntry[]>();
  for (const entry of entries) {
    const bucket = byFile.get(entry.file);
    if (bucket) bucket.push(entry);
    else byFile.set(entry.file, [entry]);
  }
  return byFile;
}
