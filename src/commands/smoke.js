import { loadConfig } from '../lib/config.js';
import { runScript } from '../lib/script-runner.js';
import { print } from '../lib/output.js';

export function registerSmokeCommand(program) {
  program
    .command('smoke')
    .description('Run post-deployment smoke tests against a target org')
    .option('--org <alias>', 'Target org alias for smoke tests')
    .action(async (options) => {
      try {
        const config = await loadConfig();
        const projectRoot = config._projectRoot;

        const orgAlias = options.org || config.defaultOrg;
        print.header(`Smoke Tests (${orgAlias})`);

        const env = {
          SFDT_TARGET_ORG: orgAlias,
        };

        await runScript('new/smoke.sh', config, {
          cwd: projectRoot,
          env,
        });

        print.success(`Smoke tests passed on ${orgAlias}.`);
      } catch (err) {
        print.error(`Smoke tests failed: ${err.message}`);
        process.exitCode = 1;
      }
    });
}
