import inquirer from 'inquirer';
import { loadConfig } from '../lib/config.js';
import { runScript } from '../lib/script-runner.js';
import { isAiAvailable, runAiPrompt, providerSupportsAgenticTools } from '../lib/ai.js';
import { gatherLatestTestResults, frameProvidedContext } from '../lib/ai-context.js';
import { getPrompt } from '../lib/prompts.js';
import { print } from '../lib/output.js';
import { ExitCode, resolveExitCode } from '../lib/exit-codes.js';

export function registerTestCommand(program) {
  program
    .command('test')
    .description('Run Apex tests with the enhanced test runner')
    .option('--legacy', 'Use run-tests.sh instead of enhanced-test-runner.sh')
    .option('--analyze', 'Run test-analyzer after tests complete')
    .option('--dry-run', 'Show what would be executed without running')
    .action(async (options) => {
      try {
        const config = await loadConfig();
        const projectRoot = config._projectRoot;

        const scriptPath = options.legacy ? 'core/run-tests.sh' : 'core/enhanced-test-runner.sh';

        print.header(`Running Tests${options.legacy ? ' (legacy)' : ''}${options.dryRun ? ' [dry-run]' : ''}`);

        let testFailed = false;
        try {
          await runScript(scriptPath, config, {
            cwd: projectRoot,
            dryRun: options.dryRun,
          });
          print.success(options.dryRun ? 'Dry-run complete — no changes made.' : 'All tests passed.');
        } catch (testErr) {
          testFailed = true;
          print.error(`Tests failed: ${testErr.message}`);
        }

        // Run test-analyzer if requested
        if (options.analyze) {
          print.info('Running test analyzer...');
          try {
            await runScript('quality/test-analyzer.sh', config, {
              cwd: projectRoot,
              dryRun: options.dryRun,
            });
          } catch (analyzeErr) {
            print.warning(`Test analyzer encountered issues: ${analyzeErr.message}`);
          }
        }

        // Offer AI analysis on failure (skip in dry-run)
        if (testFailed && !options.dryRun) {
          const aiEnabled = config.features?.ai;
          if (aiEnabled && (await isAiAvailable(config))) {
            const { analyzeFailure } = await inquirer.prompt([
              {
                type: 'confirm',
                name: 'analyzeFailure',
                message: 'Tests failed. Analyze failures with AI?',
                default: true,
              },
            ]);

            if (analyzeFailure) {
              print.info('Analyzing test failures...');

              let prompt = await getPrompt('test-failure', config._configDir);

              // HTTP providers can't Read the result files — inject them.
              const httpMode = !providerSupportsAgenticTools(config);
              if (httpMode) {
                const results = await gatherLatestTestResults(config);
                if (results) {
                  prompt += frameProvidedContext('Test results', results);
                } else {
                  print.warning(
                    'HTTP AI provider has no test-result files to analyze; results may be incomplete.',
                  );
                }
              }

              await runAiPrompt(prompt, {
                config,
                allowedTools: ['Read', 'Grep', 'Bash(sf apex test:*)'],
                cwd: projectRoot,
                aiEnabled: true,
                interactive: !httpMode,
              });
            }
          }

          process.exitCode = ExitCode.ERROR;
        }
      } catch (err) {
        print.error(`Test command failed: ${err.message}`);
        process.exitCode = resolveExitCode(err);
      }
    });
}
