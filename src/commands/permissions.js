import ora from 'ora';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { loadConfig } from '../lib/config.js';
import { applyPermissionChange, applyDriftFix } from '../lib/permissions-write-runner.js';
import { guardProduction } from '../lib/org-facts.js';
import {
  runPermissionMatrix,
  runOfflinePermissionMatrix,
  runPermissionDrift,
} from '../lib/permissions-runner.js';
import { resolveExitCode } from '../lib/exit-codes.js';
import { emitJson, emitJsonError } from '../lib/output.js';

function resolveOrg(config, options) {
  const org = options.org ?? config.defaultOrg;
  if (!org) throw new Error('No org specified — pass --org <alias> or set defaultOrg in .sfdt/config.json');
  return org;
}

const CELL = { edit: chalk.green('RW'), read: chalk.cyan('R '), none: chalk.dim('— ') };

function printMatrix(vm) {
  console.log('');
  const scope = vm.user ? ` · granted to ${vm.user}` : '';
  console.log(chalk.bold(`Granted permissions · ${vm.object}${scope}`));
  console.log('');

  if (vm.parents.length === 0) {
    console.log(chalk.dim('  No profile or permission set carries an entry for this object.'));
  } else {
    // Object level first — a field grant is meaningless without it.
    const o = vm.objectGranted;
    const flags = Object.entries(o)
      .filter(([, on]) => on)
      .map(([k]) => k);
    console.log(`  ${chalk.bold('Object')}  ${flags.length ? flags.join(', ') : chalk.dim('nothing granted')}`);
    console.log('');

    const width = Math.max(24, ...vm.fields.map((f) => f.field.length));
    const header = vm.parents.map((p) => (p.isProfile ? `P:${p.label}` : p.label));
    console.log(`  ${''.padEnd(width)}  ${header.map((h) => h.slice(0, 12).padEnd(12)).join(' ')}`);
    for (const row of vm.fields) {
      const cells = vm.parents.map((p) => (CELL[row.byParent[p.id] ?? 'none']).padEnd(12));
      console.log(`  ${row.field.padEnd(width)}  ${cells.join(' ')}`);
    }
    console.log('');
    console.log(
      chalk.dim(
        `${vm.counts.fields} field(s) across ${vm.counts.parents} parent(s): ` +
          `${vm.counts.editable} editable, ${vm.counts.readable - vm.counts.editable} read-only, ` +
          `${vm.counts.noAccess} with no grant`,
      ),
    );
  }

  console.log('');
  console.log(chalk.bold('Scope'));
  for (const note of vm.notes) console.log(`  ${chalk.dim('·')} ${chalk.dim(note)}`);
  console.log('');
}

const DRIFT_STYLE = {
  'extra-in-org': chalk.red,
  'missing-in-org': chalk.yellow,
  changed: chalk.yellow,
  'only-in-org': chalk.red,
  'only-in-repo': chalk.yellow,
};

function printDrift(vm) {
  console.log('');
  console.log(chalk.bold(`Permission drift · ${vm.object} · org vs repository`));
  console.log('');
  if (vm.rows.length === 0) {
    console.log(chalk.green('  No difference found between the org and this repository.'));
  }
  for (const row of vm.rows) {
    const style = DRIFT_STYLE[row.verdict] ?? ((s) => s);
    const where = row.field ? `${row.parent} · ${row.field}` : row.parent;
    console.log(`  ${style(row.verdict.padEnd(16))} ${where}`);
    if (row.field) console.log(`    ${chalk.dim(`org: ${row.org}   repo: ${row.repo}`)}`);
  }
  console.log('');
  console.log(
    chalk.dim(
      `${vm.counts.total} difference(s): ${vm.counts.extraInOrg} granted in the org but not in ` +
        `source, ${vm.counts.missingInOrg} in source but not the org, ${vm.counts.changed} changed, ` +
        `${vm.counts.unmatchedParents} parent(s) present on one side only`,
    ),
  );
  console.log('');
  console.log(chalk.bold('Scope'));
  for (const note of vm.notes) console.log(`  ${chalk.dim('·')} ${chalk.dim(note)}`);
  console.log('');
}

/**
 * `--fail-on-drift` — the CI gate.
 *
 * A parent present on only one side does NOT fail the build: labels are the only
 * thing the org and the repo can be matched on, so an unmatched parent is very
 * often a naming mismatch rather than a real access difference. Gating on it
 * would make the gate noisy and it would be turned off. Field-level differences
 * are unambiguous, so those do gate.
 */
function applyDriftGate(vm, options, jsonMode) {
  if (!options.failOnDrift) return;
  const real = vm.rows.filter((r) => r.field !== null);
  if (real.length === 0) return;
  process.exitCode = 1;
  if (jsonMode) return;
  console.error(chalk.red(`\n✖ ${real.length} permission difference(s) between the org and source.`));
  if (vm.counts.unmatchedParents > 0) {
    console.error(
      chalk.dim(
        `  ${vm.counts.unmatchedParents} parent(s) appear on only one side and did NOT affect this ` +
          `result — they are usually a label mismatch rather than an access difference.`,
      ),
    );
  }
}

/**
 * Confirm a change that alters who can see or edit data.
 *
 * Follows `data.js`'s bulk-delete pattern: `--yes` skips it, and a
 * non-interactive context REFUSES rather than auto-confirming.
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

function printWriteResult(result, level) {
  if (result.outcome === 'no-op') {
    console.log(chalk.dim('\nEvery field is already at that level — nothing to do.\n'));
    return;
  }
  if (result.outcome === 'dry-run') {
    console.log(chalk.bold(`\nWould set on ${result.parent}:`));
    for (const p of result.planned.filter((x) => x.from !== x.to)) {
      console.log(`  ${p.qualified.padEnd(40)} ${chalk.dim(p.from)} → ${chalk.cyan(p.to)}`);
    }
    console.log('');
    return;
  }
  console.log(chalk.green(`\n✔ ${result.applied.length} change(s) on ${result.parent} → ${level}`));
  for (const a of result.applied) {
    console.log(`  ${a.field.padEnd(40)} ${chalk.dim(`${a.from} → ${a.to} (${a.action})`)}`);
  }
  console.log(chalk.dim(`\n  Recorded as ${result.ledgerId} — reverse with \`sfdt ledger undo ${result.ledgerId}\`\n`));
}

/**
 * `sfdt permissions` — object and field access, read and write.
 *
 * `matrix` and `drift` read. `grant`, `revoke` and `fix` write, each behind a
 * production guard, a confirmation, `--dry-run`, and a ledger entry that records
 * the prior grant so `sfdt ledger undo` can restore it.
 *
 * Everything reported is what is **granted**; never "effective" — muting
 * permission sets subtract access and cannot be queried, so any computed union
 * is an upper bound, and every result says so rather than footnoting it. That
 * matters more now that this command can also CHANGE those grants: the thing it
 * shows you before you act is still an upper bound.
 */
export function registerPermissionsCommand(program) {
  const permissions = program
    .command('permissions')
    .description('Object and field access granted by profiles and permission sets');

  permissions
    .command('matrix <Object>')
    .description('Show what each profile and permission set grants on an object')
    .option('--org <alias>', 'Org alias (defaults to config.defaultOrg)')
    .option('--user <username>', 'Narrow to one user: their profile, permission sets and groups')
    .option('--offline', 'Read profiles and permission sets from the repository instead of an org')
    .option('--json', 'Emit structured JSON to stdout')
    .action(async (object, options) => {
      const jsonMode = !!options.json;
      const offline = !!options.offline;
      const spinner = jsonMode ? null : ora(`Reading permissions for ${object}…`).start();
      try {
        const config = await loadConfig();
        let vm;
        if (offline) {
          if (options.user) {
            // Assignments live in the org, not the repo. Saying so beats
            // silently ignoring the flag.
            throw new Error('--user needs an org: permission set assignments are not in source.');
          }
          vm = await runOfflinePermissionMatrix(config, object);
        } else {
          vm = await runPermissionMatrix(resolveOrg(config, options), object, { user: options.user });
        }
        spinner?.stop();
        if (jsonMode) {
          emitJson({ mode: offline ? 'offline' : 'org', ...vm }, { warnings: vm.notes });
          return;
        }
        printMatrix(vm);
      } catch (err) {
        spinner?.stop();
        if (jsonMode) emitJsonError(err);
        else {
          console.error(chalk.red(`Permissions matrix failed: ${err.message}`));
          process.exitCode = resolveExitCode(err);
        }
      }
    });

  permissions
    .command('drift <Object>')
    .description('Compare what the org grants against what this repository declares')
    .option('--org <alias>', 'Org alias (defaults to config.defaultOrg)')
    .option('--fail-on-drift', 'Exit 1 when any field-level permission differs')
    .option('--json', 'Emit structured JSON to stdout')
    .action(async (object, options) => {
      const jsonMode = !!options.json;
      const spinner = jsonMode ? null : ora('Comparing org against source…').start();
      try {
        const config = await loadConfig();
        const vm = await runPermissionDrift(config, resolveOrg(config, options), object);
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
          console.error(chalk.red(`Permissions drift failed: ${err.message}`));
          process.exitCode = resolveExitCode(err);
        }
      }
    });

  for (const [verb, defaultLevel] of [['grant', 'read'], ['revoke', 'none']]) {
    permissions
      .command(`${verb} <Object.Field...>`)
      .description(`${verb === 'grant' ? 'Grant' : 'Remove'} field access for a permission set`)
      .requiredOption('--parent <label>', 'Permission set label (profiles are not writable this way)')
      .option('--level <level>', 'read or edit (grant only)', defaultLevel)
      .option('--org <alias>', 'Org alias (defaults to config.defaultOrg)')
      .option('--dry-run', 'Show exactly what would change, and change nothing')
      .option('--yes', 'Skip the confirmation prompt')
      .option('--production', 'Acknowledge that the target org is production')
      .option('--json', 'Emit structured JSON to stdout')
      .action(async (fields, options) => {
        const jsonMode = !!options.json;
        try {
          const config = await loadConfig();
          const orgAlias = resolveOrg(config, options);
          const level = verb === 'revoke' ? 'none' : options.level;

          if (!options.dryRun) {
            await guardProduction(orgAlias, options, 'change who can see or edit data in it');
            const ok = await confirmChange(
              `set ${fields.length} field grant(s) to "${level}" on ${options.parent} in ${orgAlias}`,
              [...fields, 'Recorded in the ledger; reversible with `sfdt ledger undo`.'],
              options,
              jsonMode,
            );
            if (!ok) return;
          }

          const result = await applyPermissionChange(config, orgAlias, {
            parent: options.parent,
            fields,
            level,
            dryRun: !!options.dryRun,
          });

          if (jsonMode) {
            emitJson(result);
            return;
          }
          printWriteResult(result, level);
        } catch (err) {
          if (jsonMode) emitJsonError(err);
          else {
            console.error(chalk.red(`Permissions ${verb} failed: ${err.message}`));
            process.exitCode = resolveExitCode(err);
          }
        }
      });
  }

  permissions
    .command('fix <Object>')
    .description('Apply the grants source declares but the org is missing (the bulk fix)')
    .option('--org <alias>', 'Org alias (defaults to config.defaultOrg)')
    .option('--dry-run', 'Show exactly what would change, and change nothing')
    .option('--yes', 'Skip the confirmation prompt')
    .option('--production', 'Acknowledge that the target org is production')
    .option('--json', 'Emit structured JSON to stdout')
    .action(async (object, options) => {
      const jsonMode = !!options.json;
      const spinner = jsonMode ? null : ora('Comparing org against source…').start();
      try {
        const config = await loadConfig();
        const orgAlias = resolveOrg(config, options);
        spinner?.stop();

        if (!options.dryRun) {
          await guardProduction(orgAlias, options, 'change who can see or edit data in it');
          const ok = await confirmChange(
            `apply this repository's declared grants for ${object} to ${orgAlias}`,
            [
              'Only grants MISSING in the org are applied.',
              'Grants the org has but source does not are left alone.',
              'Recorded in the ledger; reversible with `sfdt ledger undo`.',
            ],
            options,
            jsonMode,
          );
          if (!ok) return;
        }

        const result = await applyDriftFix(config, orgAlias, object, { dryRun: !!options.dryRun });
        if (jsonMode) {
          emitJson(result, { warnings: result.notes ?? [] });
          return;
        }
        if (result.outcome === 'no-op') {
          console.log(chalk.green(`\n✔ ${object}: the org already grants everything source declares.\n`));
          return;
        }
        console.log('');
        for (const batch of result.results ?? []) printWriteResult(batch, 'source');
        for (const note of result.notes ?? []) console.log(`  ${chalk.dim('·')} ${chalk.dim(note)}`);
        console.log('');
      } catch (err) {
        spinner?.stop();
        if (jsonMode) emitJsonError(err);
        else {
          console.error(chalk.red(`Permissions fix failed: ${err.message}`));
          process.exitCode = resolveExitCode(err);
        }
      }
    });
}
