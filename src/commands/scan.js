import path from 'path';
import fs from 'fs-extra';
import ora from 'ora';
import chalk from 'chalk';
import { loadConfig } from '../lib/config.js';
import { fetchInventory } from '../lib/org-inventory.js';
import { resolveExitCode } from '../lib/exit-codes.js';
export function registerScanCommand(program) {
  program
    .command('scan')
    .description('Fetch complete metadata inventory from an org')
    .option('--org <alias>', 'Org alias (defaults to config.defaultOrg)')
    .option('--output <file>', 'Write JSON to this path (ignored if --json is passed) (default: logs/scan-latest.json)')
    .option('--format <fmt>', 'Output format: json | table (ignored if --json is passed) (default: json)', 'json')
    .option('--json', 'Emit structured JSON to stdout and exit without writing a file')
    .action(async (options) => {
      const jsonMode = !!options.json;
      try {
        const config = await loadConfig();
        const orgAlias = options.org ?? config.defaultOrg;
        if (!orgAlias) {
          throw new Error('No org specified — pass --org <alias> or set defaultOrg in .sfdt/config.json');
        }
        const logDir = config.logDir ?? path.join(config._projectRoot, 'logs');
        const outPath = options.output
          ? path.resolve(options.output)
          : path.join(logDir, 'scan-latest.json');
        const spinner = jsonMode ? null : ora(`Fetching inventory from ${orgAlias}…`).start();
        let inventory;
        try {
          inventory = await fetchInventory(orgAlias, config);
          spinner?.succeed(`Inventory fetched from ${orgAlias}`);
        } catch (err) {
          spinner?.fail('Inventory fetch failed');
          throw err;
        }
        const summary = {
          totalTypes: inventory.size,
          totalMembers: [...inventory.values()].reduce((n, s) => n + s.size, 0),
        };
        const output = {
          timestamp: new Date().toISOString(),
          org: orgAlias,
          inventory: Object.fromEntries([...inventory.entries()].map(([k, v]) => [k, [...v]])),
          summary,
        };
        if (jsonMode) {
          process.stdout.write(JSON.stringify(output, null, 2) + '\n');
          return;
        }
        await fs.ensureDir(path.dirname(outPath));
        await fs.writeJson(outPath, output, { spaces: 2 });
        if (options.format === 'table') {
          console.log('');
          for (const [type, members] of [...inventory.entries()].sort()) {
            console.log(`  ${type.padEnd(40)} ${members.size} members`);
          }
          console.log('');
          console.log(chalk.bold(`Total: ${summary.totalTypes} types · ${summary.totalMembers} members`));
        }
        console.log(chalk.green(`\nJSON written to ${outPath}`));
      } catch (err) {
        if (jsonMode) {
          process.stdout.write(JSON.stringify({ status: 'error', message: err.message, exitCode: resolveExitCode(err) }) + '\n');
        } else {
          console.error(chalk.red(`Scan failed: ${err.message}`));
        }
        process.exitCode = resolveExitCode(err);
      }
    });
}
