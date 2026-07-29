import chalk from 'chalk';
import { loadConfig } from '../lib/config.js';
import {
  searchSObjects,
  describeSObject,
  discoverRelationships,
  validateQuery,
  explainQuery,
  runQuery,
  runSearch,
} from '../lib/soql-runner.js';
import { resolveExitCode } from '../lib/exit-codes.js';
import { emitJson, emitJsonError } from '../lib/output.js';

/**
 * `sfdt soql` — the SOQL/SOSL toolkit. Thin registration only: every
 * subcommand loads config and delegates to src/lib/soql-runner.js
 * (golden principle #1).
 */

/** Wrap a runner call with the shared config/json/error plumbing. */
function makeAction(fn, { render } = {}) {
  // Commander invokes actions with (positionals..., options, command).
  return async (...cliArgs) => {
    const options = cliArgs[cliArgs.length - 2];
    const positionals = cliArgs.slice(0, -2);
    const jsonMode = !!options.json;
    try {
      const config = await loadConfig();
      const result = await fn(config, positionals, options);
      if (jsonMode) emitJson(result);
      else if (render) render(result);
      else console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      if (jsonMode) {
        emitJsonError(err);
      } else {
        console.error(chalk.red(err.message));
        process.exitCode = resolveExitCode(err);
      }
    }
  };
}

function renderSearch(r) {
  console.log(chalk.bold(`\nsObjects on ${r.org}`) + chalk.dim(` (${r.category}${r.term ? `, matching "${r.term}"` : ''})`));
  for (const name of r.matches) console.log(`  ${name}`);
  console.log(chalk.dim(`\n${r.totalMatched} match(es) of ${r.totalScanned} scanned${r.truncated ? ` — showing first ${r.matches.length}, raise --limit for more` : ''}`));
}

function renderDescribe(r) {
  console.log(chalk.bold(`\n${r.name}`) + chalk.dim(` — ${r.label}${r.custom ? ' (custom)' : ''} · keyPrefix ${r.keyPrefix ?? 'n/a'} · ${r.fieldCount} field(s)`));
  if (r.filter) console.log(chalk.dim(`field filter: "${r.filter}" → ${r.fields.length} match(es)`));
  for (const f of r.fields) {
    const ref = f.referenceTo.length ? chalk.dim(` → ${f.referenceTo.join('|')}`) : '';
    const pick = f.picklistValues.length ? chalk.dim(` [${f.picklistValues.slice(0, 6).join(', ')}${f.picklistValues.length > 6 ? ', …' : ''}]`) : '';
    console.log(`  ${f.name.padEnd(40)} ${f.type}${ref}${pick}`);
  }
  if (r.childRelationships.length) {
    console.log(chalk.bold('\nChild relationships'));
    for (const c of r.childRelationships) console.log(`  ${String(c.relationshipName).padEnd(40)} ${c.childSObject} (${c.field})`);
  }
}

function renderRelationships(r) {
  console.log(chalk.bold(`\nRelationships of ${r.sobject}`) + chalk.dim(` (${r.org})`));
  if (r.parents) {
    console.log(chalk.bold('\nParents (dot notation, e.g. Field__r.Name)'));
    if (!r.parents.length) console.log(chalk.dim('  (none)'));
    for (const p of r.parents) console.log(`  ${String(p.relationshipName ?? p.field).padEnd(40)} ${p.referenceTo.join('|')} via ${p.field}`);
  }
  if (r.children) {
    console.log(chalk.bold('\nChildren (subqueries, e.g. (SELECT … FROM Contacts))'));
    if (!r.children.length) console.log(chalk.dim('  (none)'));
    for (const c of r.children) console.log(`  ${String(c.relationshipName).padEnd(40)} ${c.childSObject} (${c.field})`);
  }
}

function renderValidate(r) {
  const badge = r.valid ? chalk.green('VALID') : chalk.red('INVALID');
  console.log(`\n${badge} ${chalk.dim(`(${r.kind}, ${r.mode} validation)`)}`);
  for (const e of r.errors) console.log(chalk.red(`  ✗ ${e}`));
  for (const w of r.warnings) console.log(chalk.yellow(`  ⚠ ${w}`));
}

function renderPlan(r) {
  console.log(chalk.bold(`\nQuery plans`) + chalk.dim(` (${r.org}, API v${r.apiVersion}) — lowest relativeCost wins`));
  if (!r.plans.length) console.log(chalk.dim('  (no plans returned)'));
  for (const p of r.plans) {
    console.log(`  ${String(p.leadingOperationType).padEnd(12)} cost ${p.relativeCost}  cardinality ${p.cardinality}/${p.sobjectCardinality}  ${p.fields.join(', ') || '(no leading fields)'}`);
    for (const n of p.notes) console.log(chalk.dim(`    note: ${n.description}${n.fields?.length ? ` [${n.fields.join(', ')}]` : ''}`));
  }
}

function renderQuery(r) {
  const boundNote =
    r.bound.action === 'kept' ? '' : r.bound.action === 'clamped' ? chalk.yellow(` (LIMIT clamped to ${r.bound.limit})`) : chalk.dim(` (LIMIT ${r.bound.limit} applied)`);
  console.log(chalk.bold(`\n${r.returned} row(s)`) + chalk.dim(` of ${r.totalSize ?? r.returned} total (${r.org})`) + boundNote);
  console.log(JSON.stringify(r.records, null, 2));
  if (r.truncated) console.log(chalk.yellow(`\n⚠ Result truncated — raise --limit (max ${r.bound.max}, config soql.maxLimit) or add a WHERE filter.`));
  if (r.export) console.log(chalk.green(`Exported ${r.export.rows} row(s) → ${r.export.file} (${r.export.format})`));
}

export function registerSoqlCommand(program) {
  const soql = program
    .command('soql')
    .description('SOQL/SOSL toolkit — schema search/describe, relationships, query validation, plans, bounded execution');

  soql
    .command('search [term]')
    .description('Find sObjects by name (schema search across the org inventory)')
    .option('--org <alias>', 'Org alias (defaults to config.defaultOrg)')
    .option('--category <cat>', 'all | custom | standard', 'all')
    .option('--limit <n>', 'Maximum matches to return (default 100)')
    .option('--json', 'Emit structured JSON to stdout')
    .action(makeAction(
      (config, [term], options) => searchSObjects(config, term, options),
      { render: renderSearch },
    ));

  soql
    .command('describe <sobject>')
    .description('Describe an sObject: fields, types, picklists, and child relationships')
    .option('--org <alias>', 'Org alias (defaults to config.defaultOrg)')
    .option('--filter <term>', 'Only show fields whose API name or label contains this substring')
    .option('--tooling', 'Describe a Tooling API object')
    .option('--json', 'Emit structured JSON to stdout')
    .action(makeAction(
      (config, [name], options) => describeSObject(config, name, options),
      { render: renderDescribe },
    ));

  soql
    .command('relationships <sobject>')
    .description('Discover parent lookups (dot notation) and child relationships (subqueries) of an sObject')
    .option('--org <alias>', 'Org alias (defaults to config.defaultOrg)')
    .option('--direction <dir>', 'parent | child | both', 'both')
    .option('--json', 'Emit structured JSON to stdout')
    .action(makeAction(
      (config, [name], options) => discoverRelationships(config, name, options),
      { render: renderRelationships },
    ));

  soql
    .command('validate <query>')
    .description('Validate a SOQL query without executing it (local checks + an org LIMIT 0 round-trip)')
    .option('--org <alias>', 'Org alias (defaults to config.defaultOrg)')
    .option('--local-only', 'Skip the org round-trip even when an org is configured')
    .option('--tooling', 'Validate against the Tooling API')
    .option('--json', 'Emit structured JSON to stdout')
    .action(makeAction(
      async (config, [query], options) => {
        const result = await validateQuery(config, query, {
          org: options.org,
          tooling: options.tooling,
          localOnly: options.localOnly,
        });
        // CI gate: an invalid query exits non-zero (envelope still emitted in --json).
        if (!result.valid) process.exitCode = 1;
        return result;
      },
      { render: renderValidate },
    ));

  soql
    .command('plan <query>')
    .description('Fetch the org query plans for a SOQL query (REST explain — the query is never executed)')
    .option('--org <alias>', 'Org alias (defaults to config.defaultOrg)')
    .option('--api-version <ver>', 'REST API version (default: sourceApiVersion from sfdx-project.json)')
    .option('--json', 'Emit structured JSON to stdout')
    .action(makeAction(
      (config, [query], options) => explainQuery(config, query, { org: options.org, apiVersion: options.apiVersion }),
      { render: renderPlan },
    ));

  soql
    .command('query <soql>')
    .description('Execute a SOQL query with a row bound enforced (never unbounded); optionally export the rows')
    .option('--org <alias>', 'Org alias (defaults to config.defaultOrg)')
    .option('--limit <n>', 'Row bound (default config soql.defaultLimit, clamped to soql.maxLimit)')
    .option('--tooling', 'Query the Tooling API')
    .option('--all-rows', 'Include deleted and archived rows')
    .option('--out <file>', 'Export the raw records to a file (.json or .csv)')
    .option('--format <fmt>', 'Export format: json | csv (default: from --out extension)')
    .option('--json', 'Emit structured JSON to stdout')
    .action(makeAction(
      (config, [query], options) =>
        runQuery(config, query, {
          org: options.org,
          tooling: options.tooling,
          allRows: options.allRows,
          limit: options.limit,
          out: options.out,
          format: options.format,
        }),
      { render: renderQuery },
    ));

  soql
    .command('sosl <search>')
    .description('Execute a SOSL search (FIND {…}) with a row bound enforced; optionally export the rows')
    .option('--org <alias>', 'Org alias (defaults to config.defaultOrg)')
    .option('--limit <n>', 'Row bound (default config soql.defaultLimit, clamped to soql.maxLimit)')
    .option('--out <file>', 'Export the raw records to a file (.json or .csv)')
    .option('--format <fmt>', 'Export format: json | csv (default: from --out extension)')
    .option('--json', 'Emit structured JSON to stdout')
    .action(makeAction(
      (config, [search], options) =>
        runSearch(config, search, {
          org: options.org,
          limit: options.limit,
          out: options.out,
          format: options.format,
        }),
      { render: renderQuery },
    ));
}
