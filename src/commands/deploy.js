import { loadConfig } from '../lib/config.js';
import { runScript } from '../lib/script-runner.js';
import { print } from '../lib/output.js';

export function registerDeployCommand(program) {
  program
    .command('deploy')
    .description('Deploy to a Salesforce org using the configured deployment script')
    .option('--managed', 'Use deploy-manager.sh instead of deployment-assistant.sh')
    .action(async (options) => {
      try {
        const config = await loadConfig();
        const projectRoot = config._projectRoot;

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
