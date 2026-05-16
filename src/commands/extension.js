import chalk from 'chalk';
import {
  installNativeHost,
  uninstallNativeHost,
  nativeHostStatus,
} from '../../host/installers/install-host.js';
import { resolveExitCode } from '../lib/exit-codes.js';
const BROWSER_CHOICES = ['chrome', 'edge', 'brave', 'chromium', 'vivaldi', 'all'];
export function registerExtensionCommand(program) {
  const extension = program
    .command('extension')
    .description('Manage the Chrome extension bridge (native messaging host)');
  extension
    .command('install-host')
    .description('Install the Chrome native messaging host manifest for the SFDT SF Helper extension')
    .requiredOption(
      '--extension-id <id>',
      'The Chrome extension ID (32 lowercase letters a–p; find it at chrome://extensions with Developer Mode on)',
    )
    .option(
      '--browser <browser>',
      `Browser to register with — one of ${BROWSER_CHOICES.join(', ')} (default: chrome)`,
      'chrome',
    )
    .option('--json', 'Emit the result as JSON')
    .action(async (options) => {
      const jsonMode = !!options.json;
      try {
        if (!BROWSER_CHOICES.includes(options.browser)) {
          throw new Error(
            `--browser must be one of: ${BROWSER_CHOICES.join(', ')}. Got: ${options.browser}`,
          );
        }
        const result = await installNativeHost({
          extensionId: options.extensionId,
          browser: options.browser,
        });
        if (!result.ok) {
          if (jsonMode) {
            process.stdout.write(JSON.stringify(result, null, 2) + '\n');
          } else {
            console.error(chalk.red(`Install failed: ${result.error}`));
          }
          process.exitCode = 1;
          return;
        }
        if (jsonMode) {
          process.stdout.write(JSON.stringify(result, null, 2) + '\n');
          return;
        }
        console.log(chalk.green(`\nInstalled native host on ${result.platform}.`));
        console.log(chalk.dim(`Host launcher: ${result.hostPath}`));
        for (const r of result.results) {
          if (r.ok) {
            console.log(`  ${chalk.green('✓')} ${r.browser}  ${chalk.dim(r.manifestPath)}`);
          } else {
            console.log(`  ${chalk.yellow('•')} ${r.browser}  ${chalk.dim(r.error)}`);
          }
        }
        console.log(
          chalk.dim(
            '\nReload the extension at chrome://extensions and the "native" transport becomes available.',
          ),
        );
      } catch (err) {
        if (jsonMode) {
          process.stdout.write(
            JSON.stringify({ ok: false, error: err.message, exitCode: resolveExitCode(err) }) + '\n',
          );
        } else {
          console.error(chalk.red(`extension install-host failed: ${err.message}`));
        }
        process.exitCode = resolveExitCode(err);
      }
    });
  extension
    .command('uninstall-host')
    .description('Remove the native messaging host manifest from one or all browsers')
    .option(
      '--browser <browser>',
      `Browser to remove — one of ${BROWSER_CHOICES.join(', ')} (default: all)`,
      'all',
    )
    .option('--json', 'Emit the result as JSON')
    .action(async (options) => {
      const jsonMode = !!options.json;
      try {
        if (!BROWSER_CHOICES.includes(options.browser)) {
          throw new Error(
            `--browser must be one of: ${BROWSER_CHOICES.join(', ')}. Got: ${options.browser}`,
          );
        }
        const result = await uninstallNativeHost({ browser: options.browser });
        if (jsonMode) {
          process.stdout.write(JSON.stringify(result, null, 2) + '\n');
          return;
        }
        console.log(chalk.bold(`\nUninstalled native host on ${result.platform}:`));
        for (const r of result.results) {
          if (r.removed) {
            console.log(`  ${chalk.green('✓')} ${r.browser}  ${chalk.dim(r.manifestPath ?? r.registryKey)}`);
          } else {
            console.log(`  ${chalk.dim('—')} ${r.browser}  ${chalk.dim(r.reason ?? 'nothing to remove')}`);
          }
        }
      } catch (err) {
        if (jsonMode) {
          process.stdout.write(
            JSON.stringify({ ok: false, error: err.message, exitCode: resolveExitCode(err) }) + '\n',
          );
        } else {
          console.error(chalk.red(`extension uninstall-host failed: ${err.message}`));
        }
        process.exitCode = resolveExitCode(err);
      }
    });
  extension
    .command('status')
    .description('Report which browsers have the native host manifest installed')
    .option('--json', 'Emit the result as JSON')
    .action(async (options) => {
      try {
        const status = await nativeHostStatus();
        if (options.json) {
          process.stdout.write(JSON.stringify(status, null, 2) + '\n');
          return;
        }
        console.log(chalk.bold(`\nNative host status — ${status.platform}\n`));
        for (const b of status.browsers) {
          const marker = b.installed ? chalk.green('✓') : chalk.dim('—');
          console.log(`  ${marker} ${b.browser.padEnd(10)} ${b.installed ? chalk.dim(b.manifestPath) : chalk.dim('not installed')}`);
          if (b.installed && b.hostPath) {
            console.log(`    ${chalk.dim(`launcher: ${b.hostPath}`)}`);
          }
        }
      } catch (err) {
        console.error(chalk.red(`extension status failed: ${err.message}`));
        process.exitCode = resolveExitCode(err);
      }
    });
}
