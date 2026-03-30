import { loadConfig } from '../lib/config.js';
import { runScript } from '../lib/script-runner.js';
import { print } from '../lib/output.js';

export function registerPullCommand(program) {
  program
    .command('pull')
    .description('Pull metadata changes from the default org')
    .action(async () => {
      try {
        const config = await loadConfig();
        const projectRoot = config._projectRoot;

        print.header('Pulling Org Updates');

        await runScript('core/pull-org-updates.sh', config, {
          cwd: projectRoot,
        });

        print.success('Pull completed successfully.');
      } catch (err) {
        print.error(`Pull failed: ${err.message}`);
        process.exitCode = 1;
      }
    });
}
