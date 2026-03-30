import { loadConfig } from '../lib/config.js';
import { runScript } from '../lib/script-runner.js';
import { print } from '../lib/output.js';

export function registerPreflightCommand(program) {
  program
    .command('preflight')
    .description('Run pre-deployment validation checks')
    .option('--strict', 'Fail on any warning')
    .action(async (options) => {
      try {
        const config = await loadConfig();
        const projectRoot = config._projectRoot;

        print.header('Pre-flight Checks');

        const env = {};
        if (options.strict) {
          env.SFDT_PREFLIGHT_STRICT = 'true';
        }

        await runScript('new/preflight.sh', config, {
          cwd: projectRoot,
          env,
        });

        print.success('Pre-flight checks passed.');
      } catch (err) {
        print.error(`Pre-flight checks failed: ${err.message}`);
        process.exitCode = 1;
      }
    });
}
