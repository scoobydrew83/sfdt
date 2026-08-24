import ora from 'ora';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { loadConfig } from '../lib/config.js';
import {
  exportDataSet,
  importDataSet,
  deleteDataSet,
  bulkLoadDataSet,
  listDataSets,
  readQueries,
  extractSObject,
} from '../lib/data-runner.js';
import { resolveExitCode } from '../lib/exit-codes.js';
import { emitJson, emitJsonError } from '../lib/output.js';

function resolveOrg(config, options) {
  const org = options.org ?? config.defaultOrg;
  if (!org) throw new Error('No org specified — pass --org <alias> or set defaultOrg in .sfdt/config.json');
  return org;
}

/**
 * `options` is threaded through to the runner because the bulk verbs need it
 * (--wait, --async, --line-ending); the tree verbs ignore the extra argument.
 * Passing it to every runner keeps one action factory instead of two.
 */
function makeAction(verb, fn) {
  return async (setName, options) => {
    const jsonMode = !!options.json;
    try {
      const config = await loadConfig();
      const org = resolveOrg(config, options);
      const spinner = jsonMode ? null : ora(`${verb} data set "${setName}" (${org})…`).start();
      let result;
      try {
        result = await fn(config, setName, org, options);
        spinner?.succeed(`${verb} complete: ${setName}`);
      } catch (err) {
        spinner?.fail(`${verb} failed`);
        throw err;
      }
      if (jsonMode) {
        emitJson(result);
      } else {
        console.log(chalk.green(`\n${JSON.stringify(result, null, 2)}`));
      }
    } catch (err) {
      if (jsonMode) {
        emitJsonError(err);
      } else {
        console.error(chalk.red(`${verb} failed: ${err.message}`));
        process.exitCode = resolveExitCode(err);
      }
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
        emitJson({
          ...result,
          skippedCount: skipped.length,
          errorCount: errored.length,
        });
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
        emitJsonError(err);
      } else {
        console.error(chalk.red(`Delete failed: ${err.message}`));
        process.exitCode = resolveExitCode(err);
      }
    }
  };
}

/**
 * Parse and validate `--wait`, which reaches `sf` as a number of minutes.
 * A bad value must fail here rather than being interpolated into argv, where
 * `sf` would reject it with a message about a flag the user never typed.
 */
function parseWaitMinutes(raw) {
  if (raw == null) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`--wait must be a whole number of minutes (got "${raw}").`);
  }
  return n;
}

const LINE_ENDINGS = ['LF', 'CRLF'];

/** Same reasoning as parseWaitMinutes: reject it here, not in sf's argv. */
function parseLineEnding(raw) {
  if (raw == null) return undefined;
  const v = String(raw).toUpperCase();
  if (!LINE_ENDINGS.includes(v)) {
    throw new Error(`--line-ending must be one of ${LINE_ENDINGS.join(', ')} (got "${raw}").`);
  }
  return v;
}

/**
 * `data load` runs a bulk.json data set through Bulk API v2.
 *
 * Like `delete`, bulkLoadDataSet records per-operation failures WITHOUT
 * throwing, so this action — not the runner — decides what a partial load
 * means. It exits non-zero when any operation errored, because a data set that
 * loaded three objects out of four is not a successful seed, and CI branching
 * on the exit code has no other signal.
 */
function makeLoadAction() {
  return async (setName, options) => {
    const jsonMode = !!options.json;
    try {
      const config = await loadConfig();
      const org = resolveOrg(config, options);
      const runOpts = {
        waitMinutes: parseWaitMinutes(options.wait),
        lineEnding: parseLineEnding(options.lineEnding),
        async: !!options.async,
      };

      const spinner = jsonMode ? null : ora(`Load data set "${setName}" (${org})…`).start();
      let result;
      let errored = [];
      try {
        result = await bulkLoadDataSet(config, setName, org, runOpts);
        errored = (result.operations ?? []).filter((o) => o.status === 'error');
        if (errored.length) {
          spinner?.warn(`Load finished with issues: ${setName} (${errored.length} failed)`);
        } else {
          spinner?.succeed(`Load complete: ${setName}`);
        }
      } catch (err) {
        spinner?.fail('Load failed');
        throw err;
      }

      const unmatched = (result.operations ?? []).flatMap((o) => o.unmatchedFieldMapKeys ?? []);
      const payload = { ...result, errorCount: errored.length };

      if (jsonMode) {
        emitJson(payload);
      } else {
        if (unmatched.length) {
          // A fieldMap key that matched no CSV column is a silent no-op at load
          // time: the column keeps its original header and the field simply
          // does not populate. Say so loudly.
          console.warn(chalk.yellow(`⚠ fieldMap key(s) matched no CSV column: ${[...new Set(unmatched)].join(', ')}`));
        }
        if (errored.length) {
          console.warn(chalk.red(`⚠ ${errored.length} operation(s) FAILED — see the "error" entries below.`));
        }
        console.log(chalk.green(`\n${JSON.stringify(payload, null, 2)}`));
      }
      if (errored.length) process.exitCode = 1;
    } catch (err) {
      if (jsonMode) {
        // emitJsonError sets the exit code itself.
        emitJsonError(err);
      } else {
        console.error(chalk.red(`Load failed: ${err.message}`));
        process.exitCode = resolveExitCode(err);
      }
    }
  };
}

export function registerDataCommand(program) {
  const data = program
    .command('data')
    .description('Import/export org data sets (sf tree commands, or Bulk API v2 via `load`) for sandbox & scratch seeding');

  data
    .command('list')
    .description('List configured data sets')
    .option('--json', 'Emit structured JSON to stdout')
    .action(async (options) => {
      try {
        const config = await loadConfig();
        const sets = await listDataSets(config);
        if (options.json) {
          emitJson({ sets });
        } else if (sets.length === 0) {
          console.log(chalk.yellow('No data sets found. Create one at .sfdt/data/<name>/queries.json (tree) or bulk.json (Bulk API v2).'));
        } else {
          console.log('');
          for (const s of sets) console.log(`  ${s}`);
        }
      } catch (err) {
        if (options.json) {
          emitJsonError(err);
        } else {
          console.error(chalk.red(`List failed: ${err.message}`));
          process.exitCode = resolveExitCode(err);
        }
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
    .command('load <set>')
    .description('Load a bulk data set into an org over Bulk API v2 (sf data import|upsert bulk)')
    .option('--org <alias>', 'Org alias (defaults to config.defaultOrg)')
    .option('--wait <minutes>', 'Minutes to wait for each job (default config.data.bulk.waitMinutes, or 10)')
    .option('--async', 'Queue each job and return immediately instead of waiting')
    .option('--line-ending <LF|CRLF>', 'CSV line ending (default config.data.bulk.lineEnding, or sf\'s own default)')
    .option('--json', 'Emit structured JSON to stdout')
    .action(makeLoadAction());

  data
    .command('delete <set>')
    .description('Bulk-delete the records targeted by a data set')
    .option('--org <alias>', 'Org alias (defaults to config.defaultOrg)')
    .option('--json', 'Emit structured JSON to stdout')
    .option('-y, --yes', 'Skip the confirmation prompt (required for non-interactive use)')
    .action(makeDeleteAction());
}
