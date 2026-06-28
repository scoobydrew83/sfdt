import path from 'path';
import fs from 'fs-extra';
import ora from 'ora';
import chalk from 'chalk';
import { describeFinding } from '@sfdt/flow-core';
import { loadConfig } from '../lib/config.js';
import { runMonitor, runBackup, CHECK_IDS, MONITOR_DEFAULTS } from '../lib/monitor-runner.js';
import { resolveExitCode } from '../lib/exit-codes.js';
import { dispatchSnapshot } from '../lib/notifier.js';

const STATUS_COLOR = {
  ok: chalk.green,
  warn: chalk.yellow,
  fail: chalk.red,
  error: chalk.red,
};

function buildParams(config) {
  const m = config.monitoring ?? {};
  return {
    limits: { warnThreshold: m.limitWarnThreshold ?? MONITOR_DEFAULTS.limitWarnThreshold },
    errors: { lookbackDays: m.errorLookbackDays ?? MONITOR_DEFAULTS.errorLookbackDays },
    health: { minScore: m.healthMinScore ?? MONITOR_DEFAULTS.healthMinScore },
    'org-info': { trialWarnDays: m.orgInfoTrialWarnDays ?? MONITOR_DEFAULTS.orgInfoTrialWarnDays },
    'deploy-history': { lookback: m.deployHistoryLookback ?? MONITOR_DEFAULTS.deployHistoryLookback },
    'deprecated-api': { lookbackDays: m.deprecatedApiLookbackDays ?? MONITOR_DEFAULTS.deprecatedApiLookbackDays },
  };
}

async function executeMonitor(checks, options, { backup = false } = {}) {
  const jsonMode = !!options.json;
  try {
    const config = await loadConfig();
    const orgAlias = options.org ?? config.defaultOrg;
    if (!orgAlias) {
      throw new Error('No org specified — pass --org <alias> or set defaultOrg in .sfdt/config.json');
    }
    const logDir = config.logDir ?? path.join(config._projectRoot, 'logs');
    const outPath = path.join(logDir, 'monitor-latest.json');

    const spinner = jsonMode ? null : ora(`Monitoring ${orgAlias}…`).start();
    let snapshot;
    try {
      snapshot = await runMonitor(orgAlias, config, {
        checks,
        backup: backup || !!options.backup,
        params: buildParams(config),
      });
      spinner?.succeed(`Monitoring complete (${orgAlias})`);
    } catch (err) {
      spinner?.fail('Monitoring failed');
      throw err;
    }

    // Always persist the snapshot — the GUI (/api/monitor) and bridge org-health
    // handler read this file, so --json runs (CI/automation) must update it too.
    // A write failure must not fail the run or emit a second JSON envelope to
    // stdout — warn on stderr and carry on.
    try {
      await fs.ensureDir(logDir);
      await fs.writeJson(outPath, snapshot, { spaces: 2 });
    } catch (writeErr) {
      process.stderr.write(`Warning: could not write snapshot to ${outPath}: ${writeErr.message}\n`);
    }

    if (options.notify) {
      try {
        const { results } = await dispatchSnapshot(snapshot, config, { type: 'monitor' });
        const sent = results.filter((r) => r.ok).map((r) => r.channel);
        if (!jsonMode) console.log(chalk.dim(`Notified: ${sent.length ? sent.join(', ') : 'no matching channel'}`));
      } catch (notifyErr) {
        process.stderr.write(`Warning: notification failed: ${notifyErr.message}\n`);
      }
    }

    if (jsonMode) {
      process.stdout.write(JSON.stringify(snapshot, null, 2) + '\n');
    } else {
      printReport(snapshot);
      console.log(chalk.dim(`\nSnapshot written to ${outPath}`));
    }
    // Fail the exit code for outright failures AND errored checks (e.g. an
    // unreachable org), so monitoring can't silently pass in CI.
    if (snapshot.summary.fail > 0 || snapshot.summary.error > 0) process.exitCode = 1;
  } catch (err) {
    if (jsonMode) {
      process.stdout.write(JSON.stringify({ status: 'error', message: err.message, exitCode: resolveExitCode(err) }) + '\n');
    } else {
      console.error(chalk.red(`Monitoring failed: ${err.message}`));
    }
    process.exitCode = resolveExitCode(err);
  }
}

async function executeBackup(options) {
  const jsonMode = !!options.json;
  try {
    const config = await loadConfig();
    const orgAlias = options.org ?? config.defaultOrg;
    if (!orgAlias) {
      throw new Error('No org specified — pass --org <alias> or set defaultOrg in .sfdt/config.json');
    }
    const spinner = jsonMode ? null : ora(`Backing up metadata from ${orgAlias}…`).start();
    let res;
    try {
      res = await runBackup(orgAlias, config, {
        onProgress: ({ retrieved, total }) => {
          if (spinner) spinner.text = `Backing up ${orgAlias}… ${retrieved}/${total}`;
        },
      });
      // Surface the backup's own error summary (auth/network/etc.) rather than a
      // bare "Backup failed" — the error-status return path never reaches the
      // outer catch, so this is the only place it's shown in non-JSON mode.
      if (res.status === 'error') spinner?.fail(res.summary || 'Backup failed');
      else spinner?.succeed(res.summary);
    } catch (err) {
      spinner?.fail('Backup failed');
      throw err;
    }
    if (jsonMode) process.stdout.write(JSON.stringify(res, null, 2) + '\n');
    if (res.status === 'error') process.exitCode = 1;
  } catch (err) {
    if (jsonMode) {
      process.stdout.write(JSON.stringify({ status: 'error', message: err.message, exitCode: resolveExitCode(err) }) + '\n');
    } else {
      console.error(chalk.red(`Backup failed: ${err.message}`));
    }
    process.exitCode = resolveExitCode(err);
  }
}

function printReport(snapshot) {
  console.log('');
  for (const c of snapshot.checks) {
    const color = STATUS_COLOR[c.status] ?? chalk.white;
    console.log(`${color(c.status.toUpperCase().padEnd(5))} ${chalk.bold(c.title)} — ${c.summary}`);
    for (const f of c.findings.slice(0, 8)) {
      console.log(chalk.dim(`        · ${describeFinding(f)}`));
    }
    if (c.findings.length > 8) console.log(chalk.dim(`        … +${c.findings.length - 8} more`));
  }
  const s = snapshot.summary;
  console.log('');
  console.log(chalk.bold(`Summary: ${s.ok} ok · ${s.warn} warn · ${s.fail} fail · ${s.error} error`));
}


export function registerMonitorCommand(program) {
  const monitor = program
    .command('monitor')
    .description('Monitor org health — limits, Apex failures, security score, org info, deployment history, legacy API usage, paused flows, and metadata backup');

  monitor
    .command('all', { isDefault: true })
    .description('Run every monitoring check (add --backup to include a metadata backup)')
    .option('--org <alias>', 'Org alias (defaults to config.defaultOrg)')
    .option('--backup', 'Also run a full metadata backup')
    .option('--json', 'Emit structured JSON to stdout')
    .option('--notify', 'Send the snapshot to configured notification channels')
    .action((options) => executeMonitor(CHECK_IDS, options));

  for (const id of CHECK_IDS) {
    monitor
      .command(id)
      .description(`Run only the "${id}" monitoring check`)
      .option('--org <alias>', 'Org alias (defaults to config.defaultOrg)')
      .option('--json', 'Emit structured JSON to stdout')
      .action((options) => executeMonitor([id], options));
  }

  monitor
    .command('backup')
    .description('Retrieve a full metadata backup into the configured backup directory')
    .option('--org <alias>', 'Org alias (defaults to config.defaultOrg)')
    .option('--json', 'Emit structured JSON to stdout')
    .action((options) => executeBackup(options));
}
