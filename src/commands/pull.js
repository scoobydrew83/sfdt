import { loadConfig } from '../lib/config.js';
import { runScript } from '../lib/script-runner.js';
import { print } from '../lib/output.js';
import { resolveExitCode } from '../lib/exit-codes.js';

export function registerPullCommand(program) {
  program
    .command('pull')
    .description('Pull metadata changes from the default org')
    .option('--dry-run', 'Show what would be executed without running')
    .action(async (options) => {
      try {
        const config = await loadConfig();
        const projectRoot = config._projectRoot;

        print.header(`Pulling Org Updates${options.dryRun ? ' [dry-run]' : ''}`);

        await runScript('core/pull-org-updates.sh', config, {
          cwd: projectRoot,
          dryRun: options.dryRun,
        });

        print.success(
          options.dryRun ? 'Dry-run complete — no changes made.' : 'Pull completed successfully.',
        );
      } catch (err) {
        print.error(`Pull failed: ${err.message}`);
        process.exitCode = resolveExitCode(err);
      }
    });
}
