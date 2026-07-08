import chalk from 'chalk';
import {
  resolveQueryFor,
  referencesQuery,
  referencedByQuery,
  groupByType,
} from '@sfdt/flow-core';
import { loadConfig } from '../lib/config.js';
import { query } from '../lib/org-query.js';
import { emitJson, emitJsonError } from '../lib/output.js';
import { resolveExitCode } from '../lib/exit-codes.js';
import { runGapReport } from '../lib/source-dependencies.js';

/**
 * `sfdt dependencies <name>` — show what a metadata component references and what
 * references it, via the Tooling API's MetadataComponentDependency object.
 * Resolution/grouping logic is shared with the Chrome extension and GUI through
 * `@sfdt/flow-core` so all three behave identically.
 */
export function registerDependenciesCommand(program) {
  program
    .command('dependencies <name>')
    .description('Show metadata dependencies for a component (references + referenced-by)')
    .option('--type <MetadataType>', 'Metadata type to resolve (ApexClass, ApexTrigger, ApexPage, ApexComponent, Flow, LightningComponentBundle, AuraDefinitionBundle, CustomField)', 'ApexClass')
    .option('--org <alias>', 'Org alias (defaults to config.defaultOrg)')
    .option('--json', 'Emit structured JSON to stdout')
    .option('--gaps', 'Report source-parsed references the Tooling API may miss (offline; pass --org to diff)')
    .action(async (name, options) => {
      if (options.gaps) {
        const jsonMode = !!options.json;
        try {
          const config = await loadConfig();
          const org = options.org ?? undefined; // gaps is offline by default; --org explicitly opts into the Tooling diff
          const report = await runGapReport(config, { name, type: options.type, org });
          if (jsonMode) { emitJson(report); return; }
          printGapReport(report);
        } catch (err) {
          if (jsonMode) emitJsonError(err);
          else { console.error(chalk.red(`Gap report failed: ${err.message}`)); process.exitCode = resolveExitCode(err); }
        }
        return;
      }

      const jsonMode = !!options.json;
      try {
        const config = await loadConfig();
        const orgAlias = options.org ?? config.defaultOrg;
        if (!orgAlias) {
          throw new Error('No org specified — pass --org <alias> or set defaultOrg in .sfdt/config.json');
        }

        const type = options.type;
        // resolveQueryFor throws on an unsupported type — let it surface as a clean error.
        const idRows = await query(orgAlias, resolveQueryFor(type, name), { tooling: true });

        if (idRows.length === 0) {
          const message = `No ${type} named "${name}" found in ${orgAlias}`;
          const result = { org: orgAlias, type, name, found: false, references: [], referencedBy: [] };
          if (jsonMode) {
            emitJson(result, { warnings: [message] });
          } else {
            console.log(chalk.yellow(`\n  ${message}`));
          }
          return;
        }

        const id = idRows[0].Id;
        const [refRows, refByRows] = await Promise.all([
          query(orgAlias, referencesQuery(id), { tooling: true }),
          query(orgAlias, referencedByQuery(id), { tooling: true }),
        ]);

        const references = groupByType(refRows, 'RefMetadataComponentName', 'RefMetadataComponentType');
        const referencedBy = groupByType(refByRows, 'MetadataComponentName', 'MetadataComponentType');

        const result = { org: orgAlias, type, name, found: true, references, referencedBy };

        if (jsonMode) {
          emitJson(result);
          return;
        }

        printGroups(`${type} ${name} references (${type} → others)`, references);
        printGroups(`Referenced by (others → ${type} ${name})`, referencedBy);
      } catch (err) {
        if (jsonMode) {
          emitJsonError(err);
        } else {
          console.error(chalk.red(`Dependencies failed: ${err.message}`));
          process.exitCode = resolveExitCode(err);
        }
      }
    });
}

function printGapReport(report) {
  const { from, org, gaps } = report;
  console.log('');
  const title = org ? `Inferred references for ${from.type} ${from.name} (diffed against ${org})` : `Inferred references for ${from.type} ${from.name} (local source)`;
  console.log(chalk.bold.cyan(`  ${title}`));
  if (!gaps.length) { console.log(chalk.gray('    (no source-parsed references found)')); return; }
  for (const { ref, status } of gaps) {
    const tag = status === 'missing' ? chalk.red('MISSING') : status === 'confirmed' ? chalk.green('confirmed') : chalk.yellow('inferred');
    console.log(`    [${tag}] ${ref.kind}  ${ref.toType}:${ref.toName}  ${chalk.gray(`(${ref.evidence} @${ref.line})`)}`);
  }
}

function printGroups(title, groups) {
  console.log('');
  console.log(chalk.bold.cyan(`  ${title}`));
  if (groups.length === 0) {
    console.log(chalk.gray('    (none)'));
    return;
  }
  for (const { type, names } of groups) {
    console.log(chalk.bold(`    ${type}`));
    for (const name of names) {
      console.log(`      ${name}`);
    }
  }
}
