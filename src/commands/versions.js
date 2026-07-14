/**
 * `sfdt versions` — audit Salesforce API versions across local source and the
 * org. Local scanning (Apex/Trigger/Flow/LWC/Aura meta files +
 * sourceApiVersion) always runs; the org side (per-type distributions + the
 * org's max API version) is added when an org resolves, and degrades to
 * local-only with a warning when it doesn't. Informational report — exit 0;
 * the CI-gating surface is `sfdt audit api-versions`.
 */

import chalk from 'chalk';
import { loadConfig } from '../lib/config.js';
import { scanLocalApiVersions, fetchOrgApiVersions, buildReport } from '../lib/api-versions.js';
import { AUDIT_DEFAULTS } from '../lib/audit-runner.js';
import { resolveExitCode } from '../lib/exit-codes.js';
import { emitJson, emitJsonError } from '../lib/output.js';

/**
 * `--advise`: AI upgrade advice for local components below the target
 * version, grounded by the curated per-version registry. Read-only advisory:
 * no writes, no agent loop; the http provider gets fully pre-gathered
 * context, agentic providers may additionally Read/Grep/Glob component
 * source. Returns the advice text, or null when nothing needs advising.
 * Throws when AI is unavailable (the user explicitly asked for it).
 */
async function runAdvise(config, report, local, options) {
  const { isAiAvailable, aiUnavailableMessage, runAiPrompt, providerSupportsAgenticTools } =
    await import('../lib/ai.js');
  if (!config?.features?.ai || !(await isAiAvailable(config))) {
    throw new Error(aiUnavailableMessage(config));
  }
  const { loadRegistry, selectComponents, buildAdvisorContext } = await import(
    '../lib/api-version-advisor.js'
  );
  const { getPrompt, interpolate } = await import('../lib/prompts.js');

  const registry = await loadRegistry();
  const target = options.target
    ? Number.parseInt(options.target, 10)
    : report.org?.ceiling ?? registry.maxVersion;
  if (!Number.isFinite(target)) throw new Error(`Invalid --target "${options.target}"`);

  const components = selectComponents(local.components, target, options.type ?? null);
  if (!components.length) return { target, advice: null };

  const vars = buildAdvisorContext({
    components,
    registry,
    targetVersion: target,
    sourceApiVersion: local.sourceApiVersion,
  });
  const prompt = interpolate(await getPrompt('api-upgrade-advisor', config._configDir), vars);
  const res = await runAiPrompt(prompt, {
    config,
    // Read-only: agentic providers may inspect component source; never write.
    allowedTools: providerSupportsAgenticTools(config) ? ['Read', 'Grep', 'Glob'] : [],
    cwd: config._projectRoot,
    aiEnabled: true,
    interactive: false,
  });
  const text = typeof res?.stdout === 'string' ? res.stdout.trim() : '';
  if (!text) throw new Error('The AI provider returned no advice output.');
  return { target, advice: text, componentCount: components.length };
}

/** Band a histogram row: red below the hard floor, yellow behind the ceiling. */
function bandRow({ version, count }, { minApiVersion, effectiveFloor }) {
  const label = version === 'unspecified' ? 'unspecified' : `v${version}`;
  const text = `${label} ×${count}`;
  if (version === 'unspecified') return chalk.dim(text);
  const v = Number(version);
  if (v < minApiVersion) return chalk.red(text);
  if (v < effectiveFloor) return chalk.yellow(text);
  return text;
}

function printSide(label, side, thresholds) {
  console.log(chalk.bold(`\n${label}`));
  for (const [type, { count, histogram }] of Object.entries(side.byType)) {
    const rows = histogram.map((h) => bandRow(h, thresholds)).join(' · ');
    console.log(`  ${type.padEnd(12)} ${String(count).padStart(4)}  ${rows}`);
  }
  if (!Object.keys(side.byType).length) console.log(chalk.dim('  (no components found)'));
  const outliers = side.outliers ?? [];
  if (outliers.length) {
    console.log(chalk.yellow(`  ${outliers.length} component(s) below the effective floor v${thresholds.effectiveFloor}:`));
    for (const o of outliers.slice(0, 15)) {
      const why = o.reason === 'below-floor' ? chalk.red('below-floor') : chalk.yellow('behind-ceiling');
      console.log(`    ${o.type.padEnd(12)} ${String(o.name).padEnd(40)} v${o.apiVersion} ${why}`);
    }
    if (outliers.length > 15) console.log(chalk.dim(`    … and ${outliers.length - 15} more (use --json for the full list)`));
  }
}

export function registerVersionsCommand(program) {
  program
    .command('versions')
    .description('Audit Salesforce API versions across local source and the org (Apex, Flow, LWC, Aura vs the org max)')
    .option('--org <alias>', 'Target org (default: config.defaultOrg)')
    .option('--local-only', 'Skip the org side even when an org is configured')
    .option('--advise', 'AI upgrade advice for local components below the target version (requires features.ai; grounded by the curated per-version registry)')
    .option('--target <version>', 'For --advise: target API version (default: the org max, or the registry max offline)')
    .option('--type <family>', 'For --advise: restrict to one family — apex | flow | lwc')
    .option('--json', 'Emit the full report as JSON')
    .action(async (options) => {
      const jsonMode = !!options.json;
      try {
        const config = await loadConfig();
        const thresholds = {
          minApiVersion: config.audit?.minApiVersion ?? AUDIT_DEFAULTS.minApiVersion,
          warnBehind: config.audit?.apiVersionWarnBehind ?? AUDIT_DEFAULTS.apiVersionWarnBehind,
        };

        const local = await scanLocalApiVersions(config);

        let org = null;
        const orgAlias = options.org || config.defaultOrg;
        if (!options.localOnly && orgAlias) {
          try {
            org = await fetchOrgApiVersions(orgAlias);
          } catch (err) {
            if (!jsonMode) {
              console.error(chalk.yellow(`Org "${orgAlias}" not reachable (${err.message}) — local-only report.`));
            }
          }
        }

        const report = buildReport(local, org, thresholds);

        if (options.type && !['apex', 'flow', 'lwc'].includes(options.type)) {
          throw new Error(`--type must be one of: apex, flow, lwc (got: ${options.type})`);
        }
        const advise = options.advise ? await runAdvise(config, report, local, options) : null;

        if (jsonMode) {
          emitJson(advise ? { ...report, advise } : report);
          return;
        }

        console.log(chalk.bold('\nAPI Version Audit'));
        console.log(
          chalk.dim(
            `floor v${report.thresholds.minApiVersion}` +
              (report.thresholds.warnBehind > 0 ? ` · warn-behind ${report.thresholds.warnBehind}` : '') +
              ` · effective floor v${report.thresholds.effectiveFloor}`,
          ),
        );
        if (local.sourceApiVersion) {
          console.log(chalk.dim(`sourceApiVersion (sfdx-project.json): ${local.sourceApiVersion} — inherited by "unspecified" components`));
        }
        if (report.org?.ceiling) {
          console.log(
            `Org max: ${chalk.bold(`v${report.org.ceiling}`)}` +
              (report.org.release ? ` — ${report.org.release}` : '') +
              (report.org.preview ? chalk.yellow(' (preview)') : ''),
          );
          if (report.org.degraded.length) {
            console.log(chalk.dim(`  (${report.org.degraded.join(', ')} not queryable on this org)`));
          }
        }

        printSide('Local source', report.local, report.thresholds);
        if (report.org) printSide(`Org (${orgAlias})`, report.org, report.thresholds);
        else console.log(chalk.dim('\nOrg side skipped — pass --org <alias> (or set defaultOrg) for the org comparison.'));

        if (advise) {
          if (advise.advice) {
            console.log(chalk.bold(`\nUpgrade advice → v${advise.target}`) + chalk.dim(` (${advise.componentCount} component(s), grounded by the curated version registry)`));
            console.log(`\n${advise.advice}`);
          } else {
            console.log(chalk.green(`\nNothing to advise — every local component is already at or above v${advise.target}.`));
          }
        }
        console.log('');
        // ponytail: exit 0 always — informational report; add --strict if CI wants gating.
      } catch (err) {
        if (jsonMode) {
          emitJsonError(err);
        } else {
          console.error(chalk.red(`versions failed: ${err.message}`));
        }
        process.exitCode = resolveExitCode(err);
      }
    });
}
