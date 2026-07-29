import chalk from 'chalk';
import ora from 'ora';
import { loadConfig } from '../lib/config.js';
import {
  startTrace,
  stopTrace,
  listTraceFlags,
  listLogs,
  getLog,
  watchLogs,
  runAnonymous,
  DEFAULT_DEBUG_LEVEL,
} from '../lib/apex-runner.js';
import { resolveExitCode } from '../lib/exit-codes.js';
import { emitJson, emitJsonError } from '../lib/output.js';

function resolveOrg(config, options) {
  const org = options.org ?? config.defaultOrg;
  if (!org) throw new Error('No org specified — pass --org <alias> or set defaultOrg in .sfdt/config.json');
  return org;
}

/** Shared action wrapper: config + org resolution, spinner, envelope/errors. */
function makeAction(label, fn, { spin = true } = {}) {
  return async (...cliArgs) => {
    // Commander invokes handlers with (...positionals, options, command).
    const options = cliArgs[cliArgs.length - 2];
    const positionals = cliArgs.slice(0, -2);
    const jsonMode = !!options.json;
    try {
      const config = await loadConfig();
      const org = resolveOrg(config, options);
      const spinner = jsonMode || !spin ? null : ora(`${label} (${org})…`).start();
      let result;
      try {
        result = await fn(org, options, ...positionals);
        spinner?.succeed(`${label} — done`);
      } catch (err) {
        spinner?.fail(`${label} failed`);
        throw err;
      }
      if (jsonMode) {
        emitJson(result.payload ?? result);
      } else if (result?.print) {
        result.print();
      } else {
        console.log(`\n${JSON.stringify(result.payload ?? result, null, 2)}`);
      }
      if (result?.exitCode) process.exitCode = result.exitCode;
    } catch (err) {
      if (jsonMode) {
        emitJsonError(err);
      } else {
        console.error(chalk.red(`${label} failed: ${err.message}`));
        process.exitCode = resolveExitCode(err);
      }
    }
  };
}

/** Read piped Apex code from stdin (apex run without --file). */
async function readStdin() {
  let code = '';
  for await (const chunk of process.stdin) code += chunk;
  return code;
}

export function registerApexCommand(program) {
  const apex = program
    .command('apex')
    .description('Apex observability — trace flags, debug log retrieve/watch, Anonymous Apex execution (complements `sfdt test`)');

  // ---------------------------------------------------------------- trace
  const trace = apex.command('trace').description('Manage Apex debug trace flags (Tooling API)');

  trace
    .command('start')
    .description('Start a USER_DEBUG trace flag for a user (creates the sfdt debug level on demand)')
    .option('--org <alias>', 'Org alias (defaults to config.defaultOrg)')
    .option('--user <username>', 'Username to trace (defaults to the authenticated user)')
    .option('--duration <minutes>', 'Trace window in minutes (max 1440 = 24 h)', '60')
    .option('--level <developerName>', `DebugLevel DeveloperName (default: ${DEFAULT_DEBUG_LEVEL}, created if missing)`)
    .option('--json', 'Emit structured JSON to stdout')
    .action(
      makeAction('Start trace flag', async (org, options) => {
        const payload = await startTrace(org, {
          user: options.user,
          durationMinutes: Number(options.duration),
          debugLevel: options.level ?? DEFAULT_DEBUG_LEVEL,
        });
        return {
          payload,
          print: () => {
            console.log(chalk.green(`\nTrace flag ${payload.traceFlagId} active for ${chalk.bold(payload.user)}`));
            console.log(chalk.dim(`  Debug level: ${payload.debugLevel}${payload.debugLevelCreated ? ' (created)' : ''}`));
            console.log(chalk.dim(`  Expires:     ${payload.expirationDate}`));
          },
        };
      }),
    );

  trace
    .command('list')
    .description('List trace flags in the org (read-only)')
    .option('--org <alias>', 'Org alias (defaults to config.defaultOrg)')
    .option('--json', 'Emit structured JSON to stdout')
    .action(
      makeAction('List trace flags', async (org) => {
        const payload = await listTraceFlags(org);
        return {
          payload,
          print: () => {
            if (payload.traceFlags.length === 0) {
              console.log(chalk.yellow('\nNo trace flags found.'));
              return;
            }
            console.log('');
            for (const t of payload.traceFlags) {
              const state = t.active ? chalk.green('ACTIVE ') : chalk.dim('expired');
              console.log(`${state} ${t.id}  ${t.logType.padEnd(11)} level=${t.debugLevel ?? '?'}  until ${t.expirationDate ?? '?'}`);
            }
          },
        };
      }),
    );

  trace
    .command('stop')
    .description('Delete USER_DEBUG trace flags for a user (or --all for every user)')
    .option('--org <alias>', 'Org alias (defaults to config.defaultOrg)')
    .option('--user <username>', 'Username whose flags to delete (defaults to the authenticated user)')
    .option('--all', 'Delete every USER_DEBUG trace flag in the org')
    .option('--json', 'Emit structured JSON to stdout')
    .action(
      makeAction('Stop trace flags', async (org, options) => {
        const payload = await stopTrace(org, { user: options.user, all: !!options.all });
        return {
          payload,
          print: () => {
            console.log(chalk.green(`\nDeleted ${payload.deleted} trace flag(s)${payload.user ? ` for ${payload.user}` : ''}.`));
          },
        };
      }),
    );

  // ----------------------------------------------------------------- logs
  const logs = apex.command('logs').description('Retrieve and watch Apex debug logs (read-only)');

  logs
    .command('list')
    .description('List recent debug logs (newest first)')
    .option('--org <alias>', 'Org alias (defaults to config.defaultOrg)')
    .option('--limit <n>', 'Maximum logs to return', '20')
    .option('--user <name>', 'Only logs generated by this user (display name)')
    .option('--json', 'Emit structured JSON to stdout')
    .action(
      makeAction('List debug logs', async (org, options) => {
        const payload = await listLogs(org, { limit: Number(options.limit), user: options.user });
        return {
          payload,
          print: () => {
            if (payload.logs.length === 0) {
              console.log(chalk.yellow('\nNo debug logs found — start a trace flag first (`sfdt apex trace start`).'));
              return;
            }
            console.log('');
            for (const l of payload.logs) {
              console.log(`${l.id}  ${String(l.startTime ?? '').padEnd(24)} ${String(l.status ?? '').padEnd(10)} ${l.operation ?? ''} (${l.user ?? '?'}, ${l.lengthBytes ?? '?'} B)`);
            }
            console.log(chalk.dim(`\n${payload.logs.length} of ${payload.total} log(s)`));
          },
        };
      }),
    );

  logs
    .command('get <logId>')
    .description('Retrieve one debug log body (print, or save raw with --output)')
    .option('--org <alias>', 'Org alias (defaults to config.defaultOrg)')
    .option('--output <file>', 'Write the raw log body to a file')
    .option('--json', 'Emit structured JSON to stdout')
    .action(
      makeAction('Get debug log', async (org, options, logId) => {
        const payload = await getLog(org, logId, { outputFile: options.output });
        return {
          payload,
          print: () => {
            if (payload.outputFile) {
              console.log(chalk.green(`\nLog ${payload.id} (${payload.lengthBytes} B) written to ${payload.outputFile}`));
            } else {
              console.log(payload.log);
            }
          },
        };
      }),
    );

  logs
    .command('watch')
    .description('Tail new debug logs — bounded by --duration/--max so it is CI-safe (0 = until interrupted)')
    .option('--org <alias>', 'Org alias (defaults to config.defaultOrg)')
    .option('--interval <seconds>', 'Poll interval', '5')
    .option('--duration <seconds>', 'Total watch window; 0 = until interrupted', '300')
    .option('--max <n>', 'Stop after this many new logs')
    .option('--no-body', 'Report new log metadata without fetching bodies')
    .option('--json', 'Emit a structured JSON summary to stdout when the watch ends')
    .action(
      makeAction(
        'Watch debug logs',
        async (org, options) => {
          const jsonMode = !!options.json;
          if (!jsonMode) {
            console.log(chalk.dim(`Watching ${org} for new debug logs (interval ${options.interval}s, duration ${options.duration}s)…`));
          }
          const payload = await watchLogs(org, {
            intervalMs: Math.max(Number(options.interval) || 5, 1) * 1000,
            durationMs: Math.max(Number(options.duration) || 0, 0) * 1000,
            maxLogs: options.max ? Number(options.max) : Infinity,
            fetchBody: options.body !== false,
            onLog: ({ meta, body }) => {
              if (jsonMode) return; // summary envelope only — stdout stays clean JSON
              console.log(chalk.bold(`\n─── ${meta.id} · ${meta.operation ?? ''} · ${meta.startTime ?? ''} (${meta.user ?? '?'})`));
              if (body) console.log(body);
            },
          });
          return {
            payload,
            print: () => console.log(chalk.dim(`\nWatch ended — ${payload.newLogs} new log(s) in ${Math.round(payload.watchedMs / 1000)}s.`)),
          };
        },
        { spin: false },
      ),
    );

  // ------------------------------------------------------------------ run
  apex
    .command('run')
    .description('Execute Anonymous Apex from --file or stdin (mutating — code runs in the org)')
    .option('--org <alias>', 'Org alias (defaults to config.defaultOrg)')
    .option('--file <path>', 'Path to an Apex code file')
    .option('--json', 'Emit structured JSON to stdout')
    .action(
      makeAction('Run Anonymous Apex', async (org, options) => {
        let code;
        if (!options.file) {
          if (process.stdin.isTTY) {
            throw new Error('Provide Apex code via --file <path> or pipe it on stdin.');
          }
          code = await readStdin();
          if (!code.trim()) throw new Error('No Apex code received on stdin.');
        }
        const payload = await runAnonymous(org, { file: options.file, code });
        return {
          payload,
          exitCode: payload.success ? 0 : 1,
          print: () => {
            if (payload.success) {
              console.log(chalk.green('\nAnonymous Apex executed successfully.'));
            } else if (!payload.compiled) {
              console.error(chalk.red(`\nCompile error (line ${payload.line ?? '?'}, col ${payload.column ?? '?'}): ${payload.compileProblem}`));
            } else {
              console.error(chalk.red(`\nRuntime error: ${payload.exceptionMessage}`));
              if (payload.exceptionStackTrace) console.error(chalk.dim(payload.exceptionStackTrace));
            }
            if (payload.logs) console.log(chalk.dim(`\n${payload.logs}`));
          },
        };
      }),
    );
}
