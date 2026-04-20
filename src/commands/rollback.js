import { loadConfig } from '../lib/config.js';
import { runScript } from '../lib/script-runner.js';
import { print } from '../lib/output.js';
import { resolveExitCode } from '../lib/exit-codes.js';

export function registerRollbackCommand(program) {
  program
    .command('rollback')
    .description('Roll back a deployment to a target org')
    .option('--org <alias>', 'Target org alias for rollback')
    .option('--dry-run', 'Show what would be executed without running')
    .action(async (options) => {
      try {
        const config = await loadConfig();
        const projectRoot = config._projectRoot;

        const orgAlias = options.org || config.defaultOrg;
        print.header(`Rolling Back (${orgAlias})${options.dryRun ? ' [dry-run]' : ''}`);

        const env = {
          SFDT_TARGET_ORG: orgAlias,
          SFDT_BACKUP_BEFORE_ROLLBACK: String(config.deployment?.backupBeforeRollback ?? true),
          SFDT_LOG_DIR: config.logDir || '',
        };

        await runScript('new/rollback.sh', config, {
          cwd: projectRoot,
          env,
          dryRun: options.dryRun,
        });

        print.success(
          options.dryRun
            ? 'Dry-run complete — no changes made.'
            : `Rollback to ${orgAlias} completed.`,
        );
      } catch (err) {
        print.error(`Rollback failed: ${err.message}`);
        process.exitCode = resolveExitCode(err);
      }
    });
}
