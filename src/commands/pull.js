import path from 'path';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { execa } from 'execa';
import { loadConfig } from '../lib/config.js';
import { fetchOrgInventory } from '../lib/org-inventory.js';
import { initCache, getDelta, updateCache, getCacheStatus } from '../lib/pull-cache.js';
import { parallelRetrieve } from '../lib/parallel-retrieve.js';
import { print } from '../lib/output.js';
import { resolveExitCode } from '../lib/exit-codes.js';

export function registerPullCommand(program) {
  program
    .command('pull')
    .description('Pull metadata changes from the default org')
    .option('--dry-run', 'show what would be retrieved without retrieving')
    .option('--full', 'force full retrieve and rebuild cache')
    .option('--status', 'show cache status and exit')
    .action(async (options) => {
      try {
        await runPull(options);
      } catch (err) {
        print.error(`Pull failed: ${err.message}`);
        process.exitCode = resolveExitCode(err);
      }
    });
}

async function runPull(options) {
  const config = await loadConfig();
  const { _projectRoot: projectRoot, _configDir: configDir, defaultOrg: orgAlias } = config;

  if (!orgAlias) throw new Error('No defaultOrg in .sfdt/config.json — run sfdt init first.');

  const cacheDir = path.join(configDir, 'cache');

  if (options.status) {
    const db = initCache(cacheDir, orgAlias);
    const status = getCacheStatus(db, orgAlias);
    db.close();
    if (!status.lastSync) {
      console.log(chalk.yellow('No cache — run sfdt pull to initialize'));
    } else {
      console.log(chalk.green(`Cache: ${status.componentCount} components, last sync ${status.lastSync}`));
    }
    return;
  }

  if (options.full) {
    await smartPull(config, { projectRoot, cacheDir, orgAlias, full: true, dryRun: options.dryRun });
    return;
  }

  const pullGroups = config.pullConfig?.pullGroups ?? {};
  const groupChoices = Object.entries(pullGroups).map(([key, g]) => ({
    name: g.description ?? key,
    value: `group:${key}`,
  }));

  const choices = [
    { name: 'Pull changes (smart delta)', value: 'smart' },
    { name: 'Pull all changes (full retrieve)', value: 'full' },
    { name: 'Preview changes only', value: 'preview' },
    { name: 'Pull with conflict detection', value: 'conflict' },
    { name: 'Reset local source tracking', value: 'reset' },
    { name: 'Pull standard profiles only', value: 'profiles' },
    ...groupChoices,
  ];

  const { action } = await inquirer.prompt([{ type: 'list', name: 'action', message: 'Select pull action:', choices }]);

  switch (action) {
    case 'smart':
      await smartPull(config, { projectRoot, cacheDir, orgAlias, dryRun: options.dryRun });
      break;
    case 'full':
      await smartPull(config, { projectRoot, cacheDir, orgAlias, full: true, dryRun: options.dryRun });
      break;
    case 'preview':
      await execa('sf', ['project', 'retrieve', 'preview', '--target-org', orgAlias], { stdio: 'inherit', cwd: projectRoot });
      break;
    case 'conflict':
      await execa('sf', ['project', 'retrieve', 'start', '--verbose', '--target-org', orgAlias], { stdio: 'inherit', cwd: projectRoot });
      break;
    case 'reset':
      await execa('sf', ['project', 'reset', 'tracking', '--no-prompt', '--target-org', orgAlias], { stdio: 'inherit', cwd: projectRoot });
      break;
    case 'profiles':
      await pullProfiles(config, projectRoot, orgAlias);
      break;
    default:
      if (action.startsWith('group:')) {
        await pullGroup(config, projectRoot, orgAlias, action.slice(6));
      }
  }
}

async function smartPull(config, { projectRoot, cacheDir, orgAlias, full = false, dryRun = false }) {
  const spinner = ora('Fetching org inventory...').start();
  let freshInventory;
  try {
    freshInventory = await fetchOrgInventory(orgAlias, null, { withDates: true });
    const total = [...freshInventory.values()].reduce((n, m) => n + m.size, 0);
    spinner.succeed(`Fetched ${total} components from org`);
  } catch (err) {
    spinner.fail('Failed to fetch org inventory');
    throw err;
  }

  const db = initCache(cacheDir, orgAlias);
  const delta = full ? inventoryToDelta(freshInventory) : getDelta(db, freshInventory);
  const deltaCount = [...delta.values()].reduce((n, s) => n + s.size, 0);

  if (deltaCount === 0 && !full) {
    db.close();
    console.log(chalk.green('Nothing to pull — org is up to date'));
    return;
  }

  console.log(chalk.cyan(`${deltaCount} component(s) to retrieve`));

  if (dryRun) {
    for (const [type, names] of delta) {
      for (const name of names) console.log(`  ${type}:${name}`);
    }
    db.close();
    return;
  }

  const spinner2 = ora('Retrieving changes...').start();
  const result = await parallelRetrieve(delta, config, {
    cwd: projectRoot,
    onProgress: ({ retrieved, total }) => { spinner2.text = `Retrieving... ${retrieved}/${total}`; },
  });
  spinner2.succeed(`Retrieved ${result.retrieved}/${result.total} component(s)`);

  if (result.errors.length > 0) {
    console.error(chalk.yellow(`${result.errors.length} batch(es) had errors:`));
    result.errors.forEach((e) => console.error(chalk.red(`  ${e.error}`)));
  }

  updateCache(db, freshInventory);
  db.close();
  print.success('Cache updated');
}

function inventoryToDelta(inventory) {
  const delta = new Map();
  for (const [type, members] of inventory) {
    delta.set(type, new Set(members.keys()));
  }
  return delta;
}

async function pullProfiles(config, projectRoot, orgAlias) {
  const excluded = config.pullConfig?.excludedProfiles ?? [];
  const args = ['project', 'retrieve', 'start', '--metadata', 'Profile', '--target-org', orgAlias];
  if (excluded.length > 0) args.push('--ignore-conflicts');
  await execa('sf', args, { stdio: 'inherit', cwd: projectRoot });
}

async function pullGroup(config, projectRoot, orgAlias, groupKey) {
  const group = config.pullConfig?.pullGroups?.[groupKey];
  if (!group) throw new Error(`Pull group "${groupKey}" not found in pullConfig`);
  const typeArgs = (group.metadata ?? []).flatMap((t) => ['--metadata', t]);
  await execa('sf', ['project', 'retrieve', 'start', ...typeArgs, '--target-org', orgAlias], { stdio: 'inherit', cwd: projectRoot });
}
