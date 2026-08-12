/**
 * record-verdict — persist a Conductor VERDICT block as a run-history row.
 *
 * Reads a verdict block (CONVENTIONS.md §5 / conductor-verifier output format)
 * from stdin or --file, parses phase / verdict / criteria, and records a
 * `verdict` run. On the THIRD consecutive FAIL for the same phase it also
 * records an `escalation` run (category from --category) so a stuck phase
 * surfaces in telemetry instead of looping silently.
 *
 * Every row is written twice: to the local run-history db (queryable via
 * `sfdt history`) and appended to a tracked JSONL telemetry file. The db is
 * gitignored and machine-local, so it never reaches CI — the JSONL is what the
 * weekly harness-improver mines in GitHub Actions. Commit it with your work.
 *
 * Recording is best-effort (recordRun never throws); parse failures exit 1.
 *
 * Usage:
 *   node tools/record-verdict.mjs [--file <path>] [--log-dir <dir>] [--category <slug>] [--json]
 *   sfdt-verifier | node tools/record-verdict.mjs --category flaky-tests
 *
 * Verdict block shape (only VERDICT is required):
 *   VERDICT: PASS | FAIL | BLOCKED
 *   PHASE: <phase name/number>
 *   CRITERIA:
 *     - [PASS|FAIL] <criterion> — <evidence>
 */

import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { recordRun, queryRuns } from '../src/lib/run-history.js';
import { mirrorHarnessRow } from '../src/lib/harness-telemetry.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f, d) => (args.includes(f) ? args[args.indexOf(f) + 1] : d);

if (flag('--help') || flag('-h')) {
  console.log(
    `record-verdict — persist a Conductor VERDICT block to run-history.

Usage:
  node tools/record-verdict.mjs [options]

Options:
  --file <path>      Read the verdict block from a file (default: stdin).
  --log-dir <dir>    run-history location (default: <cwd>/logs).
  --category <slug>  Escalation category, used only when a 3rd consecutive
                     FAIL for the same phase triggers an escalation row.
  --telemetry <path> Tracked JSONL mirror of the rows, mined by the weekly
                     harness-improver in CI (default: <repo>/.harness/telemetry.jsonl).
                     Verdict rows are REDACTED here — verbatim criterion text is
                     replaced by a count, because this file ships in a public repo.
  --private-telemetry <path>
                     JSONL mirror that keeps the full criterion text
                     (default: <repo>/.work/telemetry.jsonl). Written only when
                     its directory already exists, so machines and CI runners
                     without a .work checkout are left alone.
  --json             Emit the recorded row(s) as JSON.
  -h, --help         Show this help.

Records a row of type 'verdict'. On the third consecutive FAIL for the same
phase, also records a row of type 'escalation'.`,
  );
  process.exit(0);
}

const logDir = opt('--log-dir', path.join(process.cwd(), 'logs'));
const category = opt('--category', 'uncategorized');
const telemetryPath = opt('--telemetry', path.join(REPO_ROOT, '.harness', 'telemetry.jsonl'));
const privateTelemetryPath = opt(
  '--private-telemetry',
  path.join(REPO_ROOT, '.work', 'telemetry.jsonl'),
);

// Mirroring lives in src/lib/harness-telemetry.js so this tool and the
// agent-fix path in agent-loop.js write the JSONL through one implementation —
// including the public/private split and its redaction.
const mirror = (row) => mirrorHarnessRow(row, { telemetryPath, privateTelemetryPath });

// --- read the block ---
const file = opt('--file', null);
let raw;
try {
  raw = file ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8');
} catch (e) {
  console.error(`record-verdict: cannot read ${file ? file : 'stdin'}: ${e.message}`);
  process.exit(1);
}

// --- parse (CONVENTIONS §5) ---
const vm = raw.match(/^VERDICT:\s*(PASS|FAIL|BLOCKED)\b/im);
if (!vm) {
  console.error('record-verdict: no `VERDICT: PASS|FAIL|BLOCKED` line found in input');
  process.exit(1);
}
const verdict = vm[1].toUpperCase();
const pm = raw.match(/^PHASE:\s*(.+?)\s*$/im);
const phase = pm ? pm[1].trim() : 'unknown';
const criteria = [];
for (const m of raw.matchAll(/^\s*-\s*\[(PASS|FAIL)\]\s*(.+?)\s*$/gim)) {
  criteria.push({ status: m[1].toUpperCase(), text: m[2].trim() });
}

// --- how many of the most recent verdicts for this phase were FAIL (before
//     this one)? query first so this FAIL can be the third in a row. ---
let priorFails = 0;
for (const row of queryRuns(logDir, { type: 'verdict' }).filter((r) => r.summary?.phase === phase)) {
  if (row.status === 'fail') priorFails++; // rows are newest-first
  else break;
}

const recorded = [];

// Rows are built once and written twice — same shape in the db and the JSONL,
// so the improver mines an identical structure whichever source it reads.
const verdictRow = {
  type: 'verdict',
  timestamp: new Date().toISOString(),
  status: verdict.toLowerCase(),
  summary: { phase, verdict, criteria },
};
await recordRun(logDir, verdictRow);
mirror(verdictRow);
recorded.push({ type: 'verdict', phase, verdict });

// Third consecutive FAIL for this phase (2 prior + this one) → escalate once.
const consecutive = verdict === 'FAIL' ? priorFails + 1 : 0;
if (consecutive === 3) {
  const escalationRow = {
    type: 'escalation',
    timestamp: new Date().toISOString(),
    status: 'fail',
    summary: { phase, category, consecutiveFails: consecutive },
  };
  await recordRun(logDir, escalationRow);
  mirror(escalationRow);
  recorded.push({ type: 'escalation', phase, category, consecutiveFails: consecutive });
}

if (flag('--json')) {
  console.log(JSON.stringify({ recorded }, null, 2));
} else {
  console.log(`recorded verdict: ${verdict} · phase '${phase}' · ${criteria.length} criteria`);
  if (consecutive === 3) console.log(`escalation: 3 consecutive FAILs · category '${category}'`);
}
