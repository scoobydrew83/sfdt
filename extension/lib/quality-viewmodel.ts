// Pure snapshot → viewmodel mapping for the Quality Results panel (C-P5-1).
// No DOM, no chrome.*, no network — everything the panel renders is derived
// here so it can be unit-tested against canned bridge payloads.
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE (J-1 policy parity): a scan that
// was SKIPPED is not a scan that passed. `scripts/quality/code-analyzer.sh`
// emits an explicit skipped marker when Salesforce Code Analyzer is missing or
// its run failed, and the CLI's `parseQualityLines` turns that into
// `status: 'SKIPPED'` + `unavailableMessage` with an empty violations array.
// An empty violations array is exactly what a clean scan also produces, so any
// consumer that maps "no violations" to "pass" reports a scan that never ran
// as a green result. `toQualityViewModel` therefore decides the status from
// the marker FIRST and from the violation count only afterwards.

import { setupHostname } from './hostname.js';

export type QualitySeverity = 'critical' | 'high' | 'medium' | 'low';

/** PASS / FAIL / SKIPPED come from the CLI; UNAVAILABLE means no run recorded. */
export type QualityStatus = 'PASS' | 'FAIL' | 'SKIPPED' | 'UNAVAILABLE';

/** The analyzer's 1–5 severity scale, in the order we sort and filter by. */
export const SEVERITY_ORDER: readonly QualitySeverity[] = ['critical', 'high', 'medium', 'low'];

/** A Setup-linkable component recovered from a violation's source path. */
export interface QualityComponent {
  /** Tooling API sObject holding the component, or null when it has none. */
  toolingObject: 'ApexClass' | 'ApexTrigger' | 'LightningComponentBundle' | null;
  /** The Setup tree node, e.g. `ApexClasses` — the `/lightning/setup/<node>/…` segment. */
  setupNode: string;
  /** Developer name, as Setup and the Tooling API know it. */
  name: string;
}

export interface QualityIssue {
  /** Raw workspace-relative path as the analyzer reported it. */
  file: string;
  /** Just the file name, for the dense list. */
  fileLabel: string;
  line: number;
  rule: string;
  /** Which analyzer engine raised it (pmd, eslint, …); '' when unattributed. */
  engine: string;
  severity: QualitySeverity;
  /** Raw 1–5 analyzer severity, kept so sorting matches the analyzer's own. */
  severityRank: number;
  message: string;
}

export interface QualityFileGroup {
  file: string;
  fileLabel: string;
  /** null when the path maps to nothing Setup can open. */
  component: QualityComponent | null;
  /** Most severe issue in the group — what the group badge shows. */
  worst: QualitySeverity;
  issues: QualityIssue[];
}

export interface QualityViewModel {
  status: QualityStatus;
  /**
   * Why there is nothing to show, for SKIPPED and UNAVAILABLE. Never set for
   * PASS or FAIL — a status with a notice is a status the panel must not
   * present as a result.
   */
  notice: string | null;
  timestamp: string | null;
  counts: Record<QualitySeverity, number>;
  total: number;
  /** Distinct engines present in this run, sorted — the attribution filter. */
  engines: string[];
  /** Files with at least one issue, worst-first then by issue count. */
  groups: QualityFileGroup[];
}

/** The bridge `quality.results` payload, as loosely as it can arrive off the wire. */
export interface RawQualitySnapshot {
  available?: boolean;
  hint?: string;
  timestamp?: string | null;
  status?: string | null;
  summary?: { critical?: number; high?: number; medium?: number; low?: number } | null;
  violations?: Array<{
    file?: string | null;
    line?: number | null;
    rule?: string | null;
    engine?: string | null;
    severity?: number | null;
    message?: string | null;
  }> | null;
  unavailableMessage?: string | null;
}

/** Analyzer severity 1–5 → our four buckets (4 and 5 both read as low). */
export function severityBucket(rank: number): QualitySeverity {
  if (rank <= 1) return 'critical';
  if (rank === 2) return 'high';
  if (rank === 3) return 'medium';
  return 'low';
}

// Source-path → Setup component. Deliberately driven by the source-tree layout
// (`.../classes/Foo.cls`) rather than by file extension alone, so a stray
// `.cls` outside a classes directory doesn't produce a Setup link that 404s.
const PATH_RULES: ReadonlyArray<{
  dir: string;
  suffix: string;
  toolingObject: QualityComponent['toolingObject'];
  setupNode: string;
  /** LWC/Aura name the bundle DIRECTORY, not the file inside it. */
  useParentDir?: boolean;
}> = [
  { dir: 'classes', suffix: '.cls', toolingObject: 'ApexClass', setupNode: 'ApexClasses' },
  { dir: 'triggers', suffix: '.trigger', toolingObject: 'ApexTrigger', setupNode: 'ApexTriggers' },
  {
    dir: 'lwc',
    suffix: '',
    toolingObject: 'LightningComponentBundle',
    setupNode: 'LightningComponentBundles',
    useParentDir: true,
  },
  { dir: 'aura', suffix: '', toolingObject: null, setupNode: 'LightningComponentBundles', useParentDir: true },
  { dir: 'flows', suffix: '.flow-meta.xml', toolingObject: null, setupNode: 'Flows' },
];

/**
 * The Setup component a violation's file belongs to, or null when the path is
 * not something Setup can open (a `.js-meta.xml`, an object folder, a path
 * outside the source tree). Accepts both `/` and `\` separators — the analyzer
 * reports whatever the host OS produced.
 */
export function componentForFile(file: string): QualityComponent | null {
  const parts = String(file ?? '')
    .split(/[\\/]/)
    .filter(Boolean);
  if (parts.length < 2) return null;
  const fileName = parts[parts.length - 1]!;

  for (const rule of PATH_RULES) {
    const dirIndex = parts.lastIndexOf(rule.dir);
    if (dirIndex === -1 || dirIndex >= parts.length - 1) continue;
    if (rule.useParentDir) {
      // .../lwc/myCmp/myCmp.js → the bundle is the directory under `lwc`, so
      // there must be at least one path segment after it. A file sitting
      // directly in lwc/ is not a bundle and gets no link.
      if (dirIndex + 1 >= parts.length - 1) continue;
      return {
        toolingObject: rule.toolingObject,
        setupNode: rule.setupNode,
        name: parts[dirIndex + 1]!,
      };
    }
    if (!rule.suffix || !fileName.endsWith(rule.suffix)) continue;
    // The component must sit directly in its type directory.
    if (dirIndex !== parts.length - 2) continue;
    return {
      toolingObject: rule.toolingObject,
      setupNode: rule.setupNode,
      name: fileName.slice(0, fileName.length - rule.suffix.length),
    };
  }
  return null;
}

/**
 * Where "Open in Setup" goes. With a record Id (resolved via Tooling at click
 * time) this is the component's own Setup detail page; without one it is the
 * type's Setup list, which is still the right place to land and never a dead
 * link.
 */
export function buildSetupUrl(
  hostname: string,
  component: QualityComponent,
  recordId?: string | null,
): string {
  const host = setupHostname(hostname);
  if (recordId) {
    return `https://${host}/lightning/setup/${component.setupNode}/page?address=${encodeURIComponent(`/${recordId}`)}`;
  }
  return `https://${host}/lightning/setup/${component.setupNode}/home`;
}

function fileNameOf(file: string): string {
  const parts = String(file ?? '')
    .split(/[\\/]/)
    .filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1]! : file || '(unknown file)';
}

/**
 * Map a `quality.results` payload to everything the panel renders.
 *
 * Status precedence, in order — the first match wins:
 *   1. `available === false`  → UNAVAILABLE (no run recorded yet).
 *   2. skipped marker present → SKIPPED. Checked BEFORE the violation count,
 *      because a skipped run also reports zero violations and must never be
 *      shown as a pass.
 *   3. any violations         → FAIL.
 *   4. otherwise              → PASS.
 */
export function toQualityViewModel(raw: RawQualitySnapshot | null | undefined): QualityViewModel {
  const snapshot = raw ?? {};
  const empty: Record<QualitySeverity, number> = { critical: 0, high: 0, medium: 0, low: 0 };

  if (snapshot.available === false) {
    return {
      status: 'UNAVAILABLE',
      notice:
        snapshot.hint ??
        'No quality results yet — run Quality from the `sfdt ui` dashboard to record a run.',
      timestamp: null,
      counts: { ...empty },
      total: 0,
      engines: [],
      groups: [],
    };
  }

  const issues: QualityIssue[] = (snapshot.violations ?? []).map((v) => {
    const rank = typeof v.severity === 'number' && Number.isFinite(v.severity) ? v.severity : 3;
    const file = String(v.file ?? '');
    return {
      file,
      fileLabel: fileNameOf(file),
      line: typeof v.line === 'number' && Number.isFinite(v.line) ? v.line : 0,
      rule: String(v.rule ?? ''),
      engine: String(v.engine ?? ''),
      severity: severityBucket(rank),
      severityRank: rank,
      message: String(v.message ?? ''),
    };
  });

  const counts = { ...empty };
  for (const issue of issues) counts[issue.severity] += 1;

  // Skipped wins over the violation count. See the file header.
  const skipped = snapshot.status === 'SKIPPED' || !!snapshot.unavailableMessage;
  const status: QualityStatus = skipped ? 'SKIPPED' : issues.length > 0 ? 'FAIL' : 'PASS';

  const byFile = new Map<string, QualityIssue[]>();
  for (const issue of issues) {
    const bucket = byFile.get(issue.file);
    if (bucket) bucket.push(issue);
    else byFile.set(issue.file, [issue]);
  }

  const groups: QualityFileGroup[] = [...byFile.entries()].map(([file, groupIssues]) => {
    const sorted = [...groupIssues].sort(
      (a, b) => a.severityRank - b.severityRank || a.line - b.line,
    );
    return {
      file,
      fileLabel: fileNameOf(file),
      component: componentForFile(file),
      // Non-empty by construction: `byFile` only gains a key when an issue is pushed.
      worst: sorted[0]!.severity,
      issues: sorted,
    };
  });
  groups.sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.worst) - SEVERITY_ORDER.indexOf(b.worst) ||
      b.issues.length - a.issues.length ||
      a.file.localeCompare(b.file),
  );

  const engines = [...new Set(issues.map((i) => i.engine).filter(Boolean))].sort();

  return {
    status,
    notice: skipped
      ? (snapshot.unavailableMessage ??
        'Salesforce Code Analyzer did not run — this is not a clean result.')
      : null,
    timestamp: snapshot.timestamp ?? null,
    counts,
    total: issues.length,
    engines,
    groups,
  };
}

/** Groups narrowed to a severity and/or engine. `null` means "no filter". */
export function filterGroups(
  groups: readonly QualityFileGroup[],
  filters: { severity?: QualitySeverity | null; engine?: string | null },
): QualityFileGroup[] {
  const { severity = null, engine = null } = filters;
  if (!severity && !engine) return [...groups];
  const out: QualityFileGroup[] = [];
  for (const group of groups) {
    const issues = group.issues.filter(
      (i) => (!severity || i.severity === severity) && (!engine || i.engine === engine),
    );
    if (issues.length > 0) out.push({ ...group, issues, worst: issues[0]!.severity });
  }
  return out;
}

/** Pill class for a status — SKIPPED is deliberately NOT the success tone. */
export function statusPillClass(status: QualityStatus): string {
  if (status === 'PASS') return 'sfdt-pill sfdt-success';
  if (status === 'FAIL') return 'sfdt-pill sfdt-error';
  // SKIPPED / UNAVAILABLE: a warning, never a pass.
  return 'sfdt-pill sfdt-warning';
}

/** Pill class for a severity bucket. */
export function severityPillClass(severity: QualitySeverity): string {
  if (severity === 'critical' || severity === 'high') return 'sfdt-pill sfdt-error';
  if (severity === 'medium') return 'sfdt-pill sfdt-warning';
  return 'sfdt-pill';
}

/** Human summary line, e.g. `3 critical · 1 high · 2 medium`. Empty when clean. */
export function summaryLine(counts: Record<QualitySeverity, number>): string {
  return SEVERITY_ORDER.filter((s) => counts[s] > 0)
    .map((s) => `${counts[s]} ${s}`)
    .join(' · ');
}
