import { loadConfig } from '../lib/config.js';
import { runScript } from '../lib/script-runner.js';
import { isAiAvailable, runAiPrompt } from '../lib/ai.js';
import { getPrompt } from '../lib/prompts.js';
import { print } from '../lib/output.js';
import { resolveExitCode } from '../lib/exit-codes.js';
import {
  buildProjectContext,
  readLatestTestRuns,
  readLatestPreflight,
  buildContextBlock,
  formatTestRunsSection,
  formatPreflightSection,
} from '../lib/ai-context.js';

/**
 * Scan analyzer stdout for the "scan skipped" JSON marker emitted by
 * scripts/quality/code-analyzer.sh when the Salesforce Code Analyzer
 * (sf scanner) is not installed or its run failed. Returns the reason
 * string when found, or null when the output represents a real scan.
 */
export function detectSkippedScan(output) {
  for (const line of String(output || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && (parsed.status === 'skipped' || parsed._sfdt_unavailable)) {
        return parsed.reason || parsed._sfdt_unavailable || 'static scan skipped';
      }
    } catch {
      // Not a JSON line — keep scanning.
    }
  }
  return null;
}

export function registerQualityCommand(program) {
  program
    .command('quality')
    .description('Run code quality analysis and optionally generate an AI fix plan')
    .option('--tests', 'Run test-analyzer only')
    .option('--all', 'Run both code-analyzer and test-analyzer')
    .option('--fix-plan', 'Generate an AI-powered fix plan from quality output')
    .option('--generate-stubs', 'Generate @IsTest stub classes for untested Apex classes')
    .option('--dry-run', 'Preview --generate-stubs output without writing files')
    .option('--agent', 'Non-interactive agent mode (do not block waiting on the AI fix-plan session)')
    .action(async (options) => {
      try {
        const config = await loadConfig();
        const projectRoot = config._projectRoot;

        print.header('Quality Analysis');

        let qualityOutput = '';

        const runAnalyzer = async (scriptPath, label) => {
          print.info(`Running ${label}...`);
          try {
            const result = await runScript(scriptPath, config, {
              cwd: projectRoot,
              interactive: false,
            });
            const output = result.stdout || '';
            qualityOutput += `\n--- ${label} ---\n${output}\n`;
            const skippedReason = detectSkippedScan(output);
            if (skippedReason) {
              print.warning(`${label}: static violation scan was SKIPPED — ${skippedReason}.`);
              print.warning('No scan was performed; this is NOT a clean result. Install the scanner with: sf plugins install @salesforce/sfdx-scanner');
              print.success(`${label} completed (scan skipped).`);
            } else {
              print.success(`${label} completed.`);
            }
            return output;
          } catch (err) {
            const output = err.stdout || err.message;
            qualityOutput += `\n--- ${label} ---\n${output}\n`;
            const skippedReason = detectSkippedScan(output);
            if (skippedReason) {
              print.warning(`${label}: static violation scan was SKIPPED — ${skippedReason}. Install the scanner with: sf plugins install @salesforce/sfdx-scanner`);
            }
            print.warning(`${label} found issues: ${err.message}`);
            return output;
          }
        };

        if (options.tests) {
          await runAnalyzer('quality/test-analyzer.sh', 'Test Analyzer');
        } else if (options.all) {
          await runAnalyzer('quality/code-analyzer.sh', 'Code Analyzer');
          await runAnalyzer('quality/test-analyzer.sh', 'Test Analyzer');
        } else {
          await runAnalyzer('quality/code-analyzer.sh', 'Code Analyzer');
        }

        // AI fix plan
        if (options.fixPlan) {
          const aiEnabled = config.features?.ai;
          if (aiEnabled && (await isAiAvailable(config))) {
            print.info('Generating AI fix plan...');

            const [projectCtx, testRuns, preflight] = await Promise.all([
              buildProjectContext(config),
              readLatestTestRuns(config, 5),
              readLatestPreflight(config),
            ]);

            const contextBlock = buildContextBlock([
              projectCtx,
              formatTestRunsSection(testRuns),
              formatPreflightSection(preflight),
            ]);

            const fixPlanPrompt = await getPrompt('quality-fix-plan', config._configDir);
            const prompt = [
              ...(contextBlock ? [contextBlock, ''] : []),
              fixPlanPrompt,
              '',
              '--- Quality Report ---',
              qualityOutput,
            ].join('\n');

            await runAiPrompt(prompt, {
              config,
              allowedTools: ['Read', 'Grep'],
              cwd: projectRoot,
              aiEnabled: true,
              interactive: !options.agent,
            });
          } else {
            print.warning('AI features are not available. Skipping fix plan generation.');
          }
        }
        if (options.generateStubs) {
          print.info('Generating test stubs...');
          const stubEnv = options.dryRun ? { SFDT_DRY_RUN: 'true' } : {};
          try {
            await runScript('quality/generate-test-stubs.sh', config, {
              cwd: projectRoot,
              env: stubEnv,
              interactive: false,
            });
            print.success('Stub generation complete.');
          } catch (err) {
            print.warning(`Stub generation encountered issues: ${err.message}`);
          }
        }
      } catch (err) {
        print.error(`Quality analysis failed: ${err.message}`);
        process.exitCode = resolveExitCode(err);
      }
    });
}
