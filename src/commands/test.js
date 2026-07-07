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
 * On a test failure, offer AI failure analysis (when `features.ai` is on and a
 * provider is available). Shared by the Apex runner and the `--logic` runner.
 *
 * `providedContext` is the captured test output to inject into the prompt. The
 * `--logic` path always passes it (logic results aren't written to the standard
 * `logs/test-results/` dir that an agentic provider would Read); the Apex path
 * leaves it null so agentic providers Read the files themselves, and only http
 * providers get the gathered results injected.
 */
async function offerAiFailureAnalysis(config, projectRoot, { providedContext = null } = {}) {
  if (!config.features?.ai || !(await isAiAvailable(config))) return;
  const { analyzeFailure } = await inquirer.prompt([
    { type: 'confirm', name: 'analyzeFailure', message: 'Tests failed. Analyze failures with AI?', default: true },
  ]);
  if (!analyzeFailure) return;

  print.info('Analyzing test failures...');
  let prompt = await getPrompt('test-failure', config._configDir);
  const httpMode = !providerSupportsAgenticTools(config);
  if (providedContext) {
    prompt += frameProvidedContext('Test results', providedContext);
  } else if (httpMode) {
    const results = await gatherLatestTestResults(config);
    if (results) {
      prompt += frameProvidedContext('Test results', results);
    } else {
      print.warning('HTTP AI provider has no test-result files to analyze; results may be incomplete.');
    }
  }

  const analysis = await runAiPrompt(prompt, {
    config,
    allowedTools: ['Read', 'Grep', 'Bash(sf apex test:*)'],
    cwd: projectRoot,
    aiEnabled: true,
    interactive: !httpMode,
  });

  // CLI providers stream interactively; the http provider returns on stdout.
  if (httpMode) {
    if (analysis?.exitCode !== 0) {
      print.error(analysis?.stderr?.trim() || 'AI analysis failed.');
    } else if (analysis?.stdout?.trim()) {
      console.log(`\n${analysis.stdout.trim()}\n`);
    }
  }
}

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

  // Capture the run output when AI analysis is possible, so a failure can be
  // fed to the AI (logic results aren't written to the standard result dir);
  // otherwise stream straight to the terminal.
  const canAnalyze = !!config.features?.ai;
  try {
    const res = await execa('sf', args, canAnalyze ? { all: true } : { stdio: 'inherit' });
    if (canAnalyze && res.all) console.log(res.all);
    print.success('All logic tests passed.');
  } catch (err) {
    if (canAnalyze && err.all) console.log(err.all);
    print.error('Logic tests failed.');
    print.info('Note: `sf logic run test` is Beta and requires the "View All Data" org permission.');
    const output = String(err.all || err.stderr || err.stdout || err.message || '').slice(0, 12000);
    await offerAiFailureAnalysis(config, config._projectRoot, { providedContext: output });
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
    .option('--class-names <list>', 'Run only these Apex test classes (comma-separated); overrides the configured test classes for this run')
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

        // `--class-names` runs a specific subset (e.g. from the VS Code "Run this
        // test class" CodeLens). It overrides the config-derived SFDT_TEST_CLASSES
        // for this run only; the runner already batches whatever list it's given.
        const classNames =
          typeof options.classNames === 'string'
            ? options.classNames.split(',').map((s) => s.trim()).filter(Boolean).join(',')
            : '';
        const scriptEnv = classNames ? { SFDT_TEST_CLASSES: classNames } : {};

        print.header(
          `Running Tests${options.legacy ? ' (legacy)' : ''}${classNames ? ` [${classNames}]` : ''}${options.dryRun ? ' [dry-run]' : ''}`,
        );

        let testFailed = false;
        try {
          await runScript(scriptPath, config, {
            cwd: projectRoot,
            dryRun: options.dryRun,
            env: scriptEnv,
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
          await offerAiFailureAnalysis(config, projectRoot);
          process.exitCode = ExitCode.ERROR;
        }
      } catch (err) {
        print.error(`Test command failed: ${err.message}`);
        process.exitCode = resolveExitCode(err);
      }
    });
}
