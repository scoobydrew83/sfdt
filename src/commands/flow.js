// `sfdt flow` parent command — runs Flow-specific analyses CLI-side using the
// same @sfdt/flow-core engine the extension uses, so canvas results and CLI
// results match byte-for-byte.

import path from 'path';
import fs from 'fs-extra';
import chalk from 'chalk';
import ora from 'ora';
import { execa } from 'execa';
import {
  buildIssueFamilies,
  calculateScore,
  detectTriggerConflicts,
  evaluate,
  normalize,
} from '@sfdt/flow-core';
import { loadConfig } from '../lib/config.js';
import { resolveExitCode } from '../lib/exit-codes.js';

const DEFAULT_RULES_CONFIG = {
  outdatedApiVersionThreshold: 6,
  currentApiVersion: 65,
  highDataOperationThreshold: 8,
  namingConventions: {
    variable: /^var[A-Z].*/,
    formula: /^frm[A-Z].*/,
    constant: /^con[A-Z].*/,
  },
};

const METADATA_FETCH_CONCURRENCY = 5;

/**
 * Run a Tooling-API SOQL query via `sf data query --use-tooling-api`.
 * Same surface area sfdt's other commands use; keeps auth + token handling
 * inside the official Salesforce CLI.
 */
async function toolingQuery(orgAlias, soql) {
  const result = await execa(
    'sf',
    ['data', 'query', '--use-tooling-api', '-q', soql, '--json', '--target-org', orgAlias],
    { reject: true },
  );
  return JSON.parse(result.stdout);
}

async function listFlowDefinitions(orgAlias) {
  const soql =
    'SELECT Id, DeveloperName, ActiveVersionId FROM FlowDefinition ' +
    'WHERE ActiveVersionId != null ORDER BY DeveloperName ASC';
  const result = await toolingQuery(orgAlias, soql);
  return result.result?.records ?? [];
}

async function fetchActiveVersion(orgAlias, activeVersionId) {
  const soql =
    'SELECT Id, MasterLabel, Description, Status, VersionNumber, LastModifiedDate, Metadata ' +
    `FROM Flow WHERE Id = '${activeVersionId.replace(/'/g, "\\'")}'`;
  const result = await toolingQuery(orgAlias, soql);
  return result.result?.records?.[0] ?? null;
}

async function inParallel(items, concurrency, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined) return;
      await worker(next);
    }
  });
  await Promise.all(runners);
}

function buildFlowReport(record, definition) {
  const metadata = record.Metadata ?? {};
  const normalized = normalize(metadata, {
    flowVersionId: record.Id,
    flowApiName: definition.DeveloperName,
  });
  const findings = evaluate(normalized, DEFAULT_RULES_CONFIG);
  const issueFamilies = buildIssueFamilies(findings);
  const score = calculateScore(issueFamilies);
  return {
    flowDefinitionId: definition.Id,
    flowVersionId: record.Id,
    developerName: definition.DeveloperName,
    label: record.MasterLabel ?? definition.DeveloperName,
    flowType: normalized.meta.flowType,
    apiVersion: normalized.meta.apiVersion,
    status: normalized.meta.status,
    overallScore: score.overallScore,
    rating: score.rating,
    severityCounts: score.severityCounts,
    categoryCounts: score.categoryCounts,
    issueFamilyCount: issueFamilies.length,
    issueFamilies,
  };
}

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
        const definitions = await listFlowDefinitions(orgAlias);
        if (spinner) spinner.text = `Analysing ${definitions.length} Flow${definitions.length === 1 ? '' : 's'}…`;

        const reports = [];
        const errors = [];
        await inParallel(definitions, METADATA_FETCH_CONCURRENCY, async (def) => {
          try {
            const record = await fetchActiveVersion(orgAlias, def.ActiveVersionId);
            if (!record?.Metadata) return;
            reports.push(buildFlowReport(record, def));
          } catch (err) {
            errors.push({
              flowDefinitionId: def.Id,
              developerName: def.DeveloperName,
              message: err instanceof Error ? err.message : String(err),
            });
          }
        });

        // Rank flows by lowest score first so the worst offenders surface at
        // the top of the report.
        reports.sort((a, b) => a.overallScore - b.overallScore);

        spinner?.succeed(`Analysed ${reports.length} Flow${reports.length === 1 ? '' : 's'}`);

        const output = {
          timestamp: new Date().toISOString(),
          org: orgAlias,
          totalFlows: reports.length,
          totalErrors: errors.length,
          averageScore:
            reports.length > 0
              ? Math.round(reports.reduce((sum, r) => sum + r.overallScore, 0) / reports.length)
              : null,
          reports,
          errors,
        };

        if (jsonMode) {
          process.stdout.write(JSON.stringify(output, null, 2) + '\n');
          return;
        }
        await fs.ensureDir(path.dirname(outPath));
        await fs.writeJson(outPath, output, { spaces: 2 });
        console.log(chalk.green(`\nReport written to ${outPath}`));
        console.log(
          chalk.bold(
            `${reports.length} flow${reports.length === 1 ? '' : 's'} analysed · avg score ${output.averageScore} · ${errors.length} error${errors.length === 1 ? '' : 's'}`,
          ),
        );
        if (reports.length > 0) {
          console.log(chalk.dim('\nWorst offenders:'));
          for (const r of reports.slice(0, 5)) {
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
        const definitions = await listFlowDefinitions(orgAlias);
        if (spinner) spinner.text = `Fetching metadata for ${definitions.length} flows…`;

        const candidates = [];
        const errors = [];
        await inParallel(definitions, METADATA_FETCH_CONCURRENCY, async (def) => {
          try {
            const record = await fetchActiveVersion(orgAlias, def.ActiveVersionId);
            if (!record?.Metadata) return;
            candidates.push({
              flowId: def.DeveloperName,
              label: record.MasterLabel ?? def.DeveloperName,
              metadata: record.Metadata,
            });
          } catch (err) {
            errors.push({
              flowDefinitionId: def.Id,
              developerName: def.DeveloperName,
              message: err instanceof Error ? err.message : String(err),
            });
          }
        });

        const groups = detectTriggerConflicts(candidates);
        spinner?.succeed(
          `Found ${groups.length} conflict group${groups.length === 1 ? '' : 's'} across ${candidates.length} flow${candidates.length === 1 ? '' : 's'}`,
        );

        const output = {
          timestamp: new Date().toISOString(),
          org: orgAlias,
          totalGroups: groups.length,
          totalFlowsInConflicts: groups.reduce((n, g) => n + g.flows.length, 0),
          groups,
          errors,
        };

        if (jsonMode) {
          process.stdout.write(JSON.stringify(output, null, 2) + '\n');
          return;
        }
        await fs.ensureDir(path.dirname(outPath));
        await fs.writeJson(outPath, output, { spaces: 2 });
        console.log(chalk.green(`\nReport written to ${outPath}`));
        if (groups.length === 0) {
          console.log(chalk.dim('No record-triggered conflicts detected.'));
        } else {
          for (const group of groups) {
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
