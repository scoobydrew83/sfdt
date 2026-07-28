/**
 * FEATURES.json contract check (L3 enforcement — see CONDUCTOR-HARNESS-V5 Part 2).
 *
 * Two rules, both reported as remediation instructions a fresh agent can act on:
 *  1. STRUCTURE — every feature entry declares id/category/description/steps/
 *     passes/evidence, and evidence is non-null wherever passes is true.
 *  2. EDIT SCOPE — when this branch/worktree has diverged from the default
 *     branch, the only FEATURES.json lines it may change are "passes"/"evidence".
 *     Editing a locked field (id/category/description/steps/source) or
 *     adding/removing an entry is a planner/human job, never a verifier run.
 *
 * The rules live in docs/golden-principles.md; error text quotes them so the
 * message alone tells you how to fix the violation. Dumb-by-design: everything
 * here is a JSON assertion or a git-diff scan a human can rerun in ten seconds.
 *
 * Exits 1 with a remediation list on any violation.
 */

import path from 'path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FEATURES = path.join(ROOT, 'FEATURES.json');
const GP = 'docs/golden-principles.md';
const violations = [];

// ── Rule 1: structure ──────────────────────────────────────────────────────
let data;
try {
  data = JSON.parse(fs.readFileSync(FEATURES, 'utf-8'));
} catch (e) {
  console.error(`FEATURES.json is not valid JSON: ${e.message}`);
  console.error(`  Fix: repair the JSON so it parses, then rerun \`npm run check:features\`.`);
  process.exit(1);
}

if (!Array.isArray(data.features)) {
  console.error(`FEATURES.json has no "features" array.`);
  console.error(`  Rule: FEATURES.json holds a top-level "features": [ ... ] list of graded entries (${GP}).`);
  console.error(`  Fix: add the "features" array, then rerun \`npm run check:features\`.`);
  process.exit(1);
}

// field -> (value) => ok?
const REQUIRED = {
  id: (v) => typeof v === 'string' && v.length > 0,
  category: (v) => typeof v === 'string' && v.length > 0,
  description: (v) => typeof v === 'string' && v.length > 0,
  steps: (v) => Array.isArray(v) && v.length > 0,
  passes: (v) => typeof v === 'boolean',
  evidence: (v) => v === null || typeof v === 'string',
};

data.features.forEach((entry, i) => {
  const id = typeof entry.id === 'string' ? entry.id : `#${i}`;
  for (const [field, ok] of Object.entries(REQUIRED)) {
    if (!ok(entry[field])) {
      violations.push(
        `entry "${id}" — field "${field}" is missing or the wrong shape.\n` +
        `    Rule: every feature entry must declare id, category, description, steps, passes, evidence\n` +
        `          (${GP} — "FEATURES.json is graded as JSON, not prose").\n` +
        `    Wrong:  { "id": "${id}", "passes": false }\n` +
        `    Right:  { "id": "${id}", "category": "<area>", "description": "<what must be true>",\n` +
        `              "steps": ["<a deterministic check a human can rerun>"], "passes": false, "evidence": null }\n` +
        `    Fix: give "${id}" a valid "${field}", then rerun \`npm run check:features\`.`,
      );
    }
  }
  // Coupling: a passing feature must cite evidence.
  if (entry.passes === true && (entry.evidence === null || entry.evidence === undefined || entry.evidence === '')) {
    violations.push(
      `entry "${id}" — passes:true but evidence is empty.\n` +
      `    Rule: a passing feature must cite dated, re-checkable evidence — a command output or a path,\n` +
      `          never "done" (${GP} — "Evidence is dated and re-checkable").\n` +
      `    Wrong:  "passes": true,  "evidence": null\n` +
      `    Right:  "passes": true,  "evidence": "2026-07-24: \`grep -rq 'sf scanner run' scripts/\` → no match"\n` +
      `    Fix: set "${id}".evidence to how you verified it, or flip passes back to false if you cannot reproduce the check.`,
    );
  }
});

// ── Rule 2: edit scope (only when diverged from the default branch) ─────────
function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf-8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function baseCandidates() {
  const names = ['develop', 'main', 'master'];
  const head = git(['rev-parse', '--abbrev-ref', 'origin/HEAD']); // e.g. "origin/main"
  if (head) names.unshift(head.replace(/^origin\//, ''));
  return [...new Set(names)].filter((b) => git(['rev-parse', '--verify', '--quiet', b]) !== null);
}

// The fork point is the merge-base CLOSEST to HEAD, not the merge-base with
// whatever `origin/HEAD` happens to name. In a develop -> main gitflow
// `origin/HEAD` is main, but work forks from develop — and merge-base(HEAD, main)
// sits back at the last release merge, so every develop commit since then
// replays as if this branch had added it. That made the whole of FEATURES.json
// (added to develop after the last promotion) read as one giant addition and
// tripped Rule 2 on every branch, develop included.
function forkPoint() {
  let best = null;
  for (const b of baseCandidates()) {
    const mb = git(['merge-base', 'HEAD', b]);
    if (!mb) continue;
    const when = Number(git(['show', '-s', '--format=%ct', mb]) || 0);
    if (!best || when > best.when) best = { mb, when };
  }
  return best?.mb ?? null;
}

const inRepo = git(['rev-parse', '--is-inside-work-tree']) === 'true';
// Compare the fork point to the working tree — captures both this branch's
// commits and uncommitted edits. On the integration branch itself the fork
// point IS HEAD, so the diff is empty and only the structure rules apply.
const mergeBase = inRepo ? forkPoint() : null;
const diff = mergeBase ? git(['diff', '--no-color', '-U0', mergeBase, '--', 'FEATURES.json']) : null;

if (diff) {
  const allowed = /^\s*"(passes|evidence)"\s*:/;
  const locked = /^\s*"(id|category|description|steps|source)"\s*:/;
  for (const raw of diff.split('\n')) {
    if (!/^[+-]/.test(raw) || /^(\+\+\+|---)/.test(raw)) continue; // skip file headers
    const content = raw.slice(1);
    if (allowed.test(content)) continue; // passes/evidence changes are fine
    if (content.trim() === '') continue; // pure whitespace add/remove
    // ponytail: skip brace/bracket-only lines — they're reformat/EOF-newline
    // noise, never a real edit. An added/removed ENTRY still trips this check
    // via its "id"/"description"/… key lines below, so nothing slips through.
    if (/^[{}[\],\s]+$/.test(content)) continue;
    const m = content.match(locked);
    if (m) {
      violations.push(
        `FEATURES.json — this branch edited a locked field:\n` +
        `      ${raw}\n` +
        `    Rule: the checker may flip only "passes" and "evidence"; id/category/description/steps/source\n` +
        `          change only by a planner or human commit\n` +
        `          (${GP} — "The checker is the only writer, and only of passes/evidence").\n` +
        `    Fix: revert the edit to "${m[1]}". If a feature's definition genuinely needs to change, make that\n` +
        `         change in a separate planner/human commit — not as part of a verifier run.`,
      );
    } else {
      violations.push(
        `FEATURES.json — this branch changed a line that is neither "passes" nor "evidence":\n` +
        `      ${raw}\n` +
        `    Rule: a verifier run may touch only passes/evidence; adding or removing entries is a\n` +
        `          planner/human job (${GP} — "entries are added/removed only by planner/human commit").\n` +
        `    Fix: if you are the verifier, revert this line and change only passes/evidence. If you are the\n` +
        `         planner adding or removing an entry, land it in its own commit so the diff carries nothing else.`,
      );
    }
  }
}

if (violations.length) {
  console.error('FEATURES.json contract violations:');
  for (const v of violations) console.error(`  - ${v}\n`);
  process.exit(1);
}
const scope = diff ? 'structure + edit-scope' : 'structure';
console.log(`FEATURES.json OK (${data.features.length} entries, ${scope} checked).`);
