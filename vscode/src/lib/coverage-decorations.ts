/**
 * Pure logic behind the "SFDT: Toggle Coverage Highlights" command: validate
 * the `sfdt coverage --json` result, match open Apex files to coverage rows
 * by class/trigger name, and pick the coverage band + label for the editor
 * decoration. Banding thresholds come from `@sfdt/flow-core`
 * `classCoverageBand` — the same bands the CLI, GUI, and Chrome extension use.
 *
 * Deliberately free of any `vscode` import so it is unit-testable; the
 * extension layer turns the returned plan into TextEditorDecorationTypes.
 */

import { classCoverageBand, type ClassCoverageBand } from '@sfdt/flow-core';

/** One per-class row from the coverage result (`pct` is a 0–1 fraction). */
export interface CoverageClassRow {
  name: string;
  pct: number | null;
}

/**
 * Extract the per-class rows from an `sfdt coverage --json` result
 * (`{ org, threshold, orgWide, belowThreshold, classes: [{ name, pct, … }] }`
 * — see src/commands/coverage.js). Returns null when the payload doesn't look
 * like a coverage result; rows without a usable name are dropped.
 */
export function coverageRowsFromResult(result: unknown): CoverageClassRow[] | null {
  const r = result as { classes?: unknown } | null;
  if (!r || typeof r !== 'object' || !Array.isArray(r.classes)) return null;
  const rows: CoverageClassRow[] = [];
  for (const entry of r.classes) {
    if (!entry || typeof entry !== 'object') continue;
    const { name, pct } = entry as { name?: unknown; pct?: unknown };
    if (typeof name !== 'string' || name.length === 0) continue;
    rows.push({ name, pct: typeof pct === 'number' && Number.isFinite(pct) ? pct : null });
  }
  return rows;
}

/**
 * Derive the Apex component name from a file path: `Foo.cls` / `Foo.trigger`
 * → `Foo` (coverage rows cover both — ApexCodeCoverageAggregate reports
 * `ApexClassOrTrigger.Name`). Non-Apex files return null. Handles both POSIX
 * and Windows separators regardless of the host platform.
 */
export function apexNameFromPath(fsPath: string): string | null {
  const base = fsPath.split(/[\\/]/).pop() ?? '';
  const match = base.match(/^(.+)\.(cls|trigger)$/i);
  return match ? match[1] : null;
}

/** Everything the extension needs to decorate one Apex editor. */
export interface CoverageDecorationPlan {
  className: string;
  /** 0–1 fraction, or null when the class has no coverable lines. */
  pct: number | null;
  band: ClassCoverageBand;
  /** Human-readable label for the inline annotation / hover. */
  label: string;
}

/**
 * Match a file to its coverage row (Apex names are case-insensitive) and pick
 * the band. Null when the file is not Apex or the org reports no row for it
 * (e.g. a brand-new class that has never been touched by a test run).
 */
export function planCoverageDecoration(
  fsPath: string,
  rows: CoverageClassRow[],
): CoverageDecorationPlan | null {
  const name = apexNameFromPath(fsPath);
  if (!name) return null;
  const lower = name.toLowerCase();
  const row = rows.find((r) => r.name.toLowerCase() === lower);
  if (!row) return null;
  const band = classCoverageBand(row.pct);
  const label =
    row.pct === null
      ? `Apex coverage: ${row.name} — no coverable lines`
      : `Apex coverage: ${row.name} — ${Math.round(row.pct * 100)}% covered`;
  return { className: row.name, pct: row.pct, band, label };
}

/**
 * Colors per band for the editor decoration: `color` drives the gutter border,
 * overview-ruler stripe, and inline label; `background` is a low-alpha wash
 * over the file so the banding stays subtle in both light and dark themes.
 */
export const COVERAGE_BAND_STYLE: Record<ClassCoverageBand, { color: string; background: string }> = {
  green: { color: 'rgba(63, 185, 80, 0.75)', background: 'rgba(63, 185, 80, 0.045)' },
  amber: { color: 'rgba(210, 153, 34, 0.75)', background: 'rgba(210, 153, 34, 0.055)' },
  red: { color: 'rgba(248, 81, 73, 0.75)', background: 'rgba(248, 81, 73, 0.06)' },
  none: { color: 'rgba(139, 148, 158, 0.65)', background: 'rgba(139, 148, 158, 0.045)' },
};
