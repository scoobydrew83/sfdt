import { loadConfig } from '../lib/config.js';
import { runScript } from '../lib/script-runner.js';
import { print } from '../lib/output.js';
import { resolveExitCode } from '../lib/exit-codes.js';
import path from 'path';

export function registerRollbackCommand(program) {
  program
    .command('rollback')
    .description('Roll back a deployment to a target org')
    .option('--org <alias>', 'Target org alias for rollback')
    .option('--dry-run', 'Show what would be executed without running')
    .option('--json', 'Emit structured JSON to stdout (CI mode)')
    .action(async (options) => {
      try {
        const config = await loadConfig();
        const projectRoot = config._projectRoot;
        const orgAlias = options.org || config.defaultOrg;
        const jsonMode = !!options.json;

        if (!jsonMode) {
          print.header(`Rolling Back (${orgAlias})${options.dryRun ? ' [dry-run]' : ''}`);
        }

        const env = {
          SFDT_TARGET_ORG: orgAlias,
          SFDT_BACKUP_BEFORE_ROLLBACK: String(config.deployment?.backupBeforeRollback ?? true),
          SFDT_LOG_DIR: config.logDir || '',
        };

        const result = await runScript('ops/rollback.sh', config, {
          cwd: projectRoot,
          env,
          dryRun: options.dryRun,
        });

        if (jsonMode) {
          process.stdout.write(
            JSON.stringify({
              status: 'success',
              org: orgAlias,
              timestamp: new Date().toISOString(),
              exitCode: 0,
              log: result.stdout ?? '',
            }, null, 2) + '\n',
          );
        } else {
          print.success(
            options.dryRun ? 'Dry-run complete — no changes made.' : `Rollback to ${orgAlias} completed.`,
          );
        }
      } catch (err) {
        if (options.json) {
          process.stdout.write(
            JSON.stringify({ status: 'error', message: err.message, exitCode: resolveExitCode(err) }) + '\n',
          );
        } else {
          print.error(`Rollback failed: ${err.message}`);
        }
        process.exitCode = resolveExitCode(err);
      }
    });
}
