import ora from 'ora';
import chalk from 'chalk';
import { loadConfig } from '../lib/config.js';
import { runFieldImpact, runFieldUsage } from '../lib/field-impact-runner.js';
import { runOfflineFieldUsage } from '../lib/field-usage-offline.js';
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
 * `--fail-on-unreferenced` — the CI gate.
 *
 * Gates on `unreferenced === true` only. A field whose status is UNKNOWN (a
 * standard field, a failed batch) must never fail a build: the gate would then
 * be firing on our inability to check rather than on anything about the repo,
 * and the first thing anyone would do is delete the gate.
 */
function applyUnreferencedGate(vm, options, jsonMode) {
  if (!options.failOnUnreferenced) return;
  const offenders = vm.rows.filter((r) => r.unreferenced === true);
  if (offenders.length === 0) return;
  process.exitCode = 1;
  if (jsonMode) return;
  console.error(
    chalk.red(
      `\n✖ ${offenders.length} field(s) on ${vm.object} have no reference: ` +
        offenders.map((r) => r.name).join(', '),
    ),
  );
  if (vm.counts.unknown > 0) {
    // Say what the gate could NOT judge, so a green run is not read as a clean
    // bill of health for the whole object.
    console.error(
      chalk.dim(
        `  ${vm.counts.unknown} further field(s) could not be checked and did not affect this result.`,
      ),
    );
  }
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
    .option('--offline', 'Scan the repository instead of an org — no org needed, CI-friendly')
    .option('--population', 'Count non-null values per unreferenced field (one query each)')
    .option('--fail-on-unreferenced', 'Exit 1 when any field is unreferenced (a CI gate)')
    .option('--json', 'Emit structured JSON to stdout')
    .action(async (object, options) => {
      const jsonMode = !!options.json;
      const offline = !!options.offline;
      const spinner = jsonMode ? null : ora(`Sweeping ${object}…`).start();
      try {
        const config = await loadConfig();
        let vm;
        let orgAlias = null;
        if (offline) {
          // No org is resolved at all — not merely unused. A repo scan that
          // still demanded an alias would be useless in the CI job it exists for.
          vm = await runOfflineFieldUsage(config, object);
        } else {
          orgAlias = resolveOrg(config, options);
          vm = await runFieldUsage(config, orgAlias, object, {
            population: !!options.population,
          });
        }
        spinner?.stop();
        applyUnreferencedGate(vm, options, jsonMode);
        if (jsonMode) {
          emitJson({ org: orgAlias, mode: offline ? 'offline' : 'org', ...vm }, { warnings: vm.notes });
          return;
        }
        printUsage(vm, { population: !!options.population && !offline });
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
