import chalk from 'chalk';
import { shapeClassCoverage, classCoverageBand } from '@sfdt/flow-core';
import { loadConfig } from '../lib/config.js';
import { query } from '../lib/org-query.js';
import { emitJson, emitJsonError } from '../lib/output.js';
import { resolveExitCode } from '../lib/exit-codes.js';

const BAND_COLOR = { green: chalk.green, amber: chalk.yellow, red: chalk.red, none: chalk.gray };

/**
 * `sfdt coverage` — report org-wide and per-class Apex code coverage from the
 * Tooling API. Exits non-zero when org-wide coverage falls below `--threshold`
 * so it can gate CI. Banding is shared with the Chrome extension and GUI via
 * `@sfdt/flow-core`.
 */
export function registerCoverageCommand(program) {
  program
    .command('coverage')
    .description('Report Apex code coverage (org-wide + per-class)')
    .option('--org <alias>', 'Org alias (defaults to config.defaultOrg)')
    .option('--threshold <pct>', 'Fail (exit non-zero) if org-wide coverage is below this percent', '75')
    .option('--json', 'Emit structured JSON to stdout')
    .action(async (options) => {
      const jsonMode = !!options.json;
      try {
        const config = await loadConfig();
        const orgAlias = options.org ?? config.defaultOrg;
        if (!orgAlias) {
          throw new Error('No org specified — pass --org <alias> or set defaultOrg in .sfdt/config.json');
        }

        const threshold = Number(options.threshold);
        if (!Number.isFinite(threshold)) {
          throw new Error(`Invalid --threshold: ${options.threshold}`);
        }

        const [orgRows, classRows] = await Promise.all([
          query(orgAlias, 'SELECT PercentCovered FROM ApexOrgWideCoverage', { tooling: true }),
          query(
            orgAlias,
            'SELECT ApexClassOrTrigger.Name, NumLinesCovered, NumLinesUncovered FROM ApexCodeCoverageAggregate',
            { tooling: true },
          ),
        ]);

        const orgWide = orgRows.length > 0 ? orgRows[0].PercentCovered : null;
        const classes = shapeClassCoverage(classRows);

        const belowThreshold = orgWide !== null && orgWide < threshold;
        const warnings = belowThreshold
          ? [`Org-wide coverage ${orgWide}% is below the ${threshold}% threshold`]
          : [];

        const result = {
          org: orgAlias,
          threshold,
          orgWide,
          belowThreshold,
          classes,
        };

        if (belowThreshold) process.exitCode = 1;

        if (jsonMode) {
          emitJson(result, { warnings });
          return;
        }

        console.log('');
        const orgLabel = orgWide === null ? 'unknown (run tests first)' : `${orgWide}%`;
        const colorize = belowThreshold ? chalk.red : chalk.green;
        console.log(chalk.bold(`  Org-wide coverage: ${colorize(orgLabel)} (threshold ${threshold}%)`));

        const worst = classes.filter((c) => c.pct === null || c.pct < threshold / 100).slice(0, 20);
        if (worst.length > 0) {
          console.log('');
          console.log(chalk.bold.cyan('  Classes below threshold (worst first):'));
          for (const c of worst) {
            const band = classCoverageBand(c.pct);
            const pctLabel = c.pct === null ? 'no lines' : `${Math.round(c.pct * 100)}%`;
            console.log(`    ${(BAND_COLOR[band] ?? chalk.white)(pctLabel.padEnd(10))} ${c.name}`);
          }
        }

        if (belowThreshold) {
          console.log('');
          console.log(chalk.red(`  ${warnings[0]}`));
        }
      } catch (err) {
        if (jsonMode) {
          emitJsonError(err);
        } else {
          console.error(chalk.red(`Coverage failed: ${err.message}`));
          process.exitCode = resolveExitCode(err);
        }
      }
    });
}
