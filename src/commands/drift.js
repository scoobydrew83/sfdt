import path from 'path';
import fs from 'fs-extra';
import { loadConfig } from '../lib/config.js';
import { runScript } from '../lib/script-runner.js';
import { print } from '../lib/output.js';
import { resolveExitCode } from '../lib/exit-codes.js';

export function registerDriftCommand(program) {
  program
    .command('drift')
    .description('Detect metadata drift between local source and a target org')
    .option('--org <alias>', 'Target org alias to check for drift')
    .option('--json', 'Emit structured JSON to stdout (CI mode)')
    .action(async (options) => {
      const jsonMode = !!options.json;
      try {
        const config = await loadConfig();
        const projectRoot = config._projectRoot;
        const orgAlias = options.org || config.defaultOrg;

        if (!jsonMode) print.header(`Drift Detection (${orgAlias})`);

        const env = { SFDT_TARGET_ORG: orgAlias };

        await runScript('ops/drift.sh', config, { cwd: projectRoot, env });

        if (jsonMode) {
          const logDir = config.logDir ?? path.join(projectRoot, 'logs');
          const driftData = await fs.readJson(path.join(logDir, 'drift-latest.json'));
          process.stdout.write(JSON.stringify(driftData, null, 2) + '\n');
        } else {
          print.success(`Drift detection for ${orgAlias} completed.`);
        }
      } catch (err) {
        if (jsonMode) {
          process.stdout.write(
            JSON.stringify({ status: 'error', message: err.message, exitCode: resolveExitCode(err) }) + '\n',
          );
        } else {
          print.error(`Drift detection failed: ${err.message}`);
        }
        process.exitCode = resolveExitCode(err);
      }
    });
}
