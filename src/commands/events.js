import chalk from 'chalk';
import fs from 'fs-extra';
import { loadConfig } from '../lib/config.js';
import { guardProduction } from '../lib/org-facts.js';
import { confirmChange } from '../lib/confirm-change.js';
import { parseSetPairs } from '../lib/record-runner.js';
import {
  listEventChannels,
  publishEvent,
  tailEvents,
  REPLAY_NEW_ONLY,
  REPLAY_ALL_RETAINED,
} from '../lib/events-runner.js';
import { resolveExitCode } from '../lib/exit-codes.js';
import { emitJson, emitJsonError } from '../lib/output.js';

function resolveOrg(config, options) {
  const org = options.org ?? config.defaultOrg;
  if (!org) throw new Error('No org specified — pass --org <alias> or set defaultOrg in .sfdt/config.json');
  return org;
}

/** Collect repeatable `--field Name=Value` / `--expect Name=Value` flags. */
function collect(value, previous) {
  return [...(previous ?? []), value];
}

const KIND_LABELS = {
  platformEvent: 'Custom platform events',
  standardPlatformEvent: 'Standard platform events',
  customChannel: 'Custom channels',
  changeEvent: 'Change Data Capture',
};

function printChannels({ channels, notes }) {
  console.log('');
  for (const kind of Object.keys(KIND_LABELS)) {
    const rows = channels.filter((c) => c.kind === kind);
    if (rows.length === 0) continue;
    console.log(chalk.bold(`  ${KIND_LABELS[kind]} (${rows.length})`));
    for (const c of rows) {
      const label = c.label && c.label !== c.name ? chalk.dim(` — ${c.label}`) : '';
      console.log(`    ${c.path.padEnd(46)}${label}`);
    }
    console.log('');
  }
  if (channels.length === 0) console.log(chalk.dim('  No subscribable channels found.'));
  if (notes.length > 0) {
    console.log(chalk.bold('  Notes'));
    for (const n of notes) console.log(`    ${chalk.dim('·')} ${chalk.dim(n)}`);
    console.log('');
  }
}

/**
 * Parse `--replay`.
 *
 * `new` and `all` are accepted alongside the raw numbers because -1 and -2 are
 * impossible to remember and getting them backwards silently changes what the
 * tail sees.
 */
function parseReplay(raw) {
  if (raw === undefined || raw === null || raw === '') return REPLAY_NEW_ONLY;
  const s = String(raw).trim().toLowerCase();
  if (s === 'new') return REPLAY_NEW_ONLY;
  if (s === 'all') return REPLAY_ALL_RETAINED;
  const n = Number(s);
  if (!Number.isInteger(n)) {
    throw new Error(`--replay expects "new", "all", or a replay id — got "${raw}".`);
  }
  return n;
}

/**
 * `sfdt events` — Platform Events and Change Data Capture.
 *
 * `list` and `publish` shell to `sf` like everything else. `tail` is the one
 * command in this CLI that holds a session token in memory, because a CometD
 * long-poll is a connection this process must own; see `src/lib/org-session.js`
 * for what that does and does not change.
 */
export function registerEventsCommand(program) {
  const events = program
    .command('events')
    .description('Platform Events and Change Data Capture: list, tail, publish');

  events
    .command('list')
    .description('List every subscribable channel in the org')
    .option('--org <alias>', 'Org alias (defaults to config.defaultOrg)')
    .option('--json', 'Emit structured JSON to stdout')
    .action(async (options) => {
      const jsonMode = !!options.json;
      try {
        const config = await loadConfig();
        const orgAlias = resolveOrg(config, options);
        const result = await listEventChannels(orgAlias);
        if (jsonMode) {
          emitJson({ org: orgAlias, ...result }, { warnings: result.notes });
          return;
        }
        printChannels(result);
      } catch (err) {
        if (jsonMode) emitJsonError(err);
        else {
          console.error(chalk.red(`Events list failed: ${err.message}`));
          process.exitCode = resolveExitCode(err);
        }
      }
    });

  events
    .command('tail <channel>')
    .description('Subscribe to a channel and print events as they arrive')
    .option('--org <alias>', 'Org alias (defaults to config.defaultOrg)')
    .option('--replay <id>', '"new" (default), "all" for the retention window, or a replay id')
    .option('--timeout <seconds>', 'Stop after this long (default 60)', '60')
    .option('--max <n>', 'Stop after this many events', '0')
    .option('--expect <Field=Value>', 'Stop on the first matching event; exit 1 if none arrives', collect)
    .option('--out <file>', 'Append each event to a file as NDJSON')
    .option('--json', 'Emit one envelope at the end instead of streaming')
    .action(async (channel, options) => {
      const jsonMode = !!options.json;
      try {
        const config = await loadConfig();
        const orgAlias = resolveOrg(config, options);
        const expectPairs = options.expect?.length ? parseSetPairs(options.expect) : null;

        // Ctrl-C ends the tail cleanly — unsubscribing from the org rather than
        // leaving it holding a subscription for a process that has exited.
        const controller = new AbortController();
        const onSigint = () => controller.abort();
        process.once('SIGINT', onSigint);

        let outStream = null;
        if (options.out) {
          await fs.ensureFile(options.out);
          outStream = fs.createWriteStream(options.out, { flags: 'a' });
        }

        const result = await tailEvents(orgAlias, channel, {
          replayId: parseReplay(options.replay),
          timeoutMs: Math.max(1, Number(options.timeout) || 60) * 1000,
          max: Math.max(0, Number(options.max) || 0),
          expect: expectPairs,
          signal: controller.signal,
          onStatus: (status, isError) => {
            // Status goes to stderr so it never contaminates stdout, which in
            // --json mode carries the envelope and nothing else.
            if (!jsonMode || isError) {
              console.error(isError ? chalk.red(`  ${status}`) : chalk.dim(`  ${status}`));
            }
          },
          onEvent: (event) => {
            const line = JSON.stringify(event);
            outStream?.write(`${line}\n`);
            // THE ENVELOPE DECISION (golden principle #6). The JSON envelope is
            // ONE object on stdout; a tail is a stream, and both cannot be true
            // at once. So --json prints nothing live and emits a single
            // envelope at the end, bounded by --timeout/--max; without --json,
            // events stream as NDJSON as they arrive. The invariant wins over
            // the convenience.
            if (!jsonMode) console.log(line);
          },
        });

        process.off('SIGINT', onSigint);
        outStream?.end();

        // `expect` is an assertion: not seeing the event is the failure it
        // exists to detect, so the exit code has to carry it.
        if (expectPairs && !result.matched) process.exitCode = 1;

        if (jsonMode) {
          emitJson({ org: orgAlias, ...result });
          return;
        }
        console.error('');
        console.error(
          chalk.dim(
            `  ${result.events.length} event(s) · ended: ${result.outcome}` +
              (expectPairs ? ` · expectation ${result.matched ? 'met' : 'NOT met'}` : ''),
          ),
        );
        if (expectPairs && !result.matched) {
          console.error(chalk.red('  ✖ No event matched the expectation before the tail ended.'));
        }
      } catch (err) {
        if (jsonMode) emitJsonError(err);
        else {
          console.error(chalk.red(`Events tail failed: ${err.message}`));
          process.exitCode = resolveExitCode(err);
        }
      }
    });

  events
    .command('publish <Event__e>')
    .description('Publish one platform event')
    .option('--org <alias>', 'Org alias (defaults to config.defaultOrg)')
    .option('--field <Name=Value>', 'Repeatable. Splits on the first = only', collect)
    .option('--dry-run', 'Print the exact body without sending it')
    .option('--yes', 'Skip the confirmation prompt')
    .option('--production', 'Acknowledge that the target org is production')
    .option('--json', 'Emit structured JSON to stdout')
    .action(async (eventName, options) => {
      const jsonMode = !!options.json;
      try {
        const config = await loadConfig();
        const orgAlias = resolveOrg(config, options);
        const fields = parseSetPairs(options.field ?? []);

        // Publishing is behavioural, not just a data write: the event fires every
        // real subscriber — flows, Apex triggers, and any external system on the
        // channel — and none of that is reversible from here. That puts it in the
        // same class as toggling automation, so it takes the same two brakes.
        if (!options.dryRun) {
          await guardProduction(orgAlias, options, 'fire every subscriber listening on that channel');
          const ok = await confirmChange(
            `publish ${eventName} to ${orgAlias}`,
            [
              'Every subscriber fires: flows, Apex triggers, and any external listener.',
              'A publish cannot be recalled — there is no undo for a delivered event.',
            ],
            options,
            jsonMode,
          );
          if (!ok) return;
        }

        const result = await publishEvent(config, orgAlias, eventName, fields, {
          dryRun: !!options.dryRun,
        });

        if (result.outcome === 'rejected') process.exitCode = 1;

        if (jsonMode) {
          emitJson({ org: orgAlias, ...result });
          return;
        }
        if (result.outcome === 'dry-run') {
          console.log('');
          console.log(chalk.bold(`Would POST to ${result.event}:`));
          console.log(JSON.stringify(result.body, null, 2));
          return;
        }
        if (result.outcome === 'published') {
          console.log(chalk.green(`\n✔ Published ${result.event}`));
          // Worth stating: this id is not a row you can go and read back.
          console.log(chalk.dim(`  ${result.id ?? '(no id returned)'} — a publish id, not a record`));
          return;
        }
        console.error(chalk.red(`\n✖ Not published — ${result.error}`));
      } catch (err) {
        if (jsonMode) emitJsonError(err);
        else {
          console.error(chalk.red(`Events publish failed: ${err.message}`));
          process.exitCode = resolveExitCode(err);
        }
      }
    });
}
