// AI-Readiness Index — evidence grouping.
//
// Maps the org-health checks every surface already runs (CLI `sfdt audit` /
// `sfdt monitor` snapshots, and the Chrome extension's in-browser checks) onto
// the eight dimensions of the AI-Readiness Index, so an architect assessing an
// org sees the evidence for each dimension in one place.
//
// DELIBERATELY NO SCORE. The Index is scored by a person, on judgment; this
// module only gathers and groups evidence. A per-dimension status here is the
// worst status of the checks under it — a pointer to where to look, not a
// rating. Do not add a numeric score without revisiting that decision: an
// automated score turns this into a free scanner competing on feature count,
// which is the thing the evidence pack exists to avoid.
//
// Pure: no I/O, no DOM. Shared by the CLI (`sfdt audit --index`) and the Chrome
// Org Health panel so both group the same checks the same way.

import type { Band } from './org-health-checks.js';
import { describeFinding } from './health-findings.js';

export type IndexCheckStatus = 'ok' | 'warn' | 'error' | 'fail';
/** A dimension's status: the worst of its checks, or `none` when no check ran. */
export type IndexDimensionStatus = IndexCheckStatus | 'none';
export type IndexSource = 'audit' | 'monitor' | 'live';

/** One check reference under a dimension. */
export interface IndexCheckRef {
  source: IndexSource;
  id: string;
  /**
   * For a live (in-browser) check: the CLI check that measures the same thing
   * more deeply. When that CLI check is present, the live one is not repeated.
   */
  supersededBy?: { source: Exclude<IndexSource, 'live'>; id: string };
}

export interface IndexDimension {
  id: string;
  title: string;
  /** What the dimension measures, from the published Index. */
  measures: string;
  checks: readonly IndexCheckRef[];
  /** What the checks can't see — the part the assessor covers by hand. */
  manualNote: string;
}

/** The eight dimensions, in the Index's published order. */
export const READINESS_INDEX_DIMENSIONS: readonly IndexDimension[] = [
  {
    id: 'automation-sprawl',
    title: 'Automation sprawl',
    measures: 'Overlapping Flows; legacy Process Builder / Workflow Rules still live',
    checks: [
      { source: 'audit', id: 'inactive-flows' },
      { source: 'audit', id: 'inactive-workflows' },
      { source: 'audit', id: 'inactive-validations' },
      { source: 'monitor', id: 'flow-errors' },
    ],
    manualNote:
      'Overlapping record-triggered automation: run `sfdt flow conflicts`, and review which objects mix Flow, Apex triggers and Workflow.',
  },
  {
    id: 'dependency-risk',
    title: 'Dependency risk',
    measures: 'What breaks if you change X; hardcoded IDs; fragile integrations',
    checks: [
      { source: 'audit', id: 'apex-unreferenced' },
      { source: 'audit', id: 'connected-apps' },
      { source: 'monitor', id: 'limits' },
      { source: 'live', id: 'org-limits', supersededBy: { source: 'monitor', id: 'limits' } },
    ],
    manualNote:
      'Hardcoded IDs and URLs: run `sfdt flow scan` (HARD_CODED_ID / HARD_CODED_URL) and `sfdt dependencies <component> --gaps` on the components the business depends on. Integration fragility needs an owner interview.',
  },
  {
    id: 'documentation-coverage',
    title: 'Documentation coverage',
    measures: 'Undocumented logic; tribal knowledge; succession risk',
    checks: [{ source: 'audit', id: 'field-descriptions' }],
    manualNote:
      'Undocumented logic and tribal knowledge are not visible in metadata. Ask who can explain each critical process, and whether they could leave tomorrow.',
  },
  {
    id: 'permissions-hygiene',
    title: 'Permissions hygiene',
    measures: 'View All / Modify All sprawl; over-broad profiles',
    checks: [
      { source: 'audit', id: 'lint-access' },
      { source: 'audit', id: 'lint-access-fields' },
      { source: 'audit', id: 'unused-permsets' },
      { source: 'audit', id: 'mfa' },
      { source: 'audit', id: 'mfa-readiness' },
      { source: 'audit', id: 'inactive-users' },
      { source: 'audit', id: 'licenses' },
      { source: 'audit', id: 'audittrail' },
      { source: 'monitor', id: 'health' },
      { source: 'live', id: 'inactive-users', supersededBy: { source: 'audit', id: 'inactive-users' } },
      { source: 'live', id: 'license-utilisation', supersededBy: { source: 'audit', id: 'licenses' } },
    ],
    manualNote: 'Profile-by-profile breadth: run `sfdt permissions matrix` for the full grant grid.',
  },
  {
    id: 'dead-metadata',
    title: 'Dead metadata',
    measures: 'Unused fields, obsolete code, deprecated APIs',
    checks: [
      { source: 'audit', id: 'unused-apex' },
      { source: 'audit', id: 'api-versions' },
      { source: 'audit', id: 'soap-logins' },
      { source: 'monitor', id: 'deprecated-api' },
      { source: 'live', id: 'apex-api-version', supersededBy: { source: 'audit', id: 'api-versions' } },
    ],
    manualNote: 'Unused fields: run `sfdt field usage` against the objects the business says matter most.',
  },
  {
    id: 'data-quality',
    title: 'Data quality',
    measures: 'Duplicates, incomplete records, inconsistent free-text',
    checks: [],
    manualNote:
      'Not measured by sfdt. Sample the core objects by hand: duplicate rates, required-in-practice fields left blank, free-text where a picklist belongs.',
  },
  {
    id: 'change-safety',
    title: 'Change safety',
    measures: 'Test coverage, rollback strategy, sandbox discipline',
    checks: [
      { source: 'live', id: 'apex-coverage' },
      { source: 'monitor', id: 'deploy-history' },
      { source: 'monitor', id: 'errors' },
    ],
    manualNote:
      'Per-class coverage: `sfdt coverage`. Rollback strategy and sandbox discipline are process questions — ask how the last bad deploy was reversed.',
  },
  {
    id: 'ai-groundability',
    title: 'AI-groundability',
    measures: 'Is the metadata clean enough for agents to be grounded on good data?',
    checks: [{ source: 'audit', id: 'field-descriptions' }],
    manualNote:
      'Agents read field descriptions and run in user mode: run `sfdt quality --api67` for user-mode readiness, and review the data an agent would be grounded on against the Data quality findings.',
  },
];

/**
 * Checks that are context for the assessment rather than evidence for a
 * dimension. Listed so they are not reported as unmapped.
 */
export const READINESS_INDEX_CONTEXT_CHECKS: readonly { source: IndexSource; id: string }[] = [
  { source: 'monitor', id: 'org-info' },
  { source: 'monitor', id: 'backup' },
];

/** A check as any surface produces it. Live checks carry a Band status. */
export interface IndexCheckInput {
  id: string;
  title?: string;
  status: string;
  summary?: string;
  findings?: unknown[];
}

export interface IndexSnapshotInput {
  org?: string;
  timestamp?: string;
  checks?: IndexCheckInput[];
}

export interface IndexEvidenceCheck {
  source: IndexSource;
  id: string;
  title: string;
  status: IndexCheckStatus;
  summary: string;
  findings: unknown[];
}

export interface IndexEvidenceDimension {
  id: string;
  title: string;
  measures: string;
  status: IndexDimensionStatus;
  checks: IndexEvidenceCheck[];
  /** Check refs under this dimension that produced no data (not run / no snapshot). */
  missing: { source: IndexSource; id: string }[];
  manualNote: string;
}

export interface IndexEvidence {
  org: string | null;
  /** Newest snapshot timestamp among the inputs, if any carried one. */
  timestamp: string | null;
  dimensions: IndexEvidenceDimension[];
  context: IndexEvidenceCheck[];
  /** Checks present in the input that no dimension or context entry claims. */
  unmapped: IndexEvidenceCheck[];
}

const RANK: Record<IndexCheckStatus, number> = { ok: 0, warn: 1, error: 2, fail: 3 };

/** Live checks report a Band; the Index speaks the CLI's status vocabulary. */
export function bandToStatus(band: Band | string): IndexCheckStatus {
  if (band === 'green') return 'ok';
  if (band === 'amber') return 'warn';
  if (band === 'red') return 'fail';
  return 'error';
}

function normaliseStatus(source: IndexSource, status: string): IndexCheckStatus {
  if (source === 'live') return bandToStatus(status);
  return status === 'ok' || status === 'warn' || status === 'error' || status === 'fail' ? status : 'error';
}

/** Worst status among checks (ok < warn < error < fail), or `none` for an empty list. */
export function worstIndexStatus(checks: readonly { status: IndexCheckStatus }[]): IndexDimensionStatus {
  if (checks.length === 0) return 'none';
  return checks.reduce<IndexCheckStatus>(
    (worst, c) => (RANK[c.status] > RANK[worst] ? c.status : worst),
    'ok',
  );
}

function toEvidence(source: IndexSource, c: IndexCheckInput): IndexEvidenceCheck {
  return {
    source,
    id: String(c.id ?? ''),
    title: String(c.title ?? c.id ?? 'Check'),
    status: normaliseStatus(source, String(c.status ?? '')),
    summary: String(c.summary ?? ''),
    findings: Array.isArray(c.findings) ? c.findings : [],
  };
}

const key = (source: IndexSource, id: string): string => `${source}:${id}`;

/**
 * Group check results under the Index dimensions.
 *
 * Any input may be null/absent — the Chrome panel always has `live`, and has
 * `audit`/`monitor` only when the bridge answers; the CLI has the reverse.
 */
export function buildIndexEvidence(input: {
  audit?: IndexSnapshotInput | null;
  monitor?: IndexSnapshotInput | null;
  live?: IndexCheckInput[] | null;
}): IndexEvidence {
  const byKey = new Map<string, IndexEvidenceCheck>();
  const add = (source: IndexSource, checks: IndexCheckInput[] | undefined | null): void => {
    if (!Array.isArray(checks)) return;
    for (const c of checks) {
      const ev = toEvidence(source, c);
      if (ev.id) byKey.set(key(source, ev.id), ev);
    }
  };
  add('audit', input.audit?.checks);
  add('monitor', input.monitor?.checks);
  add('live', input.live);

  const claimed = new Set<string>();
  const dimensions = READINESS_INDEX_DIMENSIONS.map((dim): IndexEvidenceDimension => {
    const checks: IndexEvidenceCheck[] = [];
    const missing: { source: IndexSource; id: string }[] = [];
    for (const ref of dim.checks) {
      const k = key(ref.source, ref.id);
      claimed.add(k);
      // The deeper CLI check wins: skip a live check when its CLI twin ran.
      if (ref.supersededBy && byKey.has(key(ref.supersededBy.source, ref.supersededBy.id))) continue;
      const ev = byKey.get(k);
      if (ev) checks.push(ev);
      else if (!ref.supersededBy) missing.push({ source: ref.source, id: ref.id });
    }
    return {
      id: dim.id,
      title: dim.title,
      measures: dim.measures,
      status: worstIndexStatus(checks),
      checks,
      missing,
      manualNote: dim.manualNote,
    };
  });

  const context: IndexEvidenceCheck[] = [];
  for (const ref of READINESS_INDEX_CONTEXT_CHECKS) {
    const k = key(ref.source, ref.id);
    claimed.add(k);
    const ev = byKey.get(k);
    if (ev) context.push(ev);
  }

  const unmapped = [...byKey.entries()].filter(([k]) => !claimed.has(k)).map(([, ev]) => ev);

  const org = input.audit?.org ?? input.monitor?.org ?? null;
  const stamps = [input.audit?.timestamp, input.monitor?.timestamp].filter(
    (t): t is string => typeof t === 'string' && t.length > 0,
  );
  const timestamp = stamps.length ? stamps.sort().at(-1) ?? null : null;

  return { org, timestamp, dimensions, context, unmapped };
}

const STATUS_LABEL: Record<IndexDimensionStatus, string> = {
  ok: 'OK',
  warn: 'WARN',
  error: 'ERROR',
  fail: 'FAIL',
  none: 'NO DATA',
};

function findingLine(f: unknown): string {
  if (f && typeof f === 'object') return describeFinding(f as Record<string, unknown>);
  return String(f ?? '');
}

/**
 * Markdown evidence pack for pasting into an assessment write-up. Findings are
 * capped per check so a 2,000-row inactive-user list can't bury the document.
 */
export function renderIndexMarkdown(evidence: IndexEvidence, { maxFindings = 10 } = {}): string {
  const lines: string[] = [];
  lines.push('# AI-Readiness Index — evidence pack');
  lines.push('');
  if (evidence.org) lines.push(`- Org: ${evidence.org}`);
  if (evidence.timestamp) lines.push(`- Snapshot: ${evidence.timestamp}`);
  lines.push('- Status per dimension is the worst check under it. It is evidence for the assessor, not a score.');
  lines.push('');
  for (const dim of evidence.dimensions) {
    lines.push(`## ${dim.title} — ${STATUS_LABEL[dim.status]}`);
    lines.push('');
    lines.push(`_${dim.measures}_`);
    lines.push('');
    if (dim.checks.length === 0) lines.push('- No automated evidence.');
    for (const c of dim.checks) {
      lines.push(`- **${c.title}** (${c.status}) — ${c.summary}`);
      for (const f of c.findings.slice(0, maxFindings)) lines.push(`  - ${findingLine(f)}`);
      if (c.findings.length > maxFindings) lines.push(`  - … and ${c.findings.length - maxFindings} more`);
    }
    if (dim.missing.length) {
      lines.push(`- Not run: ${dim.missing.map((m) => `${m.source} ${m.id}`).join(', ')}`);
    }
    lines.push(`- Assessor: ${dim.manualNote}`);
    lines.push('');
  }
  if (evidence.context.length) {
    lines.push('## Context');
    lines.push('');
    for (const c of evidence.context) lines.push(`- **${c.title}** — ${c.summary}`);
    lines.push('');
  }
  if (evidence.unmapped.length) {
    lines.push('## Other checks');
    lines.push('');
    for (const c of evidence.unmapped) lines.push(`- **${c.title}** (${c.status}) — ${c.summary}`);
    lines.push('');
  }
  return lines.join('\n');
}
