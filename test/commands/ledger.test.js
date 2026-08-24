import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

vi.mock('execa', () => ({ execa: vi.fn() }));
vi.mock('../../src/lib/config.js', () => ({ loadConfig: vi.fn() }));
vi.mock('../../src/lib/ledger.js', () => ({
  listChanges: vi.fn(),
  findChange: vi.fn(),
  verifyLedger: vi.fn(),
  undoChange: vi.fn(),
}));
vi.mock('../../src/lib/ledger-reversers.js', () => ({ registerAllReversers: vi.fn() }));

import { execa } from 'execa';
import { loadConfig } from '../../src/lib/config.js';
import { findChange, undoChange } from '../../src/lib/ledger.js';
import { registerLedgerCommand } from '../../src/commands/ledger.js';

// `org-facts.js` and `confirm-change.js` are deliberately NOT mocked: what is
// under test here is the WIRING — that `ledger undo` actually reaches the same
// two brakes the forward commands use. Mocking them would assert only that this
// file calls functions it imports, which is what the bug already did.

const CONFIG = { defaultOrg: 'dev', logDir: '/p/logs', _projectRoot: '/p' };
const CHANGE = {
  id: 'abc-123',
  kind: 'permissions.field',
  target: 'Sales Ops',
  org: 'prod',
  status: 'applied',
};

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerLedgerCommand(program);
  return program;
}

/** Point `isProductionOrg` at a sandbox or a production org. */
function orgIs({ sandbox }) {
  vi.mocked(execa).mockResolvedValue({ stdout: JSON.stringify({ result: { isSandbox: sandbox } }) });
}

const run = (...args) => createProgram().parseAsync(['node', 'sfdt', 'ledger', 'undo', ...args]);

let stdout;
beforeEach(() => {
  vi.resetAllMocks();
  loadConfig.mockResolvedValue(CONFIG);
  findChange.mockResolvedValue(CHANGE);
  undoChange.mockResolvedValue({ ok: true, undone: CHANGE.id, by: 'undo-1' });
  stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});
afterEach(() => {
  stdout.mockRestore();
  process.exitCode = undefined;
});

const emitted = () => JSON.parse(stdout.mock.calls.map(([c]) => c).join(''));

describe('ledger undo is guarded like the writes it reverses', () => {
  it('REFUSES a production org without --production, and touches nothing', async () => {
    // Undoing a `permissions grant` REVOKES access. Without this guard the
    // forward change demanded --production while the reversal needed nothing.
    orgIs({ sandbox: false });

    await run(CHANGE.id, '--json', '--yes');

    expect(undoChange).not.toHaveBeenCalled();
    expect(emitted().message).toMatch(/Re-run with --production/);
    expect(process.exitCode).toBe(1);
  });

  it('fails safe — an org whose sandbox status cannot be read is production', async () => {
    vi.mocked(execa).mockRejectedValue(new Error('no auth'));

    await run(CHANGE.id, '--json', '--yes');

    expect(undoChange).not.toHaveBeenCalled();
    expect(emitted().message).toMatch(/Re-run with --production/);
  });

  it('proceeds against production once acknowledged', async () => {
    orgIs({ sandbox: false });

    await run(CHANGE.id, '--json', '--yes', '--production');

    expect(undoChange).toHaveBeenCalledWith('/p/logs', CHANGE.id, { config: CONFIG, org: 'prod' });
  });

  it('proceeds against a sandbox without the flag', async () => {
    orgIs({ sandbox: true });

    await run(CHANGE.id, '--json', '--yes');

    expect(undoChange).toHaveBeenCalled();
  });

  it('REFUSES rather than auto-confirming when non-interactive without --yes', async () => {
    // --json is a non-interactive context. Auto-confirming an org write there
    // is the failure mode the shared confirmChange exists to prevent.
    orgIs({ sandbox: true });

    await run(CHANGE.id, '--json');

    expect(undoChange).not.toHaveBeenCalled();
    expect(emitted().message).toMatch(/re-run with --yes/);
  });

  it('skips the org guard for an entry that records no org', async () => {
    // Nothing to check against, and refusing would strand the entry.
    findChange.mockResolvedValue({ ...CHANGE, org: null });

    await run(CHANGE.id, '--json', '--yes');

    expect(execa).not.toHaveBeenCalled();
    expect(undoChange).toHaveBeenCalled();
  });
});
