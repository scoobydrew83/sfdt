import { loadConfig } from '../lib/config.js';
import { runScript } from '../lib/script-runner.js';
import { print } from '../lib/output.js';
import { resolveExitCode } from '../lib/exit-codes.js';

export function registerDriftCommand(program) {
  program
    .command('drift')
    .description('Detect metadata drift between local source and a target org')
    .option('--org <alias>', 'Target org alias to check for drift')
    .action(async (options) => {
      try {
        const config = await loadConfig();
        const projectRoot = config._projectRoot;

        const orgAlias = options.org || config.defaultOrg;
        print.header(`Drift Detection (${orgAlias})`);

        const env = {
          SFDT_TARGET_ORG: orgAlias,
        };

        await runScript('new/drift.sh', config, {
          cwd: projectRoot,
          env,
        });

        print.success(`Drift detection for ${orgAlias} completed.`);
      } catch (err) {
        print.error(`Drift detection failed: ${err.message}`);
        process.exitCode = resolveExitCode(err);
      }
    });
}
