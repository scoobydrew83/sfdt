import { loadConfig } from '../lib/config.js';
import { runScript } from '../lib/script-runner.js';
import { print } from '../lib/output.js';
import { resolveExitCode } from '../lib/exit-codes.js';

export function registerPreflightCommand(program) {
  program
    .command('preflight')
    .description('Run pre-deployment validation checks')
    .option('--strict', 'Fail on any warning')
    .option('--dry-run', 'Show what would be executed without running')
    .action(async (options) => {
      try {
        const config = await loadConfig();
        const projectRoot = config._projectRoot;

        print.header(`Pre-flight Checks${options.dryRun ? ' [dry-run]' : ''}`);

        const env = {};
        if (options.strict) {
          env.SFDT_PREFLIGHT_STRICT = 'true';
        }

        await runScript('new/preflight.sh', config, {
          cwd: projectRoot,
          env,
          dryRun: options.dryRun,
        });

        print.success(
          options.dryRun ? 'Dry-run complete — no changes made.' : 'Pre-flight checks passed.',
        );
      } catch (err) {
        print.error(`Pre-flight checks failed: ${err.message}`);
        process.exitCode = resolveExitCode(err);
      }
    });
}
