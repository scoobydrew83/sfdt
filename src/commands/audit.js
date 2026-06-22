import path from 'path';
import fs from 'fs-extra';
import ora from 'ora';
import chalk from 'chalk';
import { loadConfig } from '../lib/config.js';
import { runAudit, CHECK_IDS } from '../lib/audit-runner.js';
import { resolveExitCode } from '../lib/exit-codes.js';

const STATUS_COLOR = {
  ok: chalk.green,
  warn: chalk.yellow,
  fail: chalk.red,
  error: chalk.red,
};

function buildParams(config) {
  const a = config.audit ?? {};
  return {
    audittrail: { lookbackDays: a.auditTrailLookbackDays ?? 30 },
    licenses: { warnThreshold: a.licenseWarnThreshold ?? 0.9 },
    'inactive-users': { lookbackDays: a.inactiveUserDays ?? 90 },
    'api-versions': { minApiVersion: a.minApiVersion ?? 45 },
  };
}

async function executeAudit(checks, options) {
  const jsonMode = !!options.json;
  try {
    const config = await loadConfig();
    const orgAlias = options.org ?? config.defaultOrg;
    if (!orgAlias) {
      throw new Error('No org specified — pass --org <alias> or set defaultOrg in .sfdt/config.json');
    }
    const logDir = config.logDir ?? path.join(config._projectRoot, 'logs');
    const outPath = path.join(logDir, 'audit-latest.json');

    const spinner = jsonMode ? null : ora(`Running org audit against ${orgAlias}…`).start();
    let snapshot;
    try {
      snapshot = await runAudit(orgAlias, { checks, params: buildParams(config) });
      spinner?.succeed(`Audit complete (${orgAlias})`);
    } catch (err) {
      spinner?.fail('Audit failed');
      throw err;
    }

    if (jsonMode) {
      process.stdout.write(JSON.stringify(snapshot, null, 2) + '\n');
    } else {
      await fs.ensureDir(logDir);
      await fs.writeJson(outPath, snapshot, { spaces: 2 });
      printReport(snapshot);
      console.log(chalk.dim(`\nSnapshot written to ${outPath}`));
    }

    // Non-zero exit when any check failed outright (not warnings).
    if (snapshot.summary.fail > 0) process.exitCode = 1;
  } catch (err) {
    if (jsonMode) {
      process.stdout.write(JSON.stringify({ status: 'error', message: err.message, exitCode: resolveExitCode(err) }) + '\n');
    } else {
      console.error(chalk.red(`Audit failed: ${err.message}`));
    }
    process.exitCode = resolveExitCode(err);
  }
}

function printReport(snapshot) {
  console.log('');
  for (const c of snapshot.checks) {
    const color = STATUS_COLOR[c.status] ?? chalk.white;
    console.log(`${color(c.status.toUpperCase().padEnd(5))} ${chalk.bold(c.title)} — ${c.summary}`);
    for (const f of c.findings.slice(0, 10)) {
      console.log(chalk.dim(`        · ${describeFinding(f)}`));
    }
    if (c.findings.length > 10) {
      console.log(chalk.dim(`        … +${c.findings.length - 10} more`));
    }
  }
  const s = snapshot.summary;
  console.log('');
  console.log(chalk.bold(`Summary: ${s.ok} ok · ${s.warn} warn · ${s.fail} fail · ${s.error} error`));
}

function describeFinding(f) {
  if (f.name && f.apiVersion) return `${f.type ? f.type + ' ' : ''}${f.name} (API ${f.apiVersion})`;
  if (f.username) return `${f.name ?? f.username} <${f.username}>${f.lastLogin ? ` last login ${f.lastLogin}` : ''}`;
  if (f.action) return `${f.date}: ${f.action} (${f.section}) by ${f.user}`;
  if (f.name && f.total != null) return `${f.name}: ${f.used}/${f.total}`;
  if (f.name) return f.name;
  return JSON.stringify(f);
}

export function registerAuditCommand(program) {
  const audit = program
    .command('audit')
    .description('Diagnose org health — audit trail, licenses, MFA, unused Apex, inactive users, API versions');

  audit
    .command('all', { isDefault: true })
    .description('Run every audit check and write a snapshot')
    .option('--org <alias>', 'Org alias (defaults to config.defaultOrg)')
    .option('--json', 'Emit structured JSON to stdout')
    .action((options) => executeAudit(CHECK_IDS, options));

  for (const id of CHECK_IDS) {
    audit
      .command(id)
      .description(`Run only the "${id}" audit check`)
      .option('--org <alias>', 'Org alias (defaults to config.defaultOrg)')
      .option('--json', 'Emit structured JSON to stdout')
      .action((options) => executeAudit([id], options));
  }
}
