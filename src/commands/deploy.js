import path from 'path';
import { loadConfig } from '../lib/config.js';
import { runScript } from '../lib/script-runner.js';
import { print } from '../lib/output.js';
import { resolveExitCode } from '../lib/exit-codes.js';
import { writeRawLog } from '../lib/log-writer.js';
export function registerDeployCommand(program) {
  program
    .command('deploy')
    .description('Deploy to a Salesforce org using the configured deployment script')
    .option('--managed', 'Use deploy-manager.sh instead of deployment-assistant.sh')
    .option('--skip-preflight', 'Skip pre-deployment preflight checks')
    .option('--dry-run', 'Show what would be executed without running')
    .option('--org <alias>', 'Target org alias for deployment')
    .option('--source-dir <path>', 'Deploy a source directory instead of a manifest (relative to project root)')
    .action(async (options) => {
      try {
        const config = await loadConfig();
        const projectRoot = config._projectRoot;
        const orgAlias = options.org || config.defaultOrg;
        if (!options.skipPreflight) {
          print.info('Running preflight checks...');
          const preflightEnv = {};
          if (config.deployment?.preflight?.strict) {
            preflightEnv.SFDT_PREFLIGHT_STRICT = 'true';
          }
          try {
            await runScript('ops/preflight.sh', config, {
              cwd: projectRoot,
              env: preflightEnv,
              dryRun: options.dryRun,
            });
            if (!options.dryRun) print.success('Preflight passed.');
          } catch (prefErr) {
            print.error(`Preflight failed — aborting deploy: ${prefErr.message}`);
            process.exitCode = resolveExitCode(prefErr);
            return;
          }
        }
        const scriptPath = options.managed
          ? 'core/deploy-manager.sh'
          : 'core/deployment-assistant.sh';
        print.header(`Deploying${options.managed ? ' (managed)' : ''}${options.sourceDir ? ` [${options.sourceDir}]` : ''}${options.dryRun ? ' [dry-run]' : ''}`);
        const extraEnv = {};
        if (options.sourceDir) {
          if (path.isAbsolute(options.sourceDir) || options.sourceDir.includes('..')) {
            throw new Error('--source-dir must be a relative path within the project');
          }
          extraEnv.SFDT_DEPLOY_SOURCE_DIR = options.sourceDir;
        }
        const deployStart = Date.now();
        const deployResult = await runScript(scriptPath, config, {
          cwd: projectRoot,
          dryRun: options.dryRun,
          env: extraEnv,
        });
        if (!options.dryRun) {
          const logDir = config.logDir ?? path.join(projectRoot, 'logs');
          await writeRawLog(logDir, 'deploy', deployResult.stdout ?? '', {
            org: orgAlias,
            exitCode: 0,
            durationMs: Date.now() - deployStart,
            retention: config.logRetention ?? 50,
          }).catch((e) => console.debug('Log write failed:', e.message));
        }
        print.success(options.dryRun ? 'Dry-run complete — no changes made.' : 'Deployment completed successfully.');
      } catch (err) {
        print.error(`Deployment failed: ${err.message}`);
        process.exitCode = resolveExitCode(err);
      }
    });
}
