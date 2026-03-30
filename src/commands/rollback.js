import { loadConfig } from '../lib/config.js';
import { runScript } from '../lib/script-runner.js';
import { print } from '../lib/output.js';

export function registerRollbackCommand(program) {
  program
    .command('rollback')
    .description('Roll back a deployment to a target org')
    .option('--org <alias>', 'Target org alias for rollback')
    .action(async (options) => {
      try {
        const config = await loadConfig();
        const projectRoot = config._projectRoot;

        const orgAlias = options.org || config.defaultOrg;
        print.header(`Rolling Back (${orgAlias})`);

        const env = {
          SFDT_TARGET_ORG: orgAlias,
        };

        await runScript('new/rollback.sh', config, {
          cwd: projectRoot,
          env,
        });

        print.success(`Rollback to ${orgAlias} completed.`);
      } catch (err) {
        print.error(`Rollback failed: ${err.message}`);
        process.exitCode = 1;
      }
    });
}
