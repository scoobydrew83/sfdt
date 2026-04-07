import { loadConfig } from '../lib/config.js';
import { runScript } from '../lib/script-runner.js';
import { print } from '../lib/output.js';

export function registerDeployCommand(program) {
  program
    .command('deploy')
    .description('Deploy to a Salesforce org using the configured deployment script')
    .option('--managed', 'Use deploy-manager.sh instead of deployment-assistant.sh')
    .option('--skip-preflight', 'Skip pre-deployment preflight checks')
    .action(async (options) => {
      try {
        const config = await loadConfig();
        const projectRoot = config._projectRoot;

        if (!options.skipPreflight) {
          print.info('Running preflight checks...');
          const preflightEnv = {};
          if (config.deployment?.preflight?.strict) {
            preflightEnv.SFDT_PREFLIGHT_STRICT = 'true';
          }
          try {
            await runScript('new/preflight.sh', config, { cwd: projectRoot, env: preflightEnv });
            print.success('Preflight passed.');
          } catch (prefErr) {
            print.error(`Preflight failed — aborting deploy: ${prefErr.message}`);
            process.exitCode = 1;
            return;
          }
        }

        const scriptPath = options.managed
          ? 'core/deploy-manager.sh'
          : 'core/deployment-assistant.sh';

        print.header(`Deploying${options.managed ? ' (managed)' : ''}`);

        await runScript(scriptPath, config, {
          cwd: projectRoot,
        });

        print.success('Deployment completed successfully.');
      } catch (err) {
        print.error(`Deployment failed: ${err.message}`);
        process.exitCode = 1;
      }
    });
}
