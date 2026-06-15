import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { execa } from 'execa';
import inquirer from 'inquirer';
import { print, createSpinner } from '../lib/output.js';
import { fetchLatestVersion, isUpdateAvailable } from '../lib/update-checker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf-8'));

export function registerUpdateCommand(program) {
  program
    .command('update')
    .description('Update sfdt to the latest version from npm')
    .option('--force', 'Skip confirmation prompt')
    .action(async (options) => {
      try {
        const spinner = createSpinner('Checking for updates…').start();
        const latestVersion = await fetchLatestVersion();
        spinner.stop();

        const current = pkg.version;

        // Only treat a strictly-newer published version as an update — never
        // offer to "update" a local/pre-release build that is ahead of npm
        // (which would silently downgrade it).
        if (!isUpdateAvailable(latestVersion, current)) {
          print.success(`sfdt is up to date (v${current})`);
          return;
        }

        print.info(`Current version: v${current}`);
        print.info(`Latest version:  v${latestVersion}`);

        if (!options.force) {
          const { confirm } = await inquirer.prompt([
            {
              type: 'confirm',
              name: 'confirm',
              message: `Update sfdt from v${current} to v${latestVersion}?`,
              default: true,
            },
          ]);

          if (!confirm) {
            print.info('Cancelled.');
            return;
          }
        }

        const installSpinner = createSpinner('Installing…').start();
        installSpinner.stop();
        await execa('npm', ['install', '--global', '@sfdt/cli@latest'], { stdio: 'inherit' });

        print.success(`sfdt updated to v${latestVersion}`);
      } catch (err) {
        print.error(`Update failed: ${err.message}`);
        if (err.exitCode !== undefined) {
          print.info(
            'Common causes: no network access, or missing permission to write global npm packages. ' +
            'Retry manually with: npm install --global @sfdt/cli@latest',
          );
        }
        process.exitCode = 1;
      }
    });
}
