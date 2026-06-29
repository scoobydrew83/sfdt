import { execa } from 'execa';
import ora from 'ora';
import { loadConfig } from '../lib/config.js';
import { print } from '../lib/output.js';
import { resolveExitCode } from '../lib/exit-codes.js';
import { fetchOrgInventory } from '../lib/org-inventory.js';
import { parallelRetrieve } from '../lib/parallel-retrieve.js';
import { runSmartDeploy } from './deploy.js';

// Metadata commonly changed directly in an upstream org (e.g. admins in prod)
// that teams want to "retrofit" back into source control / lower orgs. Override
// with --metadata. Kept modest to bound the retrieve.
const DEFAULT_RETROFIT_TYPES = [
  'CustomField',
  'ValidationRule',
  'Layout',
  'CustomLabel',
  'RecordType',
  'QuickAction',
  'FlexiPage',
  'CustomApplication',
  'CompactLayout',
];

async function gitChangedFiles(cwd) {
  const res = await execa('git', ['status', '--porcelain'], { cwd, reject: false });
  return (res.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
}

async function runRetrofit(options) {
  const jsonMode = !!options.json;
  try {
    const config = await loadConfig();
    const projectRoot = config._projectRoot;
    const source = options.source;
    const target = options.target;
    // Commander maps --no-commit/--no-deploy to options.commit/options.deploy (false).
    const willCommit = options.commit !== false;
    const willDeploy = options.deploy !== false;
    if (!source) throw new Error('--source <alias> is required (the org to retrofit FROM)');
    if (!target && willDeploy) throw new Error('--target <alias> is required (the org to deploy TO), or pass --no-deploy');

    // The metadata source dirs the retrieve writes into — also the only paths we
    // ever stage (never `git add -A`, which would sweep in unrelated files).
    const stagePaths = (config.packageDirectories?.map((d) => d.path).filter(Boolean))
      || [config.defaultSourcePath || 'force-app'];

    // When we'll auto-commit, refuse to start on a dirty source tree: the retrieve
    // overwrites files in place, so pre-existing uncommitted work would be silently
    // bundled into the machine retrofit commit. Make the user stash/commit first
    // (or pass --no-commit to review + commit the result themselves).
    if (willCommit) {
      const pre = await execa('git', ['status', '--porcelain', '--', ...stagePaths], { cwd: projectRoot, reject: false });
      if ((pre.stdout || '').trim()) {
        throw new Error(
          `Uncommitted changes in the metadata source path(s) (${stagePaths.join(', ')}). ` +
            `Commit or stash them first, or re-run with --no-commit to review and commit the retrofit yourself.`,
        );
      }
    }

    const metadataTypes = options.metadata
      ? options.metadata.split(',').map((s) => s.trim()).filter(Boolean)
      : DEFAULT_RETROFIT_TYPES;

    const spinner = jsonMode ? null : ora(`Retrieving ${metadataTypes.length} type(s) from ${source}…`).start();
    let retrieved = 0;
    let total = 0;
    try {
      const inventory = await fetchOrgInventory(source, config, { metadataTypes });
      const res = await parallelRetrieve(inventory, config, {
        cwd: projectRoot,
        onProgress: ({ retrieved: r, total: t }) => {
          if (spinner) spinner.text = `Retrieving from ${source}… ${r}/${t}`;
        },
      });
      retrieved = res.retrieved;
      total = res.total;
      const errCount = res.errors?.length ?? 0;
      spinner?.succeed(`Retrieved ${retrieved}/${total} component(s) from ${source}${errCount ? ` (${errCount} batch error(s))` : ''}`);
    } catch (err) {
      spinner?.fail('Retrieve failed');
      throw err;
    }

    const changed = await gitChangedFiles(projectRoot);
    if (changed.length === 0) {
      if (jsonMode) process.stdout.write(JSON.stringify({ ok: true, retrieved, changed: 0, deployed: false }) + '\n');
      else print.success('Nothing to retrofit — source matches local source.');
      return;
    }
    if (!jsonMode) print.info(`${changed.length} changed file(s) after retrieve.`);

    if (!willCommit) {
      if (jsonMode) process.stdout.write(JSON.stringify({ ok: true, retrieved, changed: changed.length, committed: false, deployed: false }) + '\n');
      else print.info('Review the changes, then commit and deploy manually (--no-commit).');
      return;
    }

    const msg = options.commitMsg || `chore: retrofit metadata from ${source}`;
    // Stage only the metadata source dirs (computed above) — never `git add -A`.
    // Combined with the pre-retrieve clean-tree guard, the commit contains exactly
    // what this retrieve produced.
    await execa('git', ['add', '--', ...stagePaths], { cwd: projectRoot });
    await execa('git', ['commit', '-m', msg], { cwd: projectRoot });
    if (!jsonMode) print.success(`Committed retrofit: ${msg}`);

    if (!willDeploy) {
      if (jsonMode) process.stdout.write(JSON.stringify({ ok: true, retrieved, changed: changed.length, committed: true, deployed: false }) + '\n');
      else print.info('Committed; skipping deploy (--no-deploy).');
      return;
    }

    // Deploy the just-committed delta to the target via the smart-deploy path.
    // Defaults to validate-only; pass --execute for a real deploy.
    if (!jsonMode) print.header(`Deploying retrofit delta to ${target}${options.execute ? '' : ' [validate]'}`);
    await runSmartDeploy(config, {
      smart: true,
      org: target,
      deltaBase: 'HEAD~1',
      deltaHead: 'HEAD',
      dryRun: !options.execute,
      skipPreflight: options.skipPreflight,
      agent: jsonMode,
    });

    if (jsonMode) process.stdout.write(JSON.stringify({ ok: true, retrieved, changed: changed.length, committed: true, deployed: true, validateOnly: !options.execute }) + '\n');
  } catch (err) {
    if (jsonMode) process.stdout.write(JSON.stringify({ ok: false, error: err.message }) + '\n');
    else print.error(`Retrofit failed: ${err.message}`);
    process.exitCode = resolveExitCode(err);
  }
}

export function registerRetrofitCommand(program) {
  program
    .command('retrofit')
    .description('Retrofit metadata from a source org: retrieve → commit → smart-deploy to a target org')
    .requiredOption('--source <alias>', 'Org to retrieve changes FROM')
    .option('--target <alias>', 'Org to deploy changes TO (omit with --no-deploy)')
    .option('--metadata <types>', 'Comma-separated metadata types to retrieve (defaults to a common admin-changed set)')
    .option('--commit-msg <msg>', 'Commit message for the retrofit commit')
    .option('--no-commit', 'Retrieve only; leave changes uncommitted for review')
    .option('--no-deploy', 'Retrieve and commit, but do not deploy to a target')
    .option('--execute', 'Perform a real deploy to the target (default is validate-only)')
    .option('--skip-preflight', 'Skip preflight checks before deploying')
    .option('--json', 'Emit the result as JSON')
    .action((options) => runRetrofit(options));
}

export { runRetrofit, DEFAULT_RETROFIT_TYPES };
