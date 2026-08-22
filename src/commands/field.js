import ora from 'ora';
import chalk from 'chalk';
import { loadConfig } from '../lib/config.js';
import { runFieldImpact, runFieldUsage } from '../lib/field-impact-runner.js';
import { resolveExitCode } from '../lib/exit-codes.js';
import { emitJson, emitJsonError } from '../lib/output.js';

function resolveOrg(config, options) {
  const org = options.org ?? config.defaultOrg;
  if (!org) throw new Error('No org specified — pass --org <alias> or set defaultOrg in .sfdt/config.json');
  return org;
}

/**
 * Render the scan.
 *
 * The notes are printed BEFORE the verdict line and are never collapsed behind a
 * flag. A run that could not read half the org and a run that read all of it
 * both end in "0 writers found"; the notes are the only thing that distinguishes
 * them, so burying them would make the headline actively misleading.
 */
function printImpact(vm) {
  console.log('');
  console.log(chalk.bold(`What writes ${vm.object}.${vm.field}?`));
  console.log('');

  if (vm.rows.length === 0) {
    console.log(chalk.dim('  No writer found by the sources scanned.'));
  } else {
    for (const row of vm.rows) {
      const badge = row.status === 'confirmed'
        ? chalk.green('confirmed')
        : chalk.yellow(' inferred');
      const label = row.label && row.label !== row.name ? `${row.name} ${chalk.dim(`(${row.label})`)}` : row.name;
      console.log(`  [${badge}] ${chalk.bold(row.typeLabel.padEnd(22))} ${label}`);
      console.log(`             ${chalk.dim(row.detail)}`);
      if (row.url) console.log(`             ${chalk.dim(row.url)}`);
    }
    console.log('');
    console.log(chalk.dim(`${vm.counts.confirmed} confirmed, ${vm.counts.inferred} inferred, ${vm.counts.total} total`));
  }

  // A SEPARATE section, never merged into the writer rows. "What writes this
  // field" and "where does this field appear" are different questions; a
  // validation rule listed among the writers would answer the wrong one.
  if (vm.references.length > 0) {
    console.log('');
    console.log(chalk.bold(`Also referenced by (${vm.referenceCount}) — these do not write it`));
    for (const group of vm.references) {
      console.log(`  ${chalk.bold(group.type)}`);
      for (const name of group.names) console.log(`    ${name}`);
    }
  }

  if (vm.notes.length > 0) {
    console.log('');
    console.log(chalk.bold('Scan scope'));
    for (const note of vm.notes) {
      console.log(`  ${chalk.dim('·')} ${chalk.dim(note)}`);
    }
  }
  console.log('');
  // Said on every run, including a clean one — especially a clean one. An
  // `inferred` row is a lead, and an empty result is the absence of evidence
  // from three bounded scans, not evidence of absence.
  console.log(chalk.dim('An inferred row is a lead, not a write. See the scan scope above for what was not checked.'));
}


/**
 * Render the sweep.
 *
 * Three bands, kept visually distinct because conflating them is the whole
 * failure mode: **unreferenced** (nothing found), **unknown** (not scanned —
 * NOT clean), and referenced. A standard field always lands in unknown, because
 * a dependency sweep can say nothing about one.
 */
function printUsage(vm, { population }) {
  console.log('');
  console.log(chalk.bold(`Field usage · ${vm.object}`));
  console.log('');

  const band = (rows, title, colour) => {
    if (rows.length === 0) return;
    console.log(colour(`  ${title}`));
    for (const row of rows) {
      const flag = row.safeToRemove === true ? chalk.green(' ✔ safe to remove') : '';
      const pop =
        row.populated === null
          ? ''
          : chalk.dim(` · ${row.populated} value(s)${row.totalRecords ? ` of ${row.totalRecords}` : ''}`);
      const why = row.keepReason && row.safeToRemove === false ? chalk.dim(` — ${row.keepReason}`) : '';
      console.log(`    ${row.name.padEnd(38)} ${chalk.dim(row.type.padEnd(12))}${pop}${flag}${why}`);
    }
    console.log('');
  };

  band(vm.rows.filter((r) => r.unreferenced === true), 'No reference found', chalk.bold.yellow);
  band(vm.rows.filter((r) => r.unreferenced === null), 'Not scanned — status unknown', chalk.bold.dim);
  band(vm.rows.filter((r) => r.unreferenced === false), 'Referenced', chalk.bold.green);

  console.log(
    chalk.dim(
      `${vm.counts.total} field(s): ${vm.counts.unreferenced} unreferenced, ` +
        `${vm.counts.unknown} unknown, ${vm.counts.scanned - vm.counts.unreferenced} referenced` +
        (population ? `, ${vm.counts.safeToRemove} safe to remove` : ''),
    ),
  );

  if (vm.notes.length > 0) {
    console.log('');
    console.log(chalk.bold('Scan scope'));
    for (const note of vm.notes) console.log(`  ${chalk.dim('·')} ${chalk.dim(note)}`);
  }
  console.log('');
}

/**
 * `sfdt field` — field-level analysis over an org.
 *
 * Read-only. The engine is `@sfdt/flow-core`'s `analyzeFieldImpact`, shared with
 * the Chrome extension so both surfaces scan to the same depth and hedge in the
 * same words.
 */
export function registerFieldCommand(program) {
  const field = program
    .command('field')
    .description('Analyze how a field is used across an org');

  field
    .command('impact <Object.Field>')
    .description('Show what writes a field — flows, workflow field updates, and Apex')
    .option('--org <alias>', 'Org alias (defaults to config.defaultOrg)')
    .option('--links', 'Resolve the org instance URL so results carry Setup deep links (one extra call)')
    .option('--json', 'Emit structured JSON to stdout')
    .action(async (ref, options) => {
      const jsonMode = !!options.json;
      const spinner = jsonMode ? null : ora('Scanning…').start();
      try {
        const config = await loadConfig();
        const orgAlias = resolveOrg(config, options);
        const vm = await runFieldImpact(orgAlias, ref, { links: !!options.links });
        spinner?.stop();
        if (jsonMode) {
          // The notes travel in the envelope's `warnings` as well as the result
          // body: an agent reading only the top-level envelope must not miss the
          // caveats that decide what the row list is worth.
          emitJson({ org: orgAlias, ...vm }, { warnings: vm.notes });
          return;
        }
        printImpact(vm);
      } catch (err) {
        spinner?.stop();
        if (jsonMode) {
          emitJsonError(err);
        } else {
          console.error(chalk.red(`Field impact failed: ${err.message}`));
          process.exitCode = resolveExitCode(err);
        }
      }
    });

  field
    .command('usage <Object>')
    .description('Sweep every field on an object for references, and optionally for data')
    .option('--org <alias>', 'Org alias (defaults to config.defaultOrg)')
    .option('--population', 'Count non-null values per unreferenced field (one query each)')
    .option('--json', 'Emit structured JSON to stdout')
    .action(async (object, options) => {
      const jsonMode = !!options.json;
      const spinner = jsonMode ? null : ora(`Sweeping ${object}…`).start();
      try {
        const config = await loadConfig();
        const orgAlias = resolveOrg(config, options);
        const vm = await runFieldUsage(config, orgAlias, object, {
          population: !!options.population,
        });
        spinner?.stop();
        if (jsonMode) {
          emitJson({ org: orgAlias, ...vm }, { warnings: vm.notes });
          return;
        }
        printUsage(vm, { population: !!options.population });
      } catch (err) {
        spinner?.stop();
        if (jsonMode) {
          emitJsonError(err);
        } else {
          console.error(chalk.red(`Field usage failed: ${err.message}`));
          process.exitCode = resolveExitCode(err);
        }
      }
    });
}
