import { loadConfig } from '../lib/config.js';
import { runScript } from '../lib/script-runner.js';
import { isClaudeAvailable, runAiPrompt } from '../lib/ai.js';
import { print } from '../lib/output.js';

export function registerQualityCommand(program) {
  program
    .command('quality')
    .description('Run code quality analysis and optionally generate an AI fix plan')
    .option('--tests', 'Run test-analyzer only')
    .option('--all', 'Run both code-analyzer and test-analyzer')
    .option('--fix-plan', 'Generate an AI-powered fix plan from quality output')
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
            print.success(`${label} completed.`);
            return output;
          } catch (err) {
            const output = err.stdout || err.message;
            qualityOutput += `\n--- ${label} ---\n${output}\n`;
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
          if (aiEnabled && await isClaudeAvailable()) {
            print.info('Generating AI fix plan...');

            const prompt = [
              'Analyze the following Salesforce code quality report and create a prioritized fix plan.',
              'Group issues by severity (critical, high, medium, low).',
              'For each issue, provide: file location, what to fix, and a concrete code suggestion.',
              'Focus on Salesforce-specific concerns: governor limits, CRUD/FLS, bulk patterns, and test coverage.',
              '',
              '--- Quality Report ---',
              qualityOutput,
            ].join('\n');

            await runAiPrompt(prompt, {
              allowedTools: ['Read', 'Grep'],
              cwd: projectRoot,
              aiEnabled: true,
              interactive: true,
            });
          } else {
            print.warning('AI features are not available. Skipping fix plan generation.');
          }
        }
      } catch (err) {
        print.error(`Quality analysis failed: ${err.message}`);
        process.exitCode = 1;
      }
    });
}
