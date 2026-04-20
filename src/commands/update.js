import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { execa } from 'execa';
import inquirer from 'inquirer';
import { print, createSpinner } from '../lib/output.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf-8'));

const NPM_REGISTRY_URL = 'https://registry.npmjs.org/@sfdt/cli/latest';

async function fetchLatestVersion() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(NPM_REGISTRY_URL, { signal: controller.signal });
    if (!res.ok) throw new Error(`npm registry responded with ${res.status}`);
    const data = await res.json();
    return data.version;
  } finally {
    clearTimeout(timeout);
  }
}

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

        if (current === latestVersion) {
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
        await execa('npm', ['install', '--global', '@sfdt/cli@latest'], { stdio: 'inherit' });
        installSpinner.succeed('Update complete.');

        print.success(`sfdt updated to v${latestVersion}`);
      } catch (err) {
        print.error(err.message);
        process.exitCode = 1;
      }
    });
}
