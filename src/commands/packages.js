import ora from 'ora';
import chalk from 'chalk';
import { loadConfig } from '../lib/config.js';
import { listPackages, comparePackages, writePackageNote } from '../lib/packages-runner.js';
import { resolveExitCode } from '../lib/exit-codes.js';
import { emitJson, emitJsonError } from '../lib/output.js';

function resolveOrg(config, options) {
  const org = options.org ?? config.defaultOrg;
  if (!org) throw new Error('No org specified — pass --org <alias> or set defaultOrg in .sfdt/config.json');
  return org;
}

const STATUS_STYLE = {
  'update-available': (s) => chalk.yellow(s),
  'ahead-of-record': (s) => chalk.cyan(s),
  current: (s) => chalk.green(s),
  unknown: (s) => chalk.dim(s),
};

function printPackages(vm) {
  console.log('');
  console.log(chalk.bold(`Installed packages · ${vm.org}`));
  console.log('');
  if (vm.rows.length === 0) {
    console.log(chalk.dim('  Nothing installed.'));
  }
  for (const row of vm.rows) {
    const style = STATUS_STYLE[row.updateStatus] ?? ((s) => s);
    const ns = row.namespace ? chalk.dim(`  ${row.namespace}`) : chalk.dim('  (unmanaged)');
    console.log(`  ${row.name.padEnd(38)} ${(row.versionText ?? '?').padEnd(12)} ${style(row.updateStatus)}${ns}`);
    if (row.updateStatus === 'update-available' || row.updateStatus === 'ahead-of-record') {
      console.log(`    ${chalk.dim(row.updateDetail)}`);
    }
    if (row.note?.url) console.log(`    ${chalk.dim(row.note.url)}`);
  }
  console.log('');
  console.log(
    chalk.dim(
      `${vm.counts.total} installed · ${vm.counts.managed} managed, ${vm.counts.unmanaged} unmanaged` +
        ` · ${vm.counts.updateAvailable} with a newer version recorded, ${vm.counts.unknown} not tracked`,
    ),
  );
  if (vm.notes.length > 0) {
    console.log('');
    console.log(chalk.bold('Notes'));
    for (const n of vm.notes) console.log(`  ${chalk.dim('·')} ${chalk.dim(n)}`);
  }
  console.log('');
}

const VERDICT_STYLE = {
  'source-ahead': chalk.yellow,
  'target-ahead': chalk.yellow,
  'only-in-source': chalk.magenta,
  'only-in-target': chalk.magenta,
  unknown: chalk.dim,
  same: chalk.green,
};

function printDrift(vm) {
  console.log('');
  console.log(chalk.bold(`Package drift · ${vm.source} → ${vm.target}`));
  console.log('');
  for (const row of vm.rows) {
    const style = VERDICT_STYLE[row.verdict] ?? ((s) => s);
    console.log(`  ${row.name.padEnd(38)} ${style(row.verdict)}`);
    if (row.verdict !== 'same') console.log(`    ${chalk.dim(row.detail)}`);
  }
  console.log('');
  console.log(
    chalk.dim(
      `${vm.counts.total} package(s): ${vm.counts.same} matching, ${vm.counts.drifted} drifted, ` +
        `${vm.counts.unknown} not compared`,
    ),
  );
  if (vm.notes.length > 0) {
    console.log('');
    console.log(chalk.bold('Notes'));
    for (const n of vm.notes) console.log(`  ${chalk.dim('·')} ${chalk.dim(n)}`);
  }
  console.log('');
}

/**
 * `--fail-on-drift` — the CI gate.
 *
 * Fires on a real difference only. `unknown` never fails a build: a package
 * whose version could not be read is our inability to compare, not evidence the
 * orgs differ, and a gate that fires on it would be deleted within a week.
 */
function applyDriftGate(vm, options, jsonMode) {
  if (!options.failOnDrift) return;
  const drifted = vm.rows.filter((r) => r.verdict !== 'same' && r.verdict !== 'unknown');
  if (drifted.length === 0) return;
  process.exitCode = 1;
  if (jsonMode) return;
  console.error(chalk.red(`\n✖ ${drifted.length} package(s) differ between ${vm.source} and ${vm.target}.`));
  if (vm.counts.unknown > 0) {
    console.error(
      chalk.dim(`  ${vm.counts.unknown} further package(s) could not be compared and did not affect this result.`),
    );
  }
}

/**
 * `sfdt packages` — installed package inventory.
 *
 * `list` and `compare` are read-only. `note` writes `.sfdt/packages.json`, a
 * committed repo file — which is the point: Salesforce has no API for the latest
 * available version of a managed package, so the only durable answer is one a
 * human records, and recording it in the repo makes it reviewable and shared
 * rather than trapped in one person's browser.
 */
export function registerPackagesCommand(program) {
  const packages = program
    .command('packages')
    .description('Installed package inventory, annotations, and cross-org version drift');

  packages
    .command('list')
    .description('List installed packages with their versions and any recorded notes')
    .option('--org <alias>', 'Org alias (defaults to config.defaultOrg)')
    .option('--json', 'Emit structured JSON to stdout')
    .action(async (options) => {
      const jsonMode = !!options.json;
      const spinner = jsonMode ? null : ora('Reading installed packages…').start();
      try {
        const config = await loadConfig();
        const orgAlias = resolveOrg(config, options);
        const vm = await listPackages(config, orgAlias);
        spinner?.stop();
        if (jsonMode) {
          emitJson(vm, { warnings: vm.notes });
          return;
        }
        printPackages(vm);
      } catch (err) {
        spinner?.stop();
        if (jsonMode) emitJsonError(err);
        else {
          console.error(chalk.red(`Packages list failed: ${err.message}`));
          process.exitCode = resolveExitCode(err);
        }
      }
    });

  packages
    .command('compare')
    // Same flag names as `sfdt compare`, so the two-org convention is one thing
    // to learn rather than two.
    .description('Compare installed package versions between two orgs')
    .option('--source <alias>', 'Source org alias')
    .option('--target <alias>', 'Target org alias (defaults to config.defaultOrg)')
    .option('--fail-on-drift', 'Exit 1 when any package differs')
    .option('--json', 'Emit structured JSON to stdout')
    .action(async (options) => {
      const jsonMode = !!options.json;
      const spinner = jsonMode ? null : ora('Comparing orgs…').start();
      try {
        const config = await loadConfig();
        const source = options.source;
        const target = options.target ?? config.defaultOrg;
        if (!source || !target) {
          throw new Error('Both orgs are required — pass --source <alias> and --target <alias>.');
        }
        if (source === target) {
          throw new Error(`--source and --target are both "${source}"; nothing to compare.`);
        }
        const vm = await comparePackages(source, target);
        spinner?.stop();
        applyDriftGate(vm, options, jsonMode);
        if (jsonMode) {
          emitJson(vm, { warnings: vm.notes });
          return;
        }
        printDrift(vm);
      } catch (err) {
        spinner?.stop();
        if (jsonMode) emitJsonError(err);
        else {
          console.error(chalk.red(`Packages compare failed: ${err.message}`));
          process.exitCode = resolveExitCode(err);
        }
      }
    });

  packages
    .command('note <namespace>')
    .description('Record the vendor URL and latest known version for a package (writes .sfdt/packages.json)')
    .option('--url <url>', 'Vendor listing or release-notes URL')
    .option('--latest <version>', 'The version you have confirmed is current, e.g. 3.10.0')
    .option('--owner <name>', 'Who owns this vendor relationship internally')
    .option('--notes <text>', 'Free-text note')
    .option('--json', 'Emit structured JSON to stdout')
    .action(async (namespace, options) => {
      const jsonMode = !!options.json;
      try {
        const config = await loadConfig();
        // Only flags the user actually passed are sent, so an omitted flag
        // leaves that field alone rather than clearing it.
        const patch = {};
        if (options.url !== undefined) patch.url = options.url;
        if (options.latest !== undefined) patch.latestKnown = options.latest;
        if (options.owner !== undefined) patch.owner = options.owner;
        if (options.notes !== undefined) patch.notes = options.notes;
        if (Object.keys(patch).length === 0) {
          throw new Error('Nothing to record — pass at least one of --url, --latest, --owner, --notes.');
        }
        const result = await writePackageNote(config, namespace, patch);
        if (jsonMode) {
          emitJson({ ...result, namespace });
          return;
        }
        console.log(chalk.green(`\n✔ Recorded ${namespace} in ${result.file}`));
        for (const [k, v] of Object.entries(result.note)) {
          console.log(`  ${chalk.dim(k.padEnd(16))} ${v}`);
        }
        console.log('');
        console.log(chalk.dim('Commit this file — the annotation is for the whole team, not one machine.'));
      } catch (err) {
        if (jsonMode) emitJsonError(err);
        else {
          console.error(chalk.red(`Packages note failed: ${err.message}`));
          process.exitCode = resolveExitCode(err);
        }
      }
    });
}
