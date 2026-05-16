import { execa } from 'execa';
import { loadConfig } from '../lib/config.js';
import { isAiAvailable, aiUnavailableMessage, runAiPrompt } from '../lib/ai.js';
import { getPrompt } from '../lib/prompts.js';
import { print } from '../lib/output.js';
import { resolveExitCode } from '../lib/exit-codes.js';
import { parseDiffToMetadata } from '../lib/metadata-mapper.js';
import {
  buildProjectContext,
  readLatestTestRuns,
  readLatestPreflight,
  buildContextBlock,
  formatTestRunsSection,
  formatPreflightSection,
  formatMetadataTypesSection,
} from '../lib/ai-context.js';
export function registerReviewCommand(program) {
  program
    .command('review')
    .description('AI-powered Salesforce code review of current branch changes')
    .option('--base <branch>', 'Base branch to diff against', 'main')
    .action(async (options) => {
      try {
        const config = await loadConfig();
        const projectRoot = config._projectRoot;
        const aiEnabled = config.features?.ai;
        if (!aiEnabled) {
          print.error(
            'AI features are disabled. Enable them in .sfdt/config.json (features.ai: true).',
          );
          process.exitCode = 1;
          return;
        }
        if (!(await isAiAvailable(config))) {
          print.error(aiUnavailableMessage(config));
          process.exitCode = 1;
          return;
        }
        print.header(`Code Review (vs ${options.base})`);
        const diffResult = await execa('git', ['diff', `${options.base}...HEAD`], {
          cwd: projectRoot,
          reject: false,
        });
        const diff = diffResult.stdout || '';
        if (!diff.trim()) {
          print.warning(`No changes found between ${options.base} and HEAD.`);
          print.info('Make sure you have commits on your branch that differ from the base.');
          return;
        }
        print.info(`Reviewing ${diff.split('\n').length} lines of diff...`);
        const [nameStatusResult, projectCtx, testRuns, preflight] = await Promise.all([
          execa('git', ['diff', '--name-status', `${options.base}...HEAD`], {
            cwd: projectRoot,
            reject: false,
          }),
          buildProjectContext(config),
          readLatestTestRuns(config, 3),
          readLatestPreflight(config),
        ]);
        const metadataTypes = formatMetadataTypesSection(
          parseDiffToMetadata(nameStatusResult.stdout || '', {
            sourcePath: config.defaultSourcePath,
          }),
        );
        const contextBlock = buildContextBlock([
          projectCtx,
          metadataTypes,
          formatTestRunsSection(testRuns),
          formatPreflightSection(preflight),
        ]);
        const reviewPrompt = await getPrompt('review', config._configDir);
        const prompt = (contextBlock ? contextBlock + '\n\n' : '') + reviewPrompt + diff;
        await runAiPrompt(prompt, {
          config,
          allowedTools: ['Read', 'Grep'],
          cwd: projectRoot,
          aiEnabled: true,
          interactive: true,
        });
      } catch (err) {
        print.error(`Review failed: ${err.message}`);
        process.exitCode = resolveExitCode(err);
      }
    });
}
