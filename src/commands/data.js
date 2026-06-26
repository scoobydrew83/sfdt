import ora from 'ora';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { loadConfig } from '../lib/config.js';
import { exportDataSet, importDataSet, deleteDataSet, listDataSets, readQueries, extractSObject } from '../lib/data-runner.js';
import { resolveExitCode } from '../lib/exit-codes.js';

function resolveOrg(config, options) {
  const org = options.org ?? config.defaultOrg;
  if (!org) throw new Error('No org specified — pass --org <alias> or set defaultOrg in .sfdt/config.json');
  return org;
}

function makeAction(verb, fn) {
  return async (setName, options) => {
    const jsonMode = !!options.json;
    try {
      const config = await loadConfig();
      const org = resolveOrg(config, options);
      const spinner = jsonMode ? null : ora(`${verb} data set "${setName}" (${org})…`).start();
      let result;
      try {
        result = await fn(config, setName, org);
        spinner?.succeed(`${verb} complete: ${setName}`);
      } catch (err) {
        spinner?.fail(`${verb} failed`);
        throw err;
      }
      if (jsonMode) {
        process.stdout.write(JSON.stringify({ status: 'success', ...result }, null, 2) + '\n');
      } else {
        console.log(chalk.green(`\n${JSON.stringify(result, null, 2)}`));
      }
    } catch (err) {
      if (jsonMode) {
        process.stdout.write(JSON.stringify({ status: 'error', message: err.message, exitCode: resolveExitCode(err) }) + '\n');
      } else {
        console.error(chalk.red(`${verb} failed: ${err.message}`));
      }
      process.exitCode = resolveExitCode(err);
    }
  };
}

/**
 * `data delete` is irreversible — it bulk-removes every record the data set's
 * queries match (often all records of an object, by design for scratch/sandbox
 * seed cleanup). Gate it behind a confirmation that previews the blast radius;
 * `--yes` skips the prompt, and non-interactive runs MUST pass `--yes` rather
 * than deleting silently.
 */
function makeDeleteAction() {
  return async (setName, options) => {
    const jsonMode = !!options.json;
    try {
      const config = await loadConfig();
      const org = resolveOrg(config, options);

      if (!options.yes) {
        const nonInteractive =
          jsonMode || process.env.SFDT_NON_INTERACTIVE === 'true' || !process.stdin.isTTY;
        if (nonInteractive) {
          throw new Error(
            `Refusing to bulk-delete data set "${setName}" on ${org} without confirmation — re-run with --yes to proceed.`,
          );
        }
        const queries = await readQueries(config, setName);
        const targets = [...new Set(queries.map(extractSObject).filter(Boolean))];
        console.log(chalk.yellow(`\n⚠  This will BULK DELETE records on ${chalk.bold(org)} for data set "${setName}":`));
        for (const q of queries) console.log(chalk.dim(`     ${q}`));
        console.log(chalk.yellow(`   Objects affected: ${targets.join(', ') || '(none resolved)'}`));
        const { confirmed } = await inquirer.prompt([
          { type: 'confirm', name: 'confirmed', message: `Delete these records on ${org}?`, default: false },
        ]);
        if (!confirmed) {
          console.log(chalk.dim('Aborted — no records deleted.'));
          return;
        }
      }

      const spinner = jsonMode ? null : ora(`Delete data set "${setName}" (${org})…`).start();
      let result;
      let skipped = [];
      let errored = [];
      try {
        result = await deleteDataSet(config, setName, org);
        skipped = (result.sobjects ?? []).filter((s) => s.status === 'skipped');
        errored = (result.sobjects ?? []).filter((s) => s.status === 'error');
        if (errored.length || skipped.length) {
          const parts = [];
          if (errored.length) parts.push(`${errored.length} failed`);
          if (skipped.length) parts.push(`${skipped.length} skipped`);
          spinner?.warn(`Delete finished with issues: ${setName} (${parts.join(', ')})`);
        } else {
          spinner?.succeed(`Delete complete: ${setName}`);
        }
      } catch (err) {
        spinner?.fail('Delete failed');
        throw err;
      }
      if (jsonMode) {
        // deleteDataSet records per-sobject failures and skips WITHOUT throwing,
        // so signal partial completion when any query errored or was skipped —
        // a machine consumer (CI checking `status === 'success'`) must not treat
        // an incomplete delete as clean. The counts let them branch without
        // iterating sobjects[].
        process.stdout.write(JSON.stringify({
          ...result,
          status: errored.length || skipped.length ? 'partial' : 'success',
          skippedCount: skipped.length,
          errorCount: errored.length,
        }, null, 2) + '\n');
      } else {
        if (errored.length) {
          console.warn(chalk.red(`⚠ ${errored.length} sobject delete(s) FAILED — see the "error" entries in the result below.`));
        }
        if (skipped.length) {
          console.warn(chalk.yellow(`⚠ ${skipped.length} query(ies) were skipped (could not parse the sObject from the FROM clause); their records were NOT deleted.`));
        }
        console.log(chalk.green(`\n${JSON.stringify(result, null, 2)}`));
      }
    } catch (err) {
      if (jsonMode) {
        process.stdout.write(JSON.stringify({ status: 'error', message: err.message, exitCode: resolveExitCode(err) }) + '\n');
      } else {
        console.error(chalk.red(`Delete failed: ${err.message}`));
      }
      process.exitCode = resolveExitCode(err);
    }
  };
}

export function registerDataCommand(program) {
  const data = program
    .command('data')
    .description('Import/export org data sets (native sf tree commands) for sandbox & scratch seeding');

  data
    .command('list')
    .description('List configured data sets')
    .option('--json', 'Emit structured JSON to stdout')
    .action(async (options) => {
      try {
        const config = await loadConfig();
        const sets = await listDataSets(config);
        if (options.json) {
          process.stdout.write(JSON.stringify({ status: 'success', sets }, null, 2) + '\n');
        } else if (sets.length === 0) {
          console.log(chalk.yellow('No data sets found. Create one at .sfdt/data/<name>/queries.json'));
        } else {
          console.log('');
          for (const s of sets) console.log(`  ${s}`);
        }
      } catch (err) {
        if (options.json) {
          process.stdout.write(JSON.stringify({ status: 'error', message: err.message, exitCode: resolveExitCode(err) }) + '\n');
        } else {
          console.error(chalk.red(`List failed: ${err.message}`));
        }
        process.exitCode = resolveExitCode(err);
      }
    });

  data
    .command('export <set>')
    .description('Export records for a data set from an org (sf data export tree)')
    .option('--org <alias>', 'Org alias (defaults to config.defaultOrg)')
    .option('--json', 'Emit structured JSON to stdout')
    .action(makeAction('Export', exportDataSet));

  data
    .command('import <set>')
    .description('Import a previously-exported data set into an org (sf data import tree)')
    .option('--org <alias>', 'Org alias (defaults to config.defaultOrg)')
    .option('--json', 'Emit structured JSON to stdout')
    .action(makeAction('Import', importDataSet));

  data
    .command('delete <set>')
    .description('Bulk-delete the records targeted by a data set')
    .option('--org <alias>', 'Org alias (defaults to config.defaultOrg)')
    .option('--json', 'Emit structured JSON to stdout')
    .option('-y, --yes', 'Skip the confirmation prompt (required for non-interactive use)')
    .action(makeDeleteAction());
}
