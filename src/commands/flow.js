import path from 'path';
import fs from 'fs-extra';
import chalk from 'chalk';
import ora from 'ora';
import { loadConfig } from '../lib/config.js';
import { resolveExitCode } from '../lib/exit-codes.js';
import { runFlowScan, runFlowConflicts } from '../lib/flow-analyzer.js';

export function registerFlowCommand(program) {
  const flow = program
    .command('flow')
    .description('Flow-specific analyses (CLI uses @sfdt/flow-core, matching the Chrome extension)');

  flow
    .command('scan')
    .description('Run flow-core health analysis on every Flow with an active version')
    .option('--org <alias>', 'Org alias (defaults to config.defaultOrg)')
    .option('--output <file>', 'Write report to this path (default: logs/flow-scan-latest.json)')
    .option('--json', 'Emit the report to stdout instead of writing a file')
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
          : path.join(logDir, 'flow-scan-latest.json');

        const spinner = jsonMode
          ? null
          : ora(`Listing FlowDefinitions in ${orgAlias}…`).start();
          
        const currentApiVersion = config.sourceApiVersion;
        const output = await runFlowScan(orgAlias, currentApiVersion);
        
        spinner?.succeed(`Analysed ${output.totalFlows} Flow${output.totalFlows === 1 ? '' : 's'}`);

        if (jsonMode) {
          process.stdout.write(JSON.stringify(output, null, 2) + '\n');
          return;
        }
        await fs.ensureDir(path.dirname(outPath));
        await fs.writeJson(outPath, output, { spaces: 2 });
        console.log(chalk.green(`\nReport written to ${outPath}`));
        console.log(
          chalk.bold(
            `${output.totalFlows} flow${output.totalFlows === 1 ? '' : 's'} analysed · avg score ${output.averageScore} · ${output.totalErrors} error${output.totalErrors === 1 ? '' : 's'}`,
          ),
        );
        if (output.reports.length > 0) {
          console.log(chalk.dim('\nWorst offenders:'));
          for (const r of output.reports.slice(0, 5)) {
            console.log(`  ${r.overallScore.toString().padStart(3)}  ${r.rating.padEnd(10)} ${r.label}`);
          }
        }
      } catch (err) {
        if (jsonMode) {
          process.stdout.write(
            JSON.stringify({ status: 'error', message: err.message, exitCode: resolveExitCode(err) }) + '\n',
          );
        } else {
          console.error(chalk.red(`flow scan failed: ${err.message}`));
        }
        process.exitCode = resolveExitCode(err);
      }
    });

  flow
    .command('conflicts')
    .description('List record-triggered Flow groups that fire on the same object + timing + event')
    .option('--org <alias>', 'Org alias (defaults to config.defaultOrg)')
    .option('--output <file>', 'Write report to this path (default: logs/flow-conflicts-latest.json)')
    .option('--json', 'Emit the report to stdout instead of writing a file')
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
          : path.join(logDir, 'flow-conflicts-latest.json');

        const spinner = jsonMode ? null : ora(`Listing FlowDefinitions in ${orgAlias}…`).start();
        const output = await runFlowConflicts(orgAlias);
        
        spinner?.succeed(
          `Found ${output.totalGroups} conflict group${output.totalGroups === 1 ? '' : 's'} across ${output.totalFlowsInConflicts} flows`,
        );

        if (jsonMode) {
          process.stdout.write(JSON.stringify(output, null, 2) + '\n');
          return;
        }
        await fs.ensureDir(path.dirname(outPath));
        await fs.writeJson(outPath, output, { spaces: 2 });
        console.log(chalk.green(`\nReport written to ${outPath}`));
        if (output.totalGroups === 0) {
          console.log(chalk.dim('No record-triggered conflicts detected.'));
        } else {
          for (const group of output.groups) {
            console.log('');
            console.log(
              chalk.bold(`${group.objectApiName} · ${group.triggerTiming} · ${group.triggerEvent}`),
            );
            for (const f of group.flows) {
              const summary = f.entryCriteriaSummary ?? chalk.red('no entry criteria');
              console.log(`  ${f.label.padEnd(40)} ${chalk.dim(summary)}`);
            }
          }
        }
      } catch (err) {
        if (jsonMode) {
          process.stdout.write(
            JSON.stringify({ status: 'error', message: err.message, exitCode: resolveExitCode(err) }) + '\n',
          );
        } else {
          console.error(chalk.red(`flow conflicts failed: ${err.message}`));
        }
        process.exitCode = resolveExitCode(err);
      }
    });
}
