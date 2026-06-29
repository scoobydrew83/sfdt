import path from 'path';
import { loadConfig } from '../lib/config.js';
import { runScript } from '../lib/script-runner.js';
import { print, emitJson, emitJsonError } from '../lib/output.js';
import { resolveExitCode } from '../lib/exit-codes.js';
import { writeRawLog } from '../lib/log-writer.js';

export function registerRollbackCommand(program) {
  program
    .command('rollback')
    .description('Roll back a deployment to a target org')
    .option('--org <alias>', 'Target org alias for rollback')
    .option('--dry-run', 'Show what would be executed without running')
    .option('--json', 'Emit structured JSON to stdout (CI mode)')
    .action(async (options) => {
      const jsonMode = !!options.json;
      try {
        const config = await loadConfig();
        const projectRoot = config._projectRoot;
        const orgAlias = options.org || config.defaultOrg;

        if (!jsonMode) {
          print.header(`Rolling Back (${orgAlias})${options.dryRun ? ' [dry-run]' : ''}`);
        }

        const env = {
          SFDT_TARGET_ORG: orgAlias,
          SFDT_BACKUP_BEFORE_ROLLBACK: String(config.deployment?.backupBeforeRollback ?? true),
          SFDT_LOG_DIR: config.logDir || '',
        };

        const rollbackStart = Date.now();
        const result = await runScript('ops/rollback.sh', config, {
          cwd: projectRoot,
          env,
          dryRun: options.dryRun,
          captureStdout: true,
        });
        const durationMs = Date.now() - rollbackStart;

        if (!options.dryRun) {
          const logDir = config.logDir ?? path.join(projectRoot, 'logs');
          await writeRawLog(logDir, 'rollback', result.stdout ?? '', {
            org: orgAlias,
            exitCode: 0,
            durationMs,
            retention: config.logRetention ?? 50,
          }).catch((e) => console.debug('Log write failed:', e.message));
        }

        if (jsonMode) {
          emitJson({
            org: orgAlias,
            timestamp: new Date().toISOString(),
            dryRun: !!options.dryRun,
            log: result.stdout ?? '',
          });
        } else {
          print.success(
            options.dryRun ? 'Dry-run complete — no changes made.' : `Rollback to ${orgAlias} completed.`,
          );
        }
      } catch (err) {
        // rollback.sh uses captureStdout: true, so every print_* helper in the
        // script (all of which write to stdout) lands in err.stdout instead
        // of the console. Without surfacing it, a failure shows up as just
        // "Script exited with code 1" with no clue why. Replay the captured
        // stdout so users — and CI logs — can see what actually went wrong.
        if (err.stdout) {
          process.stderr.write(err.stdout.toString());
          if (!err.stdout.toString().endsWith('\n')) process.stderr.write('\n');
        }
        if (jsonMode) {
          emitJsonError(err, {
            data: { dryRun: !!options.dryRun, log: err.stdout ? err.stdout.toString() : '' },
          });
        } else {
          print.error(`Rollback failed: ${err.message}`);
          process.exitCode = resolveExitCode(err);
        }
      }
    });
}
