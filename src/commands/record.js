import ora from 'ora';
import chalk from 'chalk';
import { loadConfig } from '../lib/config.js';
import { getRecord, editRecord, cloneRecord, parseSetPairs } from '../lib/record-runner.js';
import { resolveExitCode } from '../lib/exit-codes.js';
import { emitJson, emitJsonError } from '../lib/output.js';

function resolveOrg(config, options) {
  const org = options.org ?? config.defaultOrg;
  if (!org) throw new Error('No org specified — pass --org <alias> or set defaultOrg in .sfdt/config.json');
  return org;
}

/** Collect repeatable `--set Field=Value` flags. */
function collectSet(value, previous) {
  return [...(previous ?? []), value];
}

function printFields(result) {
  console.log('');
  console.log(chalk.bold(`${result.sobject} · ${result.id}`));
  console.log('');
  const editable = result.fields.filter((f) => f.editable);
  const locked = result.fields.filter((f) => !f.editable);
  for (const f of editable) {
    const val = f.value === null || f.value === undefined ? chalk.dim('(null)') : String(f.value);
    console.log(`  ${chalk.green('✎')} ${f.name.padEnd(32)} ${val}`);
  }
  for (const f of locked) {
    const val = f.value === null || f.value === undefined ? chalk.dim('(null)') : String(f.value);
    // Read-only fields are printed, never dropped, and they say WHY — the same
    // rule the browser inspector follows.
    console.log(`  ${chalk.dim('·')} ${chalk.dim(f.name.padEnd(32))} ${chalk.dim(val)}  ${chalk.dim(`— ${f.reason}`)}`);
  }
  console.log('');
  console.log(chalk.dim(`${editable.length} editable, ${locked.length} read-only`));
}

/**
 * A write's exit code follows its outcome, and `unknown` is NOT a success.
 *
 * A timed-out write may or may not have committed. Exiting 0 would tell a
 * script the change landed; exiting 1 at least tells it to go and look.
 */
function applyWriteOutcome(result, jsonMode) {
  if (result.outcome === 'saved' || result.outcome === 'created'
      || result.outcome === 'dry-run' || result.outcome === 'no-op') {
    return;
  }
  process.exitCode = 1;
  if (jsonMode) return;
  if (result.outcome === 'unknown') {
    console.error(chalk.yellow(`\n⚠ Save outcome unknown — ${result.error}`));
  } else {
    console.error(chalk.red(`\n✖ Nothing was saved — ${result.error}`));
  }
  for (const fe of result.fieldErrors ?? []) {
    console.error(chalk.red(`    ${fe.field}: ${fe.message}`));
  }
  for (const be of result.bannerErrors ?? []) {
    console.error(chalk.red(`    ${be.text}`));
  }
}

export function registerRecordCommand(program) {
  const record = program
    .command('record')
    .description('Read, edit, or clone a single Salesforce record (shared editability model with the browser extension)');

  record
    .command('get <id>')
    .description('Read a record and show which fields are editable, and why the rest are not')
    .option('--org <alias>', 'Org alias (defaults to config.defaultOrg)')
    .option('--sobject <name>', 'Skip key-prefix resolution by naming the object')
    .option('--json', 'Emit structured JSON to stdout')
    .action(async (id, options) => {
      const jsonMode = !!options.json;
      try {
        const config = await loadConfig();
        const org = resolveOrg(config, options);
        const spinner = jsonMode ? null : ora(`Reading ${id} (${org})…`).start();
        let result;
        try {
          result = await getRecord(config, id, { org, sobject: options.sobject });
          spinner?.succeed(`Read ${result.sobject} ${id}`);
        } catch (err) {
          spinner?.fail('Read failed');
          throw err;
        }
        if (jsonMode) emitJson(result);
        else printFields(result);
      } catch (err) {
        if (jsonMode) emitJsonError(err);
        else {
          console.error(chalk.red(`Read failed: ${err.message}`));
          process.exitCode = resolveExitCode(err);
        }
      }
    });

  record
    .command('edit <id>')
    .description('Update fields on a record (PATCH). Non-editable fields are refused locally, with the reason')
    .option('--org <alias>', 'Org alias (defaults to config.defaultOrg)')
    .option('--sobject <name>', 'Skip key-prefix resolution by naming the object')
    .option('--set <Field=Value>', 'Field to set; repeatable', collectSet)
    .option('--dry-run', 'Print the exact request body without sending it')
    .option('--json', 'Emit structured JSON to stdout')
    .action(async (id, options) => {
      const jsonMode = !!options.json;
      try {
        const config = await loadConfig();
        const org = resolveOrg(config, options);
        const values = parseSetPairs(options.set);
        if (Object.keys(values).length === 0) {
          throw new Error('Nothing to do — pass at least one --set Field=Value.');
        }
        const spinner = jsonMode || options.dryRun ? null : ora(`Updating ${id} (${org})…`).start();
        let result;
        try {
          result = await editRecord(config, id, values, { org, sobject: options.sobject, dryRun: options.dryRun });
          if (result.outcome === 'saved') spinner?.succeed(`Saved ${result.changed.length} field(s) on ${id}`);
          else if (result.outcome === 'no-op') spinner?.succeed('No change — the record already holds those values');
          else spinner?.warn(`Update finished with issues: ${result.outcome}`);
        } catch (err) {
          spinner?.fail('Update failed');
          throw err;
        }
        if (jsonMode) emitJson(result);
        else console.log(chalk.green(`\n${JSON.stringify(result, null, 2)}`));
        applyWriteOutcome(result, jsonMode);
      } catch (err) {
        if (jsonMode) emitJsonError(err);
        else {
          console.error(chalk.red(`Update failed: ${err.message}`));
          process.exitCode = resolveExitCode(err);
        }
      }
    });

  record
    .command('clone <id>')
    .description('Create a copy of a record from its createable fields, with optional overrides')
    .option('--org <alias>', 'Org alias (defaults to config.defaultOrg)')
    .option('--sobject <name>', 'Skip key-prefix resolution by naming the object')
    .option('--set <Field=Value>', 'Override a field on the copy; repeatable', collectSet)
    .option('--dry-run', 'Print the exact request body without sending it')
    .option('--json', 'Emit structured JSON to stdout')
    .action(async (id, options) => {
      const jsonMode = !!options.json;
      try {
        const config = await loadConfig();
        const org = resolveOrg(config, options);
        const values = parseSetPairs(options.set);
        const spinner = jsonMode || options.dryRun ? null : ora(`Cloning ${id} (${org})…`).start();
        let result;
        try {
          result = await cloneRecord(config, id, values, { org, sobject: options.sobject, dryRun: options.dryRun });
          if (result.outcome === 'created') spinner?.succeed(`Created ${result.sobject} ${result.id}`);
          else spinner?.warn(`Clone finished with issues: ${result.outcome}`);
        } catch (err) {
          spinner?.fail('Clone failed');
          throw err;
        }
        if (jsonMode) emitJson(result);
        else console.log(chalk.green(`\n${JSON.stringify(result, null, 2)}`));
        applyWriteOutcome(result, jsonMode);
      } catch (err) {
        if (jsonMode) emitJsonError(err);
        else {
          console.error(chalk.red(`Clone failed: ${err.message}`));
          process.exitCode = resolveExitCode(err);
        }
      }
    });
}
