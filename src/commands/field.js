import ora from 'ora';
import chalk from 'chalk';
import { loadConfig } from '../lib/config.js';
import { runFieldImpact } from '../lib/field-impact-runner.js';
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
}
