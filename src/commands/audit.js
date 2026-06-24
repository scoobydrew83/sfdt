import path from 'path';
import fs from 'fs-extra';
import ora from 'ora';
import chalk from 'chalk';
import { describeFinding } from '@sfdt/flow-core';
import { loadConfig } from '../lib/config.js';
import { runAudit, CHECK_IDS, AUDIT_DEFAULTS } from '../lib/audit-runner.js';
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
    audittrail: { lookbackDays: a.auditTrailLookbackDays ?? AUDIT_DEFAULTS.auditTrailLookbackDays },
    licenses: { warnThreshold: a.licenseWarnThreshold ?? AUDIT_DEFAULTS.licenseWarnThreshold },
    'inactive-users': { lookbackDays: a.inactiveUserDays ?? AUDIT_DEFAULTS.inactiveUserDays },
    'api-versions': { minApiVersion: a.minApiVersion ?? AUDIT_DEFAULTS.minApiVersion },
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

    // Always persist the snapshot — the GUI (/api/audit) and bridge org-health
    // handler read this file, so --json runs (CI/automation) must update it too.
    // A write failure must not fail the (successful) audit or emit a second JSON
    // envelope to stdout — warn on stderr and carry on.
    try {
      await fs.ensureDir(logDir);
      await fs.writeJson(outPath, snapshot, { spaces: 2 });
    } catch (writeErr) {
      process.stderr.write(`Warning: could not write snapshot to ${outPath}: ${writeErr.message}\n`);
    }

    if (jsonMode) {
      process.stdout.write(JSON.stringify(snapshot, null, 2) + '\n');
    } else {
      printReport(snapshot);
      console.log(chalk.dim(`\nSnapshot written to ${outPath}`));
    }

    // Non-zero exit when any check failed outright OR errored (e.g. an
    // unreachable org / missing permission) — but not for warnings. An errored
    // check must not read as a healthy org in CI.
    if (snapshot.summary.fail > 0 || snapshot.summary.error > 0) process.exitCode = 1;
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
