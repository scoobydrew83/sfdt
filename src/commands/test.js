import inquirer from 'inquirer';
import { execa } from 'execa';
import { loadConfig } from '../lib/config.js';
import { runScript } from '../lib/script-runner.js';
import { isAiAvailable, runAiPrompt, providerSupportsAgenticTools } from '../lib/ai.js';
import { gatherLatestTestResults, frameProvidedContext } from '../lib/ai-context.js';
import { getPrompt } from '../lib/prompts.js';
import { print } from '../lib/output.js';
import { ExitCode, resolveExitCode } from '../lib/exit-codes.js';
import { buildLogicTestArgs } from '../lib/logic-test.js';

/**
 * Run the Spring '26 unified test runner (`sf logic run test`) — Apex classes
 * and Flow tests in one pass. Thin wrapper over the CLI; the arg building lives
 * in `src/lib/logic-test.js`. Requires the org "View All Data" permission.
 */
async function runLogicTests(config, options) {
  const org = options.org || config.defaultOrg;
  const args = buildLogicTestArgs(options, org); // throws on missing org / bad flags
  print.header(`Unified logic tests (Apex + Flow) → ${org}${options.dryRun ? ' [dry-run]' : ''}`);
  if (options.dryRun) {
    print.info(`Would run: sf ${args.join(' ')}`);
    return;
  }
  try {
    await execa('sf', args, { stdio: 'inherit' });
    print.success('All logic tests passed.');
  } catch (err) {
    print.error('Logic tests failed.');
    print.info('Note: `sf logic run test` is Beta and requires the "View All Data" org permission.');
    process.exitCode = resolveExitCode(err);
  }
}

export function registerTestCommand(program) {
  program
    .command('test')
    .description('Run Apex tests with the enhanced test runner (or --logic for unified Apex + Flow tests)')
    .option('--legacy', 'Use run-tests.sh instead of enhanced-test-runner.sh')
    .option('--analyze', 'Run test-analyzer after tests complete')
    .option('--dry-run', 'Show what would be executed without running')
    .option('--logic', 'Run Apex + Flow tests together via `sf logic run test` (Spring \'26 beta; needs "View All Data")')
    .option('--org <alias>', 'Target org for --logic (default: config.defaultOrg)')
    .option('--test-level <level>', 'For --logic: RunLocalTests | RunAllTestsInOrg | RunSpecifiedTests')
    .option('--tests <list>', 'For --logic: comma-separated test names (Apex classes and FlowTesting.<name>)')
    .option('--category <cat>', 'For --logic: restrict to Apex or Flow')
    .option('--code-coverage', 'For --logic: retrieve code coverage results')
    .option('--wait <minutes>', 'For --logic: streaming wait timeout in minutes (default: 30)')
    .action(async (options) => {
      try {
        const config = await loadConfig();
        const projectRoot = config._projectRoot;

        if (options.logic) {
          await runLogicTests(config, options);
          return;
        }

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

              const analysis = await runAiPrompt(prompt, {
                config,
                allowedTools: ['Read', 'Grep', 'Bash(sf apex test:*)'],
                cwd: projectRoot,
                aiEnabled: true,
                interactive: !httpMode,
              });

              // CLI providers stream their analysis interactively; the http
              // provider returns it on stdout, so print it (or surface an error).
              if (httpMode) {
                if (analysis?.exitCode !== 0) {
                  print.error(analysis?.stderr?.trim() || 'AI analysis failed.');
                } else if (analysis?.stdout?.trim()) {
                  console.log(`\n${analysis.stdout.trim()}\n`);
                }
              }
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
