import ora from 'ora';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { loadConfig } from '../lib/config.js';
import { createScratch, deleteScratch, listScratch, ensurePool, readPool } from '../lib/scratch-pool.js';
import { resolveExitCode } from '../lib/exit-codes.js';
import { emitJson, emitJsonError } from '../lib/output.js';

export function registerScratchCommand(program) {
  const scratch = program
    .command('scratch')
    .description('Create, delete, list, and pool Salesforce scratch orgs');

  scratch
    .command('create')
    .description('Create a scratch org from the configured definition file')
    .option('--alias <alias>', 'Alias for the new scratch org')
    .option('--days <n>', 'Duration in days (1-30)', (v) => parseInt(v, 10))
    .option('--json', 'Emit structured JSON to stdout')
    .action(async (options) => {
      const jsonMode = !!options.json;
      try {
        const config = await loadConfig();
        const spinner = jsonMode ? null : ora('Creating scratch org…').start();
        let org;
        try {
          org = await createScratch(config, { alias: options.alias, durationDays: options.days });
          spinner?.succeed(`Scratch org created${org.username ? `: ${org.username}` : ''}`);
        } catch (err) {
          spinner?.fail('Scratch creation failed');
          throw err;
        }
        if (jsonMode) emitJson(org);
        else console.log(chalk.green(JSON.stringify(org, null, 2)));
      } catch (err) {
        if (jsonMode) emitJsonError(err);
        else {
          console.error(chalk.red(`Create failed: ${err.message}`));
          process.exitCode = resolveExitCode(err);
        }
      }
    });

  scratch
    .command('delete <target>')
    .description('Delete a scratch org by alias or username')
    .option('--json', 'Emit structured JSON to stdout')
    .option('-y, --yes', 'Skip the confirmation prompt (required for non-interactive use)')
    .action(async (target, options) => {
      const jsonMode = !!options.json;
      try {
        // Deleting a scratch org is irreversible — confirm first, mirroring
        // `data delete`. Non-interactive runs must pass --yes.
        if (!options.yes) {
          const nonInteractive =
            jsonMode || process.env.SFDT_NON_INTERACTIVE === 'true' || !process.stdin.isTTY;
          if (nonInteractive) {
            throw new Error(`Refusing to delete scratch org "${target}" without confirmation — re-run with --yes to proceed.`);
          }
          const { confirmed } = await inquirer.prompt([
            { type: 'confirm', name: 'confirmed', message: `Delete scratch org "${target}"? This is irreversible.`, default: false },
          ]);
          if (!confirmed) {
            console.log(chalk.dim('Aborted — scratch org not deleted.'));
            return;
          }
        }
        await deleteScratch(target);
        if (jsonMode) emitJson({ deleted: target });
        else console.log(chalk.green(`Deleted ${target}`));
      } catch (err) {
        if (jsonMode) emitJsonError(err);
        else {
          console.error(chalk.red(`Delete failed: ${err.message}`));
          process.exitCode = resolveExitCode(err);
        }
      }
    });

  scratch
    .command('list')
    .description('List active scratch orgs')
    .option('--json', 'Emit structured JSON to stdout')
    .action(async (options) => {
      const jsonMode = !!options.json;
      try {
        const orgs = await listScratch();
        if (jsonMode) {
          emitJson({ orgs });
        } else if (orgs.length === 0) {
          console.log(chalk.yellow('No scratch orgs.'));
        } else {
          console.log('');
          for (const o of orgs) {
            console.log(`  ${(o.alias ?? '—').padEnd(20)} ${o.username}  exp:${o.expirationDate ?? '?'}`);
          }
        }
      } catch (err) {
        if (jsonMode) emitJsonError(err);
        else {
          console.error(chalk.red(`List failed: ${err.message}`));
          process.exitCode = resolveExitCode(err);
        }
      }
    });

  const pool = scratch.command('pool').description('Manage a pool of pre-created scratch orgs');

  pool
    .command('status', { isDefault: true })
    .description('Show the current scratch org pool state')
    .option('--json', 'Emit structured JSON to stdout')
    .action(async (options) => {
      const jsonMode = !!options.json;
      try {
        const config = await loadConfig();
        const state = await readPool(config);
        if (jsonMode) emitJson(state);
        else console.log(`Pool: ${state.members?.length ?? 0}/${state.size ?? 0} orgs`);
      } catch (err) {
        if (jsonMode) emitJsonError(err);
        else {
          console.error(chalk.red(`Pool status failed: ${err.message}`));
          process.exitCode = resolveExitCode(err);
        }
      }
    });

  pool
    .command('fill')
    .description('Create scratch orgs until the pool reaches the configured size')
    .option('--size <n>', 'Desired pool size (overrides config.scratch.poolSize)', (v) => parseInt(v, 10))
    .option('--json', 'Emit structured JSON to stdout')
    .action(async (options) => {
      const jsonMode = !!options.json;
      try {
        const config = await loadConfig();
        const spinner = jsonMode ? null : ora('Filling scratch org pool…').start();
        let result;
        try {
          result = await ensurePool(config, { desiredSize: options.size });
          spinner?.succeed(`Pool filled (+${result.created}, ${result.members.length}/${result.size})`);
        } catch (err) {
          spinner?.fail('Pool fill failed');
          throw err;
        }
        if (jsonMode) emitJson(result);
        else console.log(chalk.green(`Created ${result.created} org(s); pool ${result.members.length}/${result.size}`));
      } catch (err) {
        if (jsonMode) emitJsonError(err);
        else {
          console.error(chalk.red(`Pool fill failed: ${err.message}`));
          process.exitCode = resolveExitCode(err);
        }
      }
    });
}
