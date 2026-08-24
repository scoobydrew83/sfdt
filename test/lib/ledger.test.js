import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import {
  canonicalJson,
  hashEntry,
  readLedger,
  verifyLedger,
  foldEntries,
  listChanges,
  findChange,
  recordIntent,
  recordOutcome,
  undoChange,
  registerReverser,
  hasReverser,
  _resetReversersForTests,
  LEDGER_FILE,
} from '../../src/lib/ledger.js';

// Driven against a REAL temp directory, never a mocked fs: the properties this
// module exists for — append-only, tamper-evident, survives a crash mid-change —
// are properties of the FILE, and a mock would only assert my assumptions about
// it.

let logDir;
const ledgerFile = () => path.join(logDir, LEDGER_FILE);
const lines = async () =>
  (await fs.readFile(ledgerFile(), 'utf8')).split('\n').filter((l) => l.trim());

beforeEach(async () => {
  logDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sfdt-ledger-'));
  _resetReversersForTests();
});

afterEach(async () => {
  await fs.remove(logDir);
});

const intent = (over = {}) => ({
  org: 'dev',
  kind: 'test.thing',
  target: 'Account.Thing',
  summary: 'did a thing',
  before: { active: true },
  after: { active: false },
  ...over,
});

describe('canonicalJson', () => {
  it('is key-order independent, so identical content hashes identically', () => {
    // JSON.stringify preserves insertion order; two structurally identical
    // entries built in different orders would otherwise appear to break the
    // chain.
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ a: { z: 1, y: 2 } })).toBe(canonicalJson({ a: { y: 2, z: 1 } }));
  });

  it('preserves array order, which is meaningful', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('handles null and undefined without throwing', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(undefined)).toBe('null');
  });
});

describe('append-only writing', () => {
  it('records an intent and chains the first entry to null', async () => {
    const entry = await recordIntent(logDir, intent());

    expect(entry.seq).toBe(1);
    expect(entry.prevHash).toBeNull();
    expect(entry.hash).toBe(hashEntry(entry));
    expect(entry.id).toMatch(/[0-9a-f-]{36}/);
    expect(await lines()).toHaveLength(1);
  });

  it('only ever appends — an earlier line is never rewritten', async () => {
    const first = await recordIntent(logDir, intent());
    const firstLine = (await lines())[0];

    await recordIntent(logDir, intent({ target: 'Other' }));
    await recordOutcome(logDir, first.id, { status: 'applied' });

    const all = await lines();
    expect(all).toHaveLength(3);
    // Byte-identical: proof nothing rewrote it.
    expect(all[0]).toBe(firstLine);
  });

  it('chains each entry to the one before it', async () => {
    const a = await recordIntent(logDir, intent());
    const b = await recordIntent(logDir, intent({ target: 'B' }));

    expect(b.prevHash).toBe(a.hash);
    expect(b.seq).toBe(2);
  });

  it('stores the payload RAW — a redacted before-state cannot restore anything', async () => {
    // `before` is what `undoChange` writes back to the org. Redaction is lossy
    // and one-way, so a redacted copy would deploy `[REDACTED]` into the org
    // during the recovery it exists to perform.
    await recordIntent(logDir, intent({ before: { accessToken: 'SECRET', ok: 'keep' } }));
    const [entry] = await readLedger(logDir);

    expect(entry.before.accessToken).toBe('SECRET');
    expect(entry.before.ok).toBe('keep');
  });

  it('redacts on the READ side, so nothing shown or emitted carries a secret', async () => {
    const written = await recordIntent(logDir, intent({ before: { accessToken: 'SECRET', ok: 'keep' } }));

    // Both display paths — `ledger show` and `ledger list` — go through these.
    const shown = await findChange(logDir, written.id);
    expect(shown.before.accessToken).toBe('[REDACTED]');
    expect(shown.before.ok).toBe('keep');

    const [listed] = await listChanges(logDir);
    expect(listed.before.accessToken).toBe('[REDACTED]');
  });

  it('keeps the chain intact under concurrent appends', async () => {
    // `append` reads the last entry to compute seq/prevHash, then writes.
    // Unserialised, two writers read the same last entry and both claim the
    // same prevHash — and `verifyLedger` then reports the SECOND as tampering.
    // A false tamper alarm on a tamper-evidence mechanism discredits the real
    // ones, so the lock is load-bearing rather than cosmetic.
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => recordIntent(logDir, intent({ target: `T${i}` }))),
    );

    const result = await verifyLedger(logDir);
    expect(result).toMatchObject({ ok: true, entries: 12 });

    // Every seq handed out exactly once — no two writers agreed on a number.
    const entries = await readLedger(logDir);
    expect(entries.map((e) => e.seq).sort((a, b) => a - b)).toEqual([...Array(12).keys()].map((n) => n + 1));
    expect(new Set(entries.map((e) => e.target)).size).toBe(12);
  });

  it('leaves no lock file behind', async () => {
    await recordIntent(logDir, intent());
    expect(await fs.pathExists(`${ledgerFile()}.lock`)).toBe(false);
  });

  it('refuses an entry with no kind — the reverser lookup depends on it', async () => {
    await expect(recordIntent(logDir, intent({ kind: undefined }))).rejects.toThrow(/needs a kind/);
  });
});

describe('recordIntent THROWS — the principle #5 carve-out', () => {
  it('propagates a write failure instead of degrading silently', async () => {
    // Telemetry never throws; this deliberately does. An unrecorded change is
    // an unreversible one, so the caller must abort rather than change an org
    // it cannot put back. A directory where the file should be makes the
    // append fail for real.
    await fs.ensureDir(ledgerFile());

    await expect(recordIntent(logDir, intent())).rejects.toThrow();
  });

  it('refuses to append onto a broken chain', async () => {
    await recordIntent(logDir, intent());
    await fs.appendFile(ledgerFile(), 'not json\n', 'utf8');

    await expect(recordIntent(logDir, intent())).rejects.toThrow(/broken chain/);
  });
});

describe('recordOutcome is best-effort, by contrast', () => {
  it('does not throw when it cannot write — the org has already changed', async () => {
    // Throwing here would report failure for a change that succeeded.
    const entry = await recordIntent(logDir, intent());
    await fs.remove(logDir);
    await fs.ensureDir(path.join(logDir, LEDGER_FILE));

    await expect(recordOutcome(logDir, entry.id, { status: 'applied' })).resolves.toBeNull();
  });
});

describe('verifyLedger', () => {
  it('verifies an untouched chain', async () => {
    await recordIntent(logDir, intent());
    await recordIntent(logDir, intent({ target: 'B' }));

    expect(await verifyLedger(logDir)).toMatchObject({ ok: true, entries: 2, brokenAt: null });
  });

  it('verifies an empty ledger', async () => {
    expect(await verifyLedger(logDir)).toMatchObject({ ok: true, entries: 0 });
  });

  it('detects an EDITED line and names its position', async () => {
    await recordIntent(logDir, intent());
    await recordIntent(logDir, intent({ target: 'B' }));

    const all = await lines();
    const tampered = JSON.parse(all[0]);
    tampered.summary = 'something else entirely';
    all[0] = JSON.stringify(tampered);
    await fs.writeFile(ledgerFile(), `${all.join('\n')}\n`, 'utf8');

    const result = await verifyLedger(logDir);
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(1);
    expect(result.reason).toContain('does not match its own hash');
  });

  it('detects a REMOVED line', async () => {
    await recordIntent(logDir, intent());
    await recordIntent(logDir, intent({ target: 'B' }));
    await recordIntent(logDir, intent({ target: 'C' }));

    const all = await lines();
    await fs.writeFile(ledgerFile(), `${[all[0], all[2]].join('\n')}\n`, 'utf8');

    const result = await verifyLedger(logDir);
    expect(result.ok).toBe(false);
    // The survivor still carries its own seq 3 while now sitting on line 2 —
    // and that divergence IS the evidence a line was removed, which is why both
    // numbers are reported.
    expect(result.brokenAt).toBe(3);
    expect(result.atLine).toBe(2);
    expect(result.reason).toContain('a line was edited or removed');
  });

  it('reports only the FIRST break, not every consequence of it', async () => {
    for (let i = 0; i < 4; i++) await recordIntent(logDir, intent({ target: `T${i}` }));
    const all = await lines();
    all[0] = JSON.stringify({ ...JSON.parse(all[0]), summary: 'x' });
    await fs.writeFile(ledgerFile(), `${all.join('\n')}\n`, 'utf8');

    // Everything after a broken link is unverifiable; listing them all would
    // present consequences as if they were problems.
    expect((await verifyLedger(logDir)).brokenAt).toBe(1);
  });

  it('detects a line that is not JSON at all', async () => {
    await recordIntent(logDir, intent());
    await fs.appendFile(ledgerFile(), '{ truncated\n', 'utf8');

    expect(await verifyLedger(logDir)).toMatchObject({ ok: false, brokenAt: 2 });
  });
});

describe('status is derived, never stored', () => {
  it('leaves a change pending until an outcome says otherwise', async () => {
    // A crash between the write and its outcome leaves exactly this — the
    // honest reading of "may be half-done".
    const entry = await recordIntent(logDir, intent());
    expect(foldEntries(await readLedger(logDir))[0].status).toBe('pending');

    await recordOutcome(logDir, entry.id, { status: 'applied' });
    expect(foldEntries(await readLedger(logDir))[0].status).toBe('applied');
  });

  it('records a failed write as failed', async () => {
    const entry = await recordIntent(logDir, intent());
    await recordOutcome(logDir, entry.id, { status: 'failed', error: 'INSUFFICIENT_ACCESS' });

    expect((await findChange(logDir, entry.id)).status).toBe('failed');
  });

  it('lists newest first', async () => {
    await recordIntent(logDir, intent({ target: 'A' }));
    await recordIntent(logDir, intent({ target: 'B' }));

    expect((await listChanges(logDir)).map((c) => c.target)).toEqual(['B', 'A']);
  });
});

describe('undo', () => {
  it('calls the registered reverser with the before-state', async () => {
    const seen = [];
    registerReverser('test.thing', async (before) => {
      seen.push(before);
      return 'restored';
    });

    const entry = await recordIntent(logDir, intent());
    await recordOutcome(logDir, entry.id, { status: 'applied' });

    const result = await undoChange(logDir, entry.id, { org: 'dev' });
    expect(seen).toEqual([{ active: true }]);
    expect(result).toMatchObject({ ok: true, undone: entry.id, result: 'restored' });
  });

  it('appends rather than editing the original entry', async () => {
    registerReverser('test.thing', async () => 'ok');
    const entry = await recordIntent(logDir, intent());
    const originalLine = (await lines())[0];

    await undoChange(logDir, entry.id);

    // Byte-identical — the original was never touched.
    expect((await lines())[0]).toBe(originalLine);
    expect((await findChange(logDir, entry.id)).status).toBe('undone');
    // And the chain still verifies after an undo.
    expect((await verifyLedger(logDir)).ok).toBe(true);
  });

  it('refuses a second undo — that would re-apply the change', async () => {
    registerReverser('test.thing', async () => 'ok');
    const entry = await recordIntent(logDir, intent());
    await undoChange(logDir, entry.id);

    await expect(undoChange(logDir, entry.id)).rejects.toThrow(/already been undone/);
  });

  it('refuses to undo a change that failed', async () => {
    registerReverser('test.thing', async () => 'ok');
    const entry = await recordIntent(logDir, intent());
    await recordOutcome(logDir, entry.id, { status: 'failed', error: 'nope' });

    await expect(undoChange(logDir, entry.id)).rejects.toThrow(/nothing to undo/);
  });

  it('reports an unreversible kind and says WHERE the before-state is, rather than skipping it', async () => {
    // Silently skipping would leave the user believing the change was reversed.
    // The payload itself is not echoed: it is a raw restore blob, and stdout is
    // where it must not go. Naming the file and the id keeps a hand restore
    // possible without printing a secret.
    const entry = await recordIntent(logDir, intent({ kind: 'unknown.kind', before: { accessToken: 'SECRET' } }));

    expect(hasReverser('unknown.kind')).toBe(false);
    await expect(undoChange(logDir, entry.id)).rejects.toThrow(/cannot be undone automatically/);
    await expect(undoChange(logDir, entry.id)).rejects.toThrow(new RegExp(LEDGER_FILE));
    await expect(undoChange(logDir, entry.id)).rejects.toThrow(new RegExp(entry.id));

    // What IS attached for the JSON envelope is the redacted copy.
    const err = await undoChange(logDir, entry.id).catch((e) => e);
    expect(err.before.accessToken).toBe('[REDACTED]');
    expect(await fs.readFile(ledgerFile(), 'utf8')).toContain('SECRET');
  });

  it('records the undo as failed when the reverser throws, and leaves the original undone-free', async () => {
    registerReverser('test.thing', async () => {
      throw new Error('org refused');
    });
    const entry = await recordIntent(logDir, intent());

    await expect(undoChange(logDir, entry.id)).rejects.toThrow('org refused');
    // The original is NOT marked undone, so it can be retried.
    expect((await findChange(logDir, entry.id)).status).toBe('pending');
    expect((await verifyLedger(logDir)).ok).toBe(true);
  });

  it('errors clearly on an unknown id', async () => {
    await expect(undoChange(logDir, 'nope')).rejects.toThrow(/No ledger entry/);
  });
});
