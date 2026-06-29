import path from 'path';
import fs from 'fs-extra';
import { execa } from 'execa';
import { loadConfig } from '../lib/config.js';
import { runScript } from '../lib/script-runner.js';
import { print } from '../lib/output.js';
import { resolveExitCode } from '../lib/exit-codes.js';
import { writeRawLog } from '../lib/log-writer.js';
import { prepareSmartDeploy } from '../lib/smart-deploy.js';
import { isAiAvailable, runAiPrompt } from '../lib/ai.js';
import { getPrompt } from '../lib/prompts.js';
import { runFixLoop } from '../lib/agent-loop.js';
import { postPrComment } from '../lib/github-pr.js';

async function runPreflight(config, { dryRun } = {}) {
  print.info('Running preflight checks...');
  const preflightEnv = {};
  if (config.deployment?.preflight?.strict) preflightEnv.SFDT_PREFLIGHT_STRICT = 'true';
  await runScript('ops/preflight.sh', config, {
    cwd: config._projectRoot,
    env: preflightEnv,
    dryRun,
  });
  if (!dryRun) print.success('Preflight passed.');
}

/**
 * Detect whether the target org is production (sandbox === false). Fails safe to
 * production (so tests are never skipped) when detection is not possible.
 */
async function detectIsProd(org, config, options) {
  if (options.prod) return true;
  if (config.deployment?.smart?.assumeProd) return true;
  try {
    const { stdout } = await execa('sf', ['org', 'display', '--target-org', org, '--json']);
    const isSandbox = JSON.parse(stdout)?.result?.isSandbox;
    return isSandbox === false;
  } catch {
    return true;
  }
}

async function runSmartDeploy(config, options) {
  const projectRoot = config._projectRoot;
  const org = options.org || config.defaultOrg;
  if (!org) {
    throw new Error('No org specified — pass --org <alias> or set defaultOrg in .sfdt/config.json');
  }

  if (!options.skipPreflight) {
    try {
      await runPreflight(config, { dryRun: options.dryRun });
    } catch (prefErr) {
      print.error(`Preflight failed — aborting deploy: ${prefErr.message}`);
      process.exitCode = resolveExitCode(prefErr);
      return;
    }
  }

  const isProd = await detectIsProd(org, config, options);
  const base = options.deltaBase || config.deployment?.smart?.deltaBase || 'main';
  const head = options.deltaHead || 'HEAD';

  print.header(`Smart deploy (${base}...${head}) → ${org}${isProd ? ' [PRODUCTION]' : ''}${options.dryRun ? ' [validate]' : ''}`);

  const prep = await prepareSmartDeploy({
    base,
    head,
    projectRoot,
    config,
    isProd,
    noOverwriteManifest: options.overwriteManifest,
  });

  try {
    if (prep.addCount === 0 && prep.delCount === 0) {
      print.warning('No metadata changes detected between refs — nothing to deploy.');
      return;
    }

    print.info(`Delta: ${prep.addCount} additive, ${prep.delCount} destructive component(s).`);
    if (prep.removed.length) print.info(`Overwrite-protected (skipped): ${prep.removed.length} component(s).`);
    print.info(`Test level: ${prep.testLevel}${prep.tests.length ? ` (${prep.tests.join(', ')})` : ''} — ${prep.testReason}`);
    if (prep.unknown.length) print.warning(`${prep.unknown.length} changed file(s) could not be mapped to a metadata type (skipped).`);

    // Optional AI dependency cleanup (reuses the manifest-dependency prompt).
    if (options.aiDeps && config.features?.ai && (await isAiAvailable(config))) {
      print.header('AI Dependency Cleanup');
      const manifestXml = await fs.readFile(prep.manifestPath, 'utf-8');
      const manifestPrompt = await getPrompt('manifest-dependency', config._configDir);
      await runAiPrompt(manifestPrompt + manifestXml, {
        config,
        allowedTools: ['Read', 'Grep', 'Glob'],
        cwd: projectRoot,
        aiEnabled: true,
        interactive: !options.agent,
      });
    }

    const buildCmd = (sub) => {
      const c = ['project', 'deploy', sub, '--manifest', prep.manifestPath, '--target-org', org, '--test-level', prep.testLevel];
      for (const t of prep.tests) c.push('--tests', t);
      if (prep.destructivePath) c.push('--post-destructive-changes', prep.destructivePath);
      return c;
    };

    const sub = options.dryRun ? 'validate' : 'start';
    const cmd = buildCmd(sub);
    // Capture output (instead of inheriting stdio) when --ai-fix is set, so the
    // failure text can be fed to the analysis/auto-fix path; still echo it.
    const useCapture = !!options.aiFix;

    print.info(`Running: sf ${cmd.join(' ')}`);
    let deployOk = false;
    try {
      const res = await execa('sf', cmd, useCapture ? { all: true } : { stdio: 'inherit' });
      if (useCapture && res.all) console.log(res.all);
      deployOk = true;
      print.success(options.dryRun ? 'Validation succeeded — no changes applied.' : 'Smart deploy completed successfully.');
    } catch (deployErr) {
      if (useCapture && deployErr.all) console.log(deployErr.all);
      print.error('Smart deploy failed.');
      if (options.aiFix) {
        const failureOutput = deployErr.all || deployErr.stderr || deployErr.stdout || deployErr.message;
        // Try the bounded write-capable auto-fix loop first (off unless
        // ai.agent.enabled + allowWrite + an agentic provider). It re-validates
        // via dry-run each turn and never deploys.
        const validate = async () => {
          try {
            const r = await execa('sf', buildCmd('validate'), { all: true });
            return { ok: true, output: r.all };
          } catch (e) {
            return { ok: false, output: e.all || e.stderr || e.message };
          }
        };
        const loop = await runFixLoop({
          failureOutput,
          config,
          projectRoot,
          org,
          validate,
          maxTurns: options.maxTurns ? Number(options.maxTurns) : undefined,
        });
        if (!loop.ran) {
          // Auto-fix not eligible — fall back to a read-only explanation.
          await explainDeployFailure(config, deployErr, { projectRoot, org, agent: options.agent });
        } else if (loop.fixed) {
          print.success(`AI agent resolved the errors in ${loop.turns.length} turn(s); validation now passes. Review the changes, then re-run the deploy.`);
        } else {
          print.warning(`AI agent could not fix the errors within ${loop.turns.length} turn(s) — review the changes it made.`);
        }
      }
      process.exitCode = resolveExitCode(deployErr);
    }

    // Optional PR decoration: post the delta + outcome to the current PR.
    if (options.prComment) {
      const verb = options.dryRun ? 'Validation' : 'Deploy';
      const status = deployOk ? '✅ passed' : '❌ failed';
      const body = [
        `### SFDT Smart ${verb} — ${status}`,
        '',
        `- **Org:** ${org}`,
        `- **Delta:** ${prep.addCount} additive, ${prep.delCount} destructive`,
        `- **Test level:** ${prep.testLevel}${prep.tests.length ? ` (${prep.tests.join(', ')})` : ''}`,
        prep.removed.length ? `- **Overwrite-protected:** ${prep.removed.length} skipped` : '',
      ].filter(Boolean).join('\n');
      const res = await postPrComment(body, { cwd: projectRoot });
      if (res.ok) print.info('Posted deploy result to PR.');
      else print.warning(`Could not post PR comment: ${res.error}`);
    }
  } finally {
    // Clean up the temp manifest dir.
    if (prep.tmpDir) await fs.remove(prep.tmpDir).catch(() => {});
  }
}

/**
 * Run the editable deploy-error prompt over a failed deploy's output to explain
 * the failure and suggest fixes. Read-only tools; pre-gathers nothing extra
 * beyond the captured output (the agentic CLI providers can read the repo).
 * Placeholder-safe when AI is unavailable.
 */
async function explainDeployFailure(config, deployErr, { projectRoot, org, agent } = {}) {
  if (!config.features?.ai || !(await isAiAvailable(config))) {
    print.info('AI features unavailable — skipping deploy-error explanation.');
    return;
  }
  const output = [deployErr.stdout, deployErr.stderr, deployErr.shortMessage, deployErr.message]
    .filter(Boolean)
    .join('\n')
    .slice(0, 12000);
  const prompt = await getPrompt('deploy-error', config._configDir);
  print.header('AI Deploy-Error Analysis');
  await runAiPrompt(`${prompt}\n\nTARGET ORG: ${org}\n\nDEPLOYMENT OUTPUT:\n${output}`, {
    config,
    allowedTools: ['Read', 'Grep', 'Glob'],
    cwd: projectRoot,
    aiEnabled: true,
    interactive: !agent,
  });
}

export function registerDeployCommand(program) {
  program
    .command('deploy')
    .description('Deploy to a Salesforce org (interactive manifest flow, or --smart delta deploy)')
    .option('--managed', 'Use deploy-manager.sh instead of deployment-assistant.sh')
    .option('--skip-preflight', 'Skip pre-deployment preflight checks')
    .option('--dry-run', 'Show what would be executed (smart mode: validate-only)')
    .option('--org <alias>', 'Target org alias for deployment')
    .option('--source-dir <path>', 'Deploy a source directory instead of a manifest (relative to project root)')
    .option('--smart', 'Smart delta deploy: only changed metadata, with smart test selection')
    .option('--delta-base <ref>', 'Base git ref for the smart delta (default: config or "main")')
    .option('--delta-head <ref>', 'Head git ref for the smart delta', 'HEAD')
    .option('--overwrite-manifest <path>', 'Path to package-no-overwrite.xml (overrides config)')
    .option('--prod', 'Treat the target org as production (never downgrade tests)')
    .option('--ai-deps', 'Run AI dependency cleanup on the computed delta before deploying')
    .option('--ai-fix', 'On failure, run AI deploy-error analysis, or the bounded auto-fix loop when ai.agent is enabled (CLI providers only)')
    .option('--max-turns <n>', 'Max auto-fix iterations (overrides ai.agent.maxTurns)')
    .option('--pr-comment', 'Post the smart-deploy delta + outcome to the current PR (via gh)')
    .option('--agent', 'Non-interactive agent mode (no AI prompts block on input)')
    .action(async (options) => {
      try {
        const config = await loadConfig();
        const projectRoot = config._projectRoot;
        const orgAlias = options.org || config.defaultOrg;

        if (options.smart) {
          await runSmartDeploy(config, options);
          return;
        }

        if (!options.skipPreflight) {
          try {
            await runPreflight(config, { dryRun: options.dryRun });
          } catch (prefErr) {
            print.error(`Preflight failed — aborting deploy: ${prefErr.message}`);
            process.exitCode = resolveExitCode(prefErr);
            return;
          }
        }

        const scriptPath = options.managed ? 'core/deploy-manager.sh' : 'core/deployment-assistant.sh';

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

// Exported for reuse/testing.
export { runSmartDeploy, explainDeployFailure };
