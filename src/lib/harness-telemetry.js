import path from 'path';
import { appendFileSync, mkdirSync, existsSync } from 'fs';

/**
 * Append a run-history row to the tracked harness telemetry JSONL.
 *
 * The run-history db is gitignored and machine-local, so it never reaches a CI
 * runner. This JSONL is the copy the weekly harness-improver mines in GitHub
 * Actions, and it is committed alongside the work that produced it.
 *
 * Opt-in by design, via an explicit path. `runFixLoop` is shipped CLI code that
 * runs against other people's projects: mirroring unconditionally would write
 * into the installed package directory (unwritable on a global install) and
 * would pull end users' org names and failure trends into a file destined for a
 * public repo. No path, no write.
 *
 * Best-effort, like recordRun — telemetry is advisory, the db row is the record
 * of truth, and measurement must never break the measured (golden principle #5).
 *
 * ponytail: append-only, no rotation; add a prune if the file ever outgrows a
 * reviewable diff.
 *
 * @param {object} row - run-history row: `{ type, timestamp, status, summary }`.
 * @param {string|null|undefined} telemetryPath - destination JSONL; falsy disables.
 * @returns {boolean} true when a line was appended.
 */
export function mirrorTelemetry(row, telemetryPath) {
  if (!telemetryPath) return false;
  try {
    mkdirSync(path.dirname(telemetryPath), { recursive: true });
    appendFileSync(telemetryPath, JSON.stringify(row) + '\n');
    return true;
  } catch {
    return false;
  }
}

/**
 * Strip verbatim criterion text from a row bound for the public JSONL.
 *
 * A verdict's `criteria` carry the sentences written in the VERDICT block, and
 * the tracked JSONL is committed to a public repo — so the text stays in the
 * private mirror and only its count crosses over. The improver still sees that
 * a verdict happened, its phase and its status, so clustering by phase and by
 * escalation category survives. Rows without `criteria` (escalation, agent-fix)
 * have no free text and pass through untouched.
 *
 * @param {object} row - run-history row.
 * @returns {object} the row, or a copy with `criteria` replaced by `criteriaCount`.
 */
export function redactForPublic(row) {
  const criteria = row.summary?.criteria;
  if (!Array.isArray(criteria)) return row;
  const { criteria: _dropped, ...summary } = row.summary;
  return { ...row, summary: { ...summary, criteriaCount: criteria.length } };
}

/**
 * Write one row to both harness mirrors: full text privately, redacted publicly.
 *
 * `privateTelemetryPath` points into a separate private repo's checkout, so it
 * is existence-gated rather than created. mirrorTelemetry mkdir -p's its
 * destination — right for the tracked public file, but it would conjure an
 * empty directory on any clone or CI runner that has no such checkout.
 *
 * @param {object} row - run-history row.
 * @param {{telemetryPath?: string|null, privateTelemetryPath?: string|null}} paths
 * @returns {{public: boolean, private: boolean}} which mirrors received a line.
 */
export function mirrorHarnessRow(row, { telemetryPath, privateTelemetryPath } = {}) {
  const wrotePrivate =
    Boolean(privateTelemetryPath) && existsSync(path.dirname(privateTelemetryPath))
      ? mirrorTelemetry(row, privateTelemetryPath)
      : false;
  return { public: mirrorTelemetry(redactForPublic(row), telemetryPath), private: wrotePrivate };
}
