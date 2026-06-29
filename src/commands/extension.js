/**
 * `sfdt extension` — manage the Chrome native messaging host that bridges
 * the SFDT SF Helper extension to this CLI when the local
 * `sfdt ui` HTTP server isn't running.
 *
 * Subcommands:
 *   install-host  Register the native host manifest with Chrome (or any
 *                 supported Chromium-based browser) so the extension can
 *                 reach sfdt via chrome.runtime.connectNative.
 *   uninstall-host  Remove the manifest. The HTTP transport is unaffected.
 *   status        Report which browsers have the manifest installed and
 *                 where each one points.
 *
 * The native host itself lives in the @sfdt/host workspace; this command
 * is purely the installer for its registration with Chrome.
 */

import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
// host/ is bundled inside the published @sfdt/cli tarball (see "files" in
// package.json), and @sfdt/host itself is `"private": true` because it is
// not a separately consumable npm package — it only makes sense as part of
// sfdt. That rules out the alternative shape "@sfdt/host" as a named
// dependency: in development npm workspaces would resolve it locally, but
// once @sfdt/cli is published the consumer's npm would try to fetch
// @sfdt/host from the public registry and 404.
//
// The relative path is the load-bearing contract: a regression here is
// caught by test/lib/host-installer-resolves.test.js, which imports the
// module without mocks so a moved file fails CI immediately rather than
// surfacing as ERR_MODULE_NOT_FOUND at the user's first `sfdt extension`.
import {
  installNativeHost,
  uninstallNativeHost,
  nativeHostStatus,
} from '../../host/installers/install-host.js';
import { getConfigDir } from '../lib/config.js';
import { resolveExitCode } from '../lib/exit-codes.js';
import { emitJson, emitJsonError } from '../lib/output.js';

const BROWSER_CHOICES = ['chrome', 'edge', 'brave', 'chromium', 'vivaldi', 'all'];

// Chrome assigns extension IDs as exactly 32 chars from [a-p]
// (a base-16 mapping of the public-key SHA-256 hash). Validate at parse time
// so a typo or pasted URL produces a clear error before any installer or
// registry-write code runs.
const EXTENSION_ID_RE = /^[a-p]{32}$/;

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
        if (typeof options.extensionId !== 'string' || !EXTENSION_ID_RE.test(options.extensionId)) {
          throw new Error(
            `--extension-id must be 32 lowercase letters a–p (Chrome extension IDs are base-16 → a-p). Got: ${options.extensionId}`,
          );
        }
        const result = await installNativeHost({
          extensionId: options.extensionId,
          browser: options.browser,
        });
        if (!result.ok) {
          if (jsonMode) {
            emitJson(result);
          } else {
            console.error(chalk.red(`Install failed: ${result.error}`));
          }
          process.exitCode = 1;
          return;
        }
        if (jsonMode) {
          emitJson(result);
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
          emitJsonError(err);
        } else {
          console.error(chalk.red(`extension install-host failed: ${err.message}`));
          process.exitCode = resolveExitCode(err);
        }
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
          emitJson(result);
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
          emitJsonError(err);
        } else {
          console.error(chalk.red(`extension uninstall-host failed: ${err.message}`));
          process.exitCode = resolveExitCode(err);
        }
      }
    });

  extension
    .command('stats')
    .description(
      'Show the latest telemetry snapshot the extension pushed to .sfdt/telemetry-snapshot.json',
    )
    .option('--json', 'Emit the result as JSON')
    .option('--limit <n>', 'Cap the number of features shown (default: 10)', '10')
    .action(async (options) => {
      const jsonMode = !!options.json;
      try {
        const file = path.join(getConfigDir(), 'telemetry-snapshot.json');
        if (!(await fs.pathExists(file))) {
          const msg =
            'No telemetry snapshot has been pushed yet. Open the extension options page (with Telemetry enabled) and refresh once to populate it.';
          if (jsonMode) {
            emitJson({ ok: false, file, error: msg });
          } else {
            console.log(chalk.dim(msg));
            console.log(chalk.dim(`(would read from: ${file})`));
          }
          process.exitCode = 1;
          return;
        }
        const snapshot = await fs.readJson(file);
        if (jsonMode) {
          emitJson({ ok: true, file, ...snapshot });
          return;
        }
        const limit = Math.max(1, Number(options.limit) || 10);
        const ids = Object.keys(snapshot.counters ?? {}).sort(
          (a, b) =>
            (snapshot.counters[b]?.activated ?? 0) - (snapshot.counters[a]?.activated ?? 0),
        );
        console.log(chalk.bold(`\nExtension telemetry — ${snapshot.monthKey ?? 'unknown month'}`));
        if (snapshot.writtenAt) {
          console.log(chalk.dim(`(snapshot written at ${snapshot.writtenAt})`));
        }
        if (ids.length === 0) {
          console.log(chalk.dim('\nNo features have fired yet this month.\n'));
          return;
        }
        console.log('');
        const idWidth = Math.min(40, Math.max(...ids.map((id) => id.length), 12));
        console.log(
          `  ${'feature'.padEnd(idWidth)}  ${'activated'.padStart(10)}  ${'errored'.padStart(8)}  ${'disabled.remote'.padStart(16)}`,
        );
        console.log(`  ${'-'.repeat(idWidth)}  ${'-'.repeat(10)}  ${'-'.repeat(8)}  ${'-'.repeat(16)}`);
        for (const id of ids.slice(0, limit)) {
          const c = snapshot.counters[id] ?? {};
          console.log(
            `  ${id.padEnd(idWidth)}  ${String(c.activated ?? 0).padStart(10)}  ${String(c.errored ?? 0).padStart(8)}  ${String(c.disabled_remote ?? 0).padStart(16)}`,
          );
        }
        if (ids.length > limit) {
          console.log(chalk.dim(`\n(${ids.length - limit} more — use --limit to see)`));
        }
        console.log('');
      } catch (err) {
        if (jsonMode) {
          emitJsonError(err);
        } else {
          console.error(chalk.red(`extension stats failed: ${err.message}`));
          process.exitCode = resolveExitCode(err);
        }
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
          emitJson(status);
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
