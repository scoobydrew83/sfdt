import ora from 'ora';
import chalk from 'chalk';
import { loadConfig } from '../lib/config.js';
import { exportDataSet, importDataSet, deleteDataSet, listDataSets } from '../lib/data-runner.js';
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
    .action(makeAction('Delete', deleteDataSet));
}
