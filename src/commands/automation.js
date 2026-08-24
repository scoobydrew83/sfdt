import ora from 'ora';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { AUTOMATION_TYPES } from '@sfdt/flow-core';
import { loadConfig } from '../lib/config.js';
import { runAutomationList, setAutomationState } from '../lib/automation-runner.js';
import { guardProduction } from '../lib/org-facts.js';
import { resolveExitCode } from '../lib/exit-codes.js';
import { emitJson, emitJsonError } from '../lib/output.js';

function resolveOrg(config, options) {
  const org = options.org ?? config.defaultOrg;
  if (!org) throw new Error('No org specified — pass --org <alias> or set defaultOrg in .sfdt/config.json');
  return org;
}

/**
 * Confirm a change that alters org behaviour.
 *
 * Same shape `data.js` uses for a bulk delete: `--yes` skips it, and a
 * non-interactive context (JSON mode, CI, no TTY) REFUSES rather than
 * auto-confirming — a prompt in CI is either a hang or a silent yes, and both
 * are worse than an error telling you to pass `--yes`.
 */
async function confirmChange(message, detail, options, jsonMode) {
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

function printGrid(vm) {
  console.log('');
  console.log(chalk.bold(`Automation · ${vm.org}`));
  console.log('');
  let currentType = null;
  for (const row of vm.rows) {
    if (row.typeId !== currentType) {
      currentType = row.typeId;
      const deploy = row.writeMode === 'metadata-deploy' ? chalk.dim('  (toggling = metadata deploy)') : '';
      console.log(`  ${chalk.bold(row.typeLabel)}${deploy}`);
    }
    const state = row.active ? chalk.green('ON ') : chalk.dim('off');
    const where = row.object ? chalk.dim(` · ${row.object}`) : '';
    const version = row.activeVersion ? chalk.dim(` · v${row.activeVersion}`) : '';
    console.log(`    ${state}  ${row.name}${where}${version}`);
  }
  console.log('');
  console.log(chalk.dim(`${vm.counts.total} component(s): ${vm.counts.active} on, ${vm.counts.inactive} off`));
  if (vm.notes.length > 0) {
    console.log('');
    console.log(chalk.bold('Notes'));
    for (const note of vm.notes) console.log(`  ${chalk.dim('·')} ${chalk.dim(note)}`);
  }
  console.log('');
}

/**
 * `sfdt automation` — the on/off grid, and the writes behind it.
 *
 * The grid deliberately shows the write mechanism per type. Their SwitchBoard
 * presents one uniform toggle across five kinds of automation that are written
 * three different ways — and in production an Apex trigger's status cannot
 * change without a deployment at all.
 */
export function registerAutomationCommand(program) {
  const automation = program
    .command('automation')
    .description('Validation rules, flows, workflow rules, triggers and duplicate rules — state and toggles');

  automation
    .command('list')
    .description('Show every automation component and whether it is on')
    .option('--org <alias>', 'Org alias (defaults to config.defaultOrg)')
    .option('--type <id>', `Restrict to one type: ${AUTOMATION_TYPES.map((t) => t.id).join(', ')}`)
    .option('--json', 'Emit structured JSON to stdout')
    .action(async (options) => {
      const jsonMode = !!options.json;
      const spinner = jsonMode ? null : ora('Reading automation state…').start();
      try {
        const config = await loadConfig();
        const vm = await runAutomationList(resolveOrg(config, options), { type: options.type });
        spinner?.stop();
        if (jsonMode) {
          emitJson(vm, { warnings: vm.notes });
          return;
        }
        printGrid(vm);
      } catch (err) {
        spinner?.stop();
        if (jsonMode) emitJsonError(err);
        else {
          console.error(chalk.red(`Automation list failed: ${err.message}`));
          process.exitCode = resolveExitCode(err);
        }
      }
    });

  for (const [verb, enable] of [['enable', true], ['disable', false]]) {
    automation
      .command(`${verb} <type> <name>`)
      .description(`Turn one automation component ${enable ? 'on' : 'off'}`)
      .option('--org <alias>', 'Org alias (defaults to config.defaultOrg)')
      .option('--dry-run', 'Show exactly what would be written, and write nothing')
      .option('--yes', 'Skip the confirmation prompt')
      .option('--production', 'Acknowledge that the target org is production')
      .option('--json', 'Emit structured JSON to stdout')
      .action(async (type, name, options) => {
        const jsonMode = !!options.json;
        try {
          const config = await loadConfig();
          const orgAlias = resolveOrg(config, options);

          if (!options.dryRun) {
            await guardProduction(orgAlias, options, `${verb} automation in it`);
            const ok = await confirmChange(
              `${verb} ${type} "${name}" in ${orgAlias}`,
              [
                'This changes how the org behaves for every user immediately.',
                'It is recorded in the ledger and can be reversed with `sfdt ledger undo`.',
              ],
              options,
              jsonMode,
            );
            if (!ok) return;
          }

          const result = await setAutomationState(config, orgAlias, type, name, enable, {
            dryRun: !!options.dryRun,
          });

          if (jsonMode) {
            emitJson(result, { warnings: result.writeNote ? [result.writeNote] : [] });
            return;
          }
          if (result.outcome === 'no-op') {
            console.log(chalk.dim(`\n${name} is already ${enable ? 'on' : 'off'} — nothing to do.\n`));
            return;
          }
          if (result.outcome === 'dry-run') {
            console.log(chalk.bold(`\nWould ${verb} ${name}:`));
            console.log(typeof result.after === 'string'
              ? result.after
              : JSON.stringify(result.after, null, 2));
            console.log(chalk.dim(`\n${result.writeNote}\n`));
            return;
          }
          console.log(chalk.green(`\n✔ ${enable ? 'Enabled' : 'Disabled'} ${name}`));
          console.log(chalk.dim(`  Recorded as ${result.ledgerId} — reverse with \`sfdt ledger undo ${result.ledgerId}\``));
          console.log(chalk.dim(`  ${result.writeNote}\n`));
        } catch (err) {
          if (jsonMode) emitJsonError(err);
          else {
            console.error(chalk.red(`Automation ${verb} failed: ${err.message}`));
            process.exitCode = resolveExitCode(err);
          }
        }
      });
  }
}
