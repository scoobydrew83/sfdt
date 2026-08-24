import path from 'path';
import fs from 'fs-extra';
import { createHash, randomUUID } from 'node:crypto';
import { redactSensitiveData } from './audit-logger.js';

/**
 * The change ledger — an append-only, hash-chained record of every org
 * configuration change this CLI makes, with the state that preceded it.
 *
 * ---------------------------------------------------------------------------
 * Why this is not run-history and not audit.json
 * ---------------------------------------------------------------------------
 * Neither existing store is append-only:
 *
 *   - `run-history.js` DELETEs all but the newest 200 rows per type on every
 *     insert, and records only counts ({ok, warn, fail}) — no state at all.
 *   - `audit-logger.js` reads its whole JSON array, unshifts, truncates at 1000
 *     and rewrites the file. Two concurrent writers lose entries, and any past
 *     entry can be silently altered by the next write.
 *
 * Both are the right shape for what they do. Neither can answer "what exactly
 * did this change, and what was there before?" — which is the only question
 * that makes a change reversible.
 *
 * ---------------------------------------------------------------------------
 * A deliberate exception to golden principle #5
 * ---------------------------------------------------------------------------
 * Principle #5 says telemetry never throws: anything writing history degrades
 * silently so measurement cannot break the measured. This module is the one
 * carve-out, and it is carved deliberately: **if the before-state cannot be
 * recorded, the org write must not happen.** An unrecorded change is an
 * unreversible one, and silently proceeding would hand the user a changed org
 * with no way back — a far worse failure than an aborted command. So
 * `recordIntent` throws, and every caller is expected to let it.
 *
 * ---------------------------------------------------------------------------
 * Two entries per change, on purpose
 * ---------------------------------------------------------------------------
 * The before-state has to be durable BEFORE the write is attempted, but the
 * outcome is only known after. So a change is:
 *
 *   1. `recordIntent()`  → a `pending` entry carrying `before` and the intended
 *                          `after`. Throws ⇒ the caller aborts and nothing is
 *                          touched.
 *   2. the org write
 *   3. `recordOutcome()` → an `outcome` entry saying applied or failed.
 *
 * A crash between 1 and 3 leaves a visible `pending` entry. That is
 * information — "something may have been half-done here" — not corruption, and
 * it is exactly what a single after-the-fact log cannot tell you.
 *
 * ---------------------------------------------------------------------------
 * Nothing is ever mutated
 * ---------------------------------------------------------------------------
 * Undo does not flip a flag on the original entry — that would rewrite history
 * and break the hash chain. It appends its own entry pointing back at what it
 * undid, and "is this undone?" is derived by reading forward. The file is only
 * ever opened for append.
 */

export const LEDGER_FILE = 'ledger.jsonl';

/** Bumped only if the on-disk entry shape changes incompatibly. */
export const LEDGER_FORMAT_VERSION = 1;

function ledgerPath(logDir) {
  return path.join(logDir, LEDGER_FILE);
}

/**
 * Deterministic JSON for hashing.
 *
 * `JSON.stringify` preserves insertion order, so two structurally identical
 * entries built in different orders would hash differently and the chain would
 * appear broken. Keys are sorted at every depth instead.
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/**
 * The hash of one entry, covering its content AND the previous entry's hash.
 *
 * Chaining is what makes tampering detectable: editing or deleting any line
 * changes that line's hash, which no longer matches the `prevHash` the next
 * line recorded, and every entry after it is invalidated too.
 */
export function hashEntry(entry) {
  const { hash: _ignored, ...content } = entry;
  return createHash('sha256').update(canonicalJson(content)).digest('hex');
}

// --------------------------------------------------------------------------
// Reverser registry
// --------------------------------------------------------------------------
//
// This module must not know what a permission or a flow is. Each writing
// feature registers a function that knows how to put its own `before` back, and
// `undoChange` looks it up by kind. A kind with no registered reverser is
// reported as not automatically reversible, with its before-state printed, so
// it can be restored by hand — never silently skipped.

const reversers = new Map();

/**
 * @param {string} kind
 * @param {(before: unknown, entry: object, ctx: object) => Promise<unknown>} fn
 */
export function registerReverser(kind, fn) {
  reversers.set(kind, fn);
}

export function hasReverser(kind) {
  return reversers.has(kind);
}

/** Test seam — clears the registry so suites do not leak into each other. */
export function _resetReversersForTests() {
  reversers.clear();
}

// --------------------------------------------------------------------------
// Reading
// --------------------------------------------------------------------------

/**
 * Read every entry.
 *
 * A malformed line is NOT skipped: it is returned as `{ _malformed, _raw }` at
 * its real position, because silently dropping it would hide exactly the
 * tampering the chain exists to detect, and would shift every subsequent
 * sequence number.
 */
export async function readLedger(logDir) {
  const file = ledgerPath(logDir);
  if (!(await fs.pathExists(file))) return [];
  const text = await fs.readFile(file, 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line, i) => {
      try {
        return JSON.parse(line);
      } catch {
        return { _malformed: true, _raw: line, seq: i + 1 };
      }
    });
}

/**
 * Walk the chain and report the FIRST break.
 *
 * Reports one break rather than a list on purpose: once a link is broken every
 * entry after it is unverifiable, so listing them all would present dozens of
 * consequences as if they were dozens of problems.
 */
export async function verifyLedger(logDir) {
  const entries = await readLedger(logDir);
  let prevHash = null;
  // `brokenAt` is the entry's OWN recorded seq; `atLine` is where it now sits in
  // the file. After a deleted line those diverge — and the gap between them is
  // itself the evidence, so both are reported rather than one ambiguous number.
  const broken = (entry, atLine, reason) => ({
    ok: false,
    entries: entries.length,
    brokenAt: entry.seq ?? null,
    atLine,
    reason,
  });

  for (const [i, entry] of entries.entries()) {
    const atLine = i + 1;
    if (entry._malformed) return broken(entry, atLine, 'line is not valid JSON');
    if (entry.prevHash !== prevHash) {
      return broken(
        entry,
        atLine,
        'previous-hash link does not match the entry before it — a line was edited or removed',
      );
    }
    if (hashEntry(entry) !== entry.hash) {
      return broken(entry, atLine, 'entry content does not match its own hash — this line was edited');
    }
    prevHash = entry.hash;
  }
  return { ok: true, entries: entries.length, brokenAt: null, atLine: null, reason: null };
}

/**
 * Fold the append-only entries into the current state of each change.
 *
 * `status` is DERIVED, never stored, because storing it would mean going back
 * and editing an old line.
 */
export function foldEntries(entries) {
  const changes = new Map();
  for (const entry of entries) {
    if (entry._malformed) continue;
    // Bookkeeping entries update an existing change; they are not changes.
    if (entry.kind === 'outcome') {
      const target = changes.get(entry.of);
      if (target) target.status = entry.status;
      continue;
    }
    if (entry.kind === 'undo-marker') {
      const target = changes.get(entry.undoes);
      if (target) target.status = 'undone';
      continue;
    }
    // An intent starts pending and stays that way until an outcome says
    // otherwise — a crash between the write and its outcome leaves exactly
    // that, which is the honest reading of "may be half-done".
    changes.set(entry.id, { ...entry, status: 'pending' });
  }
  return [...changes.values()];
}

/**
 * A change as it may be SHOWN — payloads redacted.
 *
 * The counterpart to storing `before`/`after` raw. Everything that displays a
 * change, or puts one in the JSON envelope, goes through here; the reversers
 * read the raw entry via `readLedger` instead. That split is what lets the
 * ledger be both safe to print and faithful enough to restore from.
 */
export function redactForDisplay(change) {
  if (!change) return change;
  return { ...change, before: redactSensitiveData(change.before), after: redactSensitiveData(change.after) };
}

export async function listChanges(logDir, { limit = 50 } = {}) {
  const folded = foldEntries(await readLedger(logDir));
  return folded.slice(-limit).reverse().map(redactForDisplay);
}

export async function findChange(logDir, id) {
  const found = foldEntries(await readLedger(logDir)).find((c) => c.id === id) ?? null;
  return found && redactForDisplay(found);
}

// --------------------------------------------------------------------------
// Writing
// --------------------------------------------------------------------------

/**
 * How long a lock may sit before it is treated as abandoned.
 *
 * A held lock only ever spans one read + one append, so anything older than
 * this belongs to a process that died holding it. Reclaiming it is safe
 * precisely because the append it guarded is atomic: either the line landed or
 * it did not, and a partially written one would be caught as malformed.
 */
export const LOCK_STALE_MS = 30_000;

const LOCK_RETRY_MS = 25;
const LOCK_ATTEMPTS = 200; // 200 × 25ms ≈ 5s before the stale check bites.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Serialise read-then-append across PROCESSES.
 *
 * `append` computes `seq` and `prevHash` from the current last entry, then
 * writes. Without a lock, two concurrent `sfdt` runs both read the same last
 * entry and both write a line claiming the same `prevHash` — and `verifyLedger`
 * then reports "a line was edited or removed" at the second one. A false
 * tamper alarm on the mechanism whose entire job is tamper evidence is worse
 * than the collision itself, because it discredits every real alarm.
 *
 * An in-process mutex would not do: the racing writers are separate CLI
 * invocations. `open(…, 'wx')` is O_EXCL — one atomic filesystem call, no
 * dependency, and it works across processes because the kernel arbitrates it.
 */
async function withAppendLock(logDir, fn) {
  await fs.ensureDir(logDir);
  const lockFile = `${ledgerPath(logDir)}.lock`;
  let handle = null;

  for (let attempt = 0; attempt < LOCK_ATTEMPTS && !handle; attempt++) {
    try {
      handle = await fs.open(lockFile, 'wx');
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // Reclaim a lock whose holder died. Checked on every attempt rather than
      // only at the end, so a stale lock costs one retry instead of five
      // seconds of waiting for a process that is never coming back.
      const age = await fs.stat(lockFile).then((st) => Date.now() - st.mtimeMs).catch(() => 0);
      if (age > LOCK_STALE_MS) await fs.remove(lockFile).catch(() => {});
      else await sleep(LOCK_RETRY_MS);
    }
  }

  if (!handle) {
    throw new Error(
      `Could not take the ledger lock at ${lockFile} — another sfdt process has held it for over ` +
        `${Math.round((LOCK_ATTEMPTS * LOCK_RETRY_MS) / 1000)}s. If no sfdt command is running, ` +
        `delete that file and retry.`,
    );
  }

  try {
    await fs.write(handle, `${process.pid}\n`).catch(() => {});
    return await fn();
  } finally {
    await fs.close(handle).catch(() => {});
    await fs.remove(lockFile).catch(() => {});
  }
}

function append(logDir, partial) {
  return withAppendLock(logDir, () => appendLocked(logDir, partial));
}

async function appendLocked(logDir, partial) {
  const entries = await readLedger(logDir);
  const last = entries[entries.length - 1];
  if (last?._malformed) {
    throw new Error(
      `The ledger's last line is not valid JSON (line ${last.seq}). Refusing to append to a ` +
        `broken chain — run \`sfdt ledger verify\` and repair or archive ${ledgerPath(logDir)} first.`,
    );
  }
  const entry = {
    v: LEDGER_FORMAT_VERSION,
    seq: entries.length + 1,
    at: new Date().toISOString(),
    ...partial,
    prevHash: last?.hash ?? null,
  };
  entry.hash = hashEntry(entry);
  // Append-only, by the open mode itself. Nothing in this module ever opens the
  // file for writing or truncation.
  await fs.appendFile(ledgerPath(logDir), `${JSON.stringify(entry)}\n`, 'utf8');
  return entry;
}

/**
 * Record what is ABOUT to happen, including the state that precedes it.
 *
 * **Throws on failure, and callers must let it.** See the principle #5 note in
 * the header: a change that could not be recorded must not be made.
 *
 * @param {string} logDir
 * @param {object} change
 * @param {string} change.org
 * @param {string} change.kind - selects the reverser, e.g. 'automation.flow'
 * @param {string} change.target - human-readable subject, e.g. 'Account.Region_Required'
 * @param {string} change.summary - one line, shown in `ledger list`
 * @param {unknown} change.before - everything needed to restore the prior state
 * @param {unknown} change.after - the intended new state
 * @returns {Promise<object>} the appended entry (its `id` identifies the change)
 */
export async function recordIntent(logDir, { org, kind, target, summary, before, after }) {
  if (!kind) throw new Error('A ledger entry needs a kind.');
  return append(logDir, {
    id: randomUUID(),
    kind,
    org: org ?? null,
    target: target ?? null,
    summary: summary ?? null,
    // Stored RAW, deliberately. `before` is a RESTORE payload: `undoChange`
    // hands it to a reverser that writes it straight back to the org. Redaction
    // is lossy and one-way, so redacting it here would deploy `[REDACTED]` into
    // a Flow, a validation rule or a `.workflow` during an undo — corrupting the
    // org at the exact moment the user is relying on this file to repair it.
    //
    // Redaction moved to the READ side instead (`listChanges` / `findChange`),
    // which is what every display, JSON envelope and MCP response goes through.
    // Nothing that leaves this process carries an unredacted payload; the file
    // on disk stays faithful because only a faithful copy can restore anything.
    before: before ?? null,
    after: after ?? null,
  });
}

/**
 * Record how the write actually went.
 *
 * Best-effort by contrast with `recordIntent`: the org has already been changed
 * by this point, so throwing here would report a failure for a change that
 * succeeded. A missing outcome leaves the change `pending`, which reads as
 * "may be half-done" — the honest state.
 */
export async function recordOutcome(logDir, id, { status, error } = {}) {
  try {
    return await append(logDir, { kind: 'outcome', of: id, status: status ?? 'applied', error: error ?? null });
  } catch {
    return null;
  }
}

/**
 * Put a change back.
 *
 * Appends; never edits the original. Refuses a second undo of the same change,
 * and refuses a change that never applied.
 *
 * @param {string} logDir
 * @param {string} id
 * @param {object} [ctx] - passed through to the reverser (org alias, config…)
 */
export async function undoChange(logDir, id, ctx = {}) {
  const entries = await readLedger(logDir);
  const original = entries.find((e) => e.id === id && e.kind !== 'outcome' && !e.undoes);
  if (!original) throw new Error(`No ledger entry with id "${id}".`);

  if (entries.some((e) => e.undoes === id)) {
    throw new Error(`Change "${id}" has already been undone. Undoing it again would re-apply it.`);
  }

  const folded = foldEntries(entries).find((c) => c.id === id);
  if (folded?.status === 'failed') {
    throw new Error(`Change "${id}" was recorded as failed, so there is nothing to undo.`);
  }

  const reverse = reversers.get(original.kind);
  if (!reverse) {
    // The before-state is NOT printed here. It is a raw restore payload, and
    // stdout is the one place it must not go (golden principle #6). Point at
    // the file that holds it instead — a hand restore needs the faithful copy,
    // which is precisely the copy that cannot be echoed.
    const err = new Error(
      `No reverser is registered for kind "${original.kind}", so this change cannot be undone ` +
        `automatically. Its before-state is recorded verbatim in ${ledgerPath(logDir)}, in the ` +
        `entry with id "${id}" — restore from there by hand.`,
    );
    err.before = redactSensitiveData(original.before);
    throw err;
  }

  // The undo is itself a change, so its intent is recorded before it runs —
  // and its own before/after are the original's after/before.
  const intent = await recordIntent(logDir, {
    org: original.org,
    kind: `undo:${original.kind}`,
    target: original.target,
    summary: `Undo of ${original.kind} on ${original.target}`,
    before: original.after,
    after: original.before,
  });

  try {
    const result = await reverse(original.before, original, ctx);
    await append(logDir, { kind: 'outcome', of: intent.id, status: 'applied', error: null });
    // The marker that makes `status: undone` derivable, appended last so it is
    // only true once the reversal really happened.
    await append(logDir, { kind: 'undo-marker', undoes: id, by: intent.id, id: randomUUID() });
    return { ok: true, undone: id, by: intent.id, result };
  } catch (err) {
    await recordOutcome(logDir, intent.id, { status: 'failed', error: err.message });
    throw err;
  }
}
