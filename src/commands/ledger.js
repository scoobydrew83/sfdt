import chalk from 'chalk';
import { loadConfig } from '../lib/config.js';
import { listChanges, findChange, verifyLedger, undoChange } from '../lib/ledger.js';
import { registerAllReversers } from '../lib/ledger-reversers.js';
import { resolveExitCode } from '../lib/exit-codes.js';
import { emitJson, emitJsonError } from '../lib/output.js';

/**
 * `sfdt ledger` — read, verify and reverse recorded org changes.
 *
 * The ledger is what makes `automation disable` and `permissions grant`
 * reversible. Every write records the state that preceded it, so `ledger undo`
 * can put it back — which is the thing a stage-and-approve UI cannot do, because
 * it only ever looks forward.
 */

function logDirFor(config) {
  return config.logDir || `${config._projectRoot}/logs`;
}

const STATUS_STYLE = {
  applied: chalk.green,
  pending: chalk.yellow,
  failed: chalk.red,
  undone: chalk.dim,
};

function printChanges(changes) {
  console.log('');
  if (changes.length === 0) {
    console.log(chalk.dim('  No org changes recorded.'));
    console.log('');
    return;
  }
  for (const c of changes) {
    const style = STATUS_STYLE[c.status] ?? ((s) => s);
    console.log(`  ${chalk.dim(c.at)}  ${style(c.status.padEnd(8))} ${c.kind.padEnd(24)} ${c.target ?? ''}`);
    console.log(`    ${chalk.dim(c.id)}  ${c.summary ?? ''}`);
  }
  console.log('');
  // `pending` is the honest reading of a crash between the write and its
  // outcome, so it is explained rather than left looking like a bug.
  if (changes.some((c) => c.status === 'pending')) {
    console.log(
      chalk.dim(
        '  A pending change was recorded but its outcome never was — the command may have been ' +
          'interrupted mid-write. Check the org before undoing it.',
      ),
    );
    console.log('');
  }
}

export function registerLedgerCommand(program) {
  const ledger = program
    .command('ledger')
    .description('The append-only record of org changes made by sfdt, and how to reverse them');

  ledger
    .command('list')
    .description('List recorded org changes, newest first')
    .option('--limit <n>', 'How many to show', '50')
    .option('--json', 'Emit structured JSON to stdout')
    .action(async (options) => {
      const jsonMode = !!options.json;
      try {
        const config = await loadConfig();
        const changes = await listChanges(logDirFor(config), {
          limit: Math.max(1, Number(options.limit) || 50),
        });
        if (jsonMode) {
          emitJson({ changes });
          return;
        }
        printChanges(changes);
      } catch (err) {
        if (jsonMode) emitJsonError(err);
        else {
          console.error(chalk.red(`Ledger list failed: ${err.message}`));
          process.exitCode = resolveExitCode(err);
        }
      }
    });

  ledger
    .command('show <id>')
    .description('Show one change in full, including the state that preceded it')
    .option('--json', 'Emit structured JSON to stdout')
    .action(async (id, options) => {
      const jsonMode = !!options.json;
      try {
        const config = await loadConfig();
        const change = await findChange(logDirFor(config), id);
        if (!change) throw new Error(`No recorded change with id "${id}".`);
        if (jsonMode) {
          emitJson(change);
          return;
        }
        console.log('');
        console.log(chalk.bold(`${change.kind} · ${change.target ?? ''}`));
        console.log(chalk.dim(`  ${change.at}  ${change.org ?? ''}  ${change.status}`));
        console.log('');
        console.log(chalk.bold('  Before'));
        console.log(`${JSON.stringify(change.before, null, 2).replace(/^/gm, '    ')}`);
        console.log('');
        console.log(chalk.bold('  After'));
        console.log(`${JSON.stringify(change.after, null, 2).replace(/^/gm, '    ')}`);
        console.log('');
      } catch (err) {
        if (jsonMode) emitJsonError(err);
        else {
          console.error(chalk.red(`Ledger show failed: ${err.message}`));
          process.exitCode = resolveExitCode(err);
        }
      }
    });

  ledger
    .command('verify')
    .description('Check the hash chain for tampering')
    .option('--json', 'Emit structured JSON to stdout')
    .action(async (options) => {
      const jsonMode = !!options.json;
      try {
        const config = await loadConfig();
        const result = await verifyLedger(logDirFor(config));
        // A broken chain is a finding, not a crash — but it must not exit 0,
        // or a CI check on it would be decorative.
        if (!result.ok) process.exitCode = 1;
        if (jsonMode) {
          emitJson(result);
          return;
        }
        console.log('');
        if (result.ok) {
          console.log(chalk.green(`  ✔ ${result.entries} entr(ies), chain intact.`));
        } else {
          console.log(chalk.red(`  ✖ Chain broken at entry ${result.brokenAt} (line ${result.atLine}).`));
          console.log(`    ${chalk.dim(result.reason)}`);
          console.log(
            chalk.dim(
              '    Entries after this point cannot be verified. The ledger is append-only by ' +
                'design — a break means the file was edited outside sfdt.',
            ),
          );
        }
        console.log('');
      } catch (err) {
        if (jsonMode) emitJsonError(err);
        else {
          console.error(chalk.red(`Ledger verify failed: ${err.message}`));
          process.exitCode = resolveExitCode(err);
        }
      }
    });

  ledger
    .command('undo <id>')
    .description('Reverse a recorded change, restoring the state it replaced')
    .option('--json', 'Emit structured JSON to stdout')
    .action(async (id, options) => {
      const jsonMode = !!options.json;
      try {
        const config = await loadConfig();
        const logDir = logDirFor(config);
        const change = await findChange(logDir, id);
        if (!change) throw new Error(`No recorded change with id "${id}".`);

        // Undo usually runs long after — and in a different process from — the
        // command that made the change, so nothing would have imported the
        // module that knows how to reverse it. Without this every undo would
        // report "no reverser registered" for a kind that plainly has one.
        await registerAllReversers();

        const result = await undoChange(logDir, id, { config, org: change.org });
        if (jsonMode) {
          emitJson(result);
          return;
        }
        console.log(chalk.green(`\n✔ Undid ${change.kind} on ${change.target ?? '(unknown target)'}`));
        console.log(chalk.dim(`  Recorded as ${result.by} — the original entry is untouched.`));
        console.log('');
      } catch (err) {
        if (jsonMode) emitJsonError(err, { data: err.before !== undefined ? { before: err.before } : undefined });
        else {
          console.error(chalk.red(`\nLedger undo failed: ${err.message}`));
          process.exitCode = resolveExitCode(err);
        }
      }
    });
}
