import inquirer from 'inquirer';
import { loadConfig } from '../lib/config.js';
import { runScript } from '../lib/script-runner.js';
import { isClaudeAvailable, runAiPrompt } from '../lib/ai.js';
import { print } from '../lib/output.js';

export function registerTestCommand(program) {
  program
    .command('test')
    .description('Run Apex tests with the enhanced test runner')
    .option('--legacy', 'Use run-tests.sh instead of enhanced-test-runner.sh')
    .option('--analyze', 'Run test-analyzer after tests complete')
    .action(async (options) => {
      try {
        const config = await loadConfig();
        const projectRoot = config._projectRoot;

        const scriptPath = options.legacy
          ? 'core/run-tests.sh'
          : 'core/enhanced-test-runner.sh';

        print.header(`Running Tests${options.legacy ? ' (legacy)' : ''}`);

        let testFailed = false;
        try {
          await runScript(scriptPath, config, {
            cwd: projectRoot,
          });
          print.success('All tests passed.');
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
            });
          } catch (analyzeErr) {
            print.warning(`Test analyzer encountered issues: ${analyzeErr.message}`);
          }
        }

        // Offer AI analysis on failure
        if (testFailed) {
          const aiEnabled = config.features?.ai;
          if (aiEnabled && await isClaudeAvailable()) {
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

              const prompt = [
                'Analyze the most recent Apex test failures in this Salesforce DX project.',
                'Look at test result output, identify the root cause of failures, and suggest fixes.',
                'Check for common issues: missing test data, SOQL governor limits, null pointer exceptions, and assertion failures.',
                'Provide specific code-level recommendations.',
              ].join('\n');

              await runAiPrompt(prompt, {
                allowedTools: ['Read', 'Grep', 'Bash(sf apex test:*)'],
                cwd: projectRoot,
                aiEnabled: true,
                interactive: true,
              });
            }
          }

          process.exitCode = 1;
        }
      } catch (err) {
        print.error(`Test command failed: ${err.message}`);
        process.exitCode = 1;
      }
    });
}
