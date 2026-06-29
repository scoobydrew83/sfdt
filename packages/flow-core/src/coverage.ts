// Shared, browser-safe per-class Apex coverage logic. Pure — used by the Chrome
// `apex-coverage` viewer, the GUI Coverage page, and the `sfdt coverage` CLI
// command, so all three band classes identically. (Org-WIDE coverage banding
// lives in org-health-checks.ts as `coverageBand`.)

export type ClassCoverageBand = 'green' | 'amber' | 'red' | 'none';

/** Raw row from `ApexCodeCoverageAggregate` (Tooling API). */
export interface RawClassCoverageRow {
  ApexClassOrTrigger?: { Name?: string } | null;
  NumLinesCovered?: number | null;
  NumLinesUncovered?: number | null;
}

export interface ClassCoverageRow {
  name: string;
  covered: number;
  uncovered: number;
  total: number;
  /** Fraction 0..1; null when the component has no executable lines. */
  pct: number | null;
}

/** Salesforce requires 75% org-wide to deploy, so red = a class below that line. */
export function classCoverageBand(pct: number | null): ClassCoverageBand {
  if (pct === null) return 'none';
  if (pct >= 0.9) return 'green';
  if (pct >= 0.75) return 'amber';
  return 'red';
}

/** Shape raw aggregate rows into sorted, displayable coverage rows (worst first). */
export function shapeClassCoverage(records: RawClassCoverageRow[]): ClassCoverageRow[] {
  const rows: ClassCoverageRow[] = records.map((r) => {
    const covered = Math.max(0, r.NumLinesCovered ?? 0);
    const uncovered = Math.max(0, r.NumLinesUncovered ?? 0);
    const total = covered + uncovered;
    return {
      name: r.ApexClassOrTrigger?.Name ?? '(unknown)',
      covered,
      uncovered,
      total,
      pct: total > 0 ? covered / total : null,
    };
  });
  // Worst coverage first (most actionable); no-line rows last; then by name.
  rows.sort((a, b) => {
    if (a.pct === null && b.pct === null) return a.name.localeCompare(b.name);
    if (a.pct === null) return 1;
    if (b.pct === null) return -1;
    return a.pct - b.pct || a.name.localeCompare(b.name);
  });
  return rows;
}
