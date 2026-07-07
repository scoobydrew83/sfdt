import path from 'path';
import chalk from 'chalk';
import { loadConfig } from '../lib/config.js';
import { queryRuns } from '../lib/run-history.js';
import { resolveExitCode } from '../lib/exit-codes.js';
import { emitJson, emitJsonError } from '../lib/output.js';

/** Render a compact summary object (`{ok:3, warn:1}`) as `ok:3 warn:1`. */
function summarize(s) {
  if (s == null || typeof s !== 'object') return '';
  return Object.entries(s)
    .map(([k, v]) => `${k}:${v}`)
    .join(' ');
}

export function registerHistoryCommand(program) {
  program
    .command('history')
    .description('Show recent sfdt run history (audit, monitor, quality, test, deploy, agent-test, …) from the local run index')
    .option('--type <type>', 'Filter to one run type (e.g. audit | monitor | quality | test-run | deploy | agent-test)')
    .option('--limit <n>', 'Maximum rows to show (default: 30)', '30')
    .option('--json', 'Emit the result as JSON')
    .action(async (options) => {
      const jsonMode = !!options.json;
      try {
        const config = await loadConfig();
        const logDir = config.logDir ?? path.join(config._projectRoot, 'logs');
        const limit = Number.parseInt(options.limit, 10) || 30;
        const runs = queryRuns(logDir, { type: options.type, limit });

        if (jsonMode) {
          emitJson({ runs, count: runs.length });
          return;
        }

        if (runs.length === 0) {
          console.log(
            chalk.dim(
              'No run history yet. Runs are indexed as you use audit / monitor / quality / test / deploy / agent-test.',
            ),
          );
          return;
        }

        console.log('');
        for (const r of runs) {
          const st = (r.status ?? (r.exitCode === 0 ? 'pass' : 'fail')).toString();
          const color =
            st === 'fail' || st === 'error' ? chalk.red : st === 'warn' ? chalk.yellow : chalk.green;
          const dur = r.durationMs != null ? `${Math.round(r.durationMs / 100) / 10}s` : '';
          console.log(
            `${chalk.dim(r.timestamp)}  ${color(st.padEnd(5))}  ${chalk.bold((r.type ?? '').padEnd(12))} ` +
              `${(r.org ?? '').padEnd(14)} ${chalk.dim(summarize(r.summary))} ${chalk.dim(dur)}`.trimEnd(),
          );
        }
        console.log('');
      } catch (err) {
        if (jsonMode) {
          emitJsonError(err);
        } else {
          console.error(chalk.red(`history failed: ${err.message}`));
          process.exitCode = resolveExitCode(err);
        }
      }
    });
}
