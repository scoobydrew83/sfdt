import path from 'path';
import { appendFileSync, mkdirSync } from 'fs';

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
