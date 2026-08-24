import chalk from 'chalk';
import inquirer from 'inquirer';

/**
 * Confirm a change that alters an org.
 *
 * Follows `data.js`'s bulk-delete pattern: `--yes` skips it, and a
 * non-interactive context (JSON mode, CI, no TTY) REFUSES rather than
 * auto-confirming — a prompt in CI is either a hang or a silent yes, and both
 * are worse than an error telling you to pass `--yes`.
 *
 * Lives here rather than in a command file because three commands now need it
 * (`automation`, `permissions`, `ledger undo`) and the refusal-when-non-
 * interactive rule is the kind that must not be allowed to drift between
 * copies — a copy that quietly auto-confirms in CI is the whole failure mode.
 *
 * @param {string} message - what is about to happen, completing "This will …"
 * @param {string[]} detail - lines shown under the warning
 * @param {object} options - the command's parsed options (`--yes`)
 * @param {boolean} jsonMode - JSON output implies non-interactive
 * @returns {Promise<boolean>} whether to proceed
 */
export async function confirmChange(message, detail, options, jsonMode) {
  if (options.yes) return true;
  const nonInteractive = jsonMode || process.env.SFDT_NON_INTERACTIVE === 'true' || !process.stdin.isTTY;
  if (nonInteractive) {
    throw new Error(`Refusing to ${message} without confirmation — re-run with --yes to proceed.`);
  }
  console.log(chalk.yellow(`\n⚠  This will ${message}.`));
  for (const line of detail) console.log(chalk.dim(`     ${line}`));
  const { confirmed } = await inquirer.prompt([
    { type: 'confirm', name: 'confirmed', message: 'Proceed?', default: false },
  ]);
  if (!confirmed) console.log(chalk.dim('Aborted — nothing changed.'));
  return confirmed;
}
