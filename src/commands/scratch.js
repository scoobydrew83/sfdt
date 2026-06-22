import ora from 'ora';
import chalk from 'chalk';
import { loadConfig } from '../lib/config.js';
import { createScratch, deleteScratch, listScratch, ensurePool, readPool } from '../lib/scratch-pool.js';
import { resolveExitCode } from '../lib/exit-codes.js';

function emit(jsonMode, payload, render) {
  if (jsonMode) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  } else {
    render();
  }
}

function fail(jsonMode, verb, err) {
  if (jsonMode) {
    process.stdout.write(JSON.stringify({ status: 'error', message: err.message, exitCode: resolveExitCode(err) }) + '\n');
  } else {
    console.error(chalk.red(`${verb} failed: ${err.message}`));
  }
  process.exitCode = resolveExitCode(err);
}

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
        emit(jsonMode, { status: 'success', ...org }, () => console.log(chalk.green(JSON.stringify(org, null, 2))));
      } catch (err) {
        fail(jsonMode, 'Create', err);
      }
    });

  scratch
    .command('delete <target>')
    .description('Delete a scratch org by alias or username')
    .option('--json', 'Emit structured JSON to stdout')
    .action(async (target, options) => {
      const jsonMode = !!options.json;
      try {
        await deleteScratch(target);
        emit(jsonMode, { status: 'success', deleted: target }, () => console.log(chalk.green(`Deleted ${target}`)));
      } catch (err) {
        fail(jsonMode, 'Delete', err);
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
        emit(jsonMode, { status: 'success', orgs }, () => {
          if (orgs.length === 0) return console.log(chalk.yellow('No scratch orgs.'));
          console.log('');
          for (const o of orgs) {
            console.log(`  ${(o.alias ?? '—').padEnd(20)} ${o.username}  exp:${o.expirationDate ?? '?'}`);
          }
        });
      } catch (err) {
        fail(jsonMode, 'List', err);
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
        emit(jsonMode, { status: 'success', ...state }, () =>
          console.log(`Pool: ${state.members?.length ?? 0}/${state.size ?? 0} orgs`));
      } catch (err) {
        fail(jsonMode, 'Pool status', err);
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
        emit(jsonMode, { status: 'success', ...result }, () =>
          console.log(chalk.green(`Created ${result.created} org(s); pool ${result.members.length}/${result.size}`)));
      } catch (err) {
        fail(jsonMode, 'Pool fill', err);
      }
    });
}
