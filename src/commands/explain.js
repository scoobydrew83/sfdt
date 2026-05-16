import fs from 'fs-extra';
import path from 'path';
import { glob } from 'glob';
import { loadConfig } from '../lib/config.js';
import { isAiAvailable, aiUnavailableMessage, runAiPrompt } from '../lib/ai.js';
import { getPrompt } from '../lib/prompts.js';
import { print } from '../lib/output.js';
import { resolveExitCode } from '../lib/exit-codes.js';
import { safeResolvePath } from '../lib/project-detect.js';
import {
  buildProjectContext,
  readLatestTestRuns,
  readLatestPreflight,
  readDeployHistory,
  buildContextBlock,
  formatTestRunsSection,
  formatPreflightSection,
  formatDeployHistorySection,
} from '../lib/ai-context.js';
import { runHeuristicAnalysis, NO_MATCH_MESSAGE } from '../lib/explain-heuristics.js';
const MAX_LOG_SIZE_BYTES = 512 * 1024;
export function registerExplainCommand(program) {
  program
    .command('explain [file]')
    .description('AI-powered analysis of a Salesforce deployment error log')
    .option('--from-stdin', 'Read the deployment log from stdin')
    .option('--latest', 'Use the most recent log in the configured log directory (default)')
    .action(async (file, options) => {
      try {
        const config = await loadConfig();
        const projectRoot = config._projectRoot;
        const logContent = await resolveLogContent(file, options, config);
        if (logContent === null) return;
        const trimmed = truncateLog(logContent);
        if (trimmed.truncated) {
          print.warning(
            `Log is larger than ${Math.floor(MAX_LOG_SIZE_BYTES / 1024)} KB — only the tail will be analyzed.`,
          );
        }
        print.info(`Analyzing ${trimmed.content.split('\n').length} lines of log output...`);
        const { found, findings } = runHeuristicAnalysis(trimmed.content);
        if (found) {
          print.header('Heuristic Summary');
          for (const h of findings) print.step(`• ${h}`);
          console.log('');
        } else {
          print.info(NO_MATCH_MESSAGE);
        }
        const aiEnabled = config.features?.ai;
        if (!aiEnabled) {
          print.info(
            'AI features are disabled (features.ai=false). Heuristic analysis only. Enable AI in .sfdt/config.json for deeper insight.',
          );
          return;
        }
        if (!(await isAiAvailable(config))) {
          print.info(`${aiUnavailableMessage(config)} — heuristic analysis only.`);
          return;
        }
        print.header('AI Error Analysis');
        const [projectCtx, testRuns, preflight, deployHistory] = await Promise.all([
          buildProjectContext(config),
          readLatestTestRuns(config, 1),
          readLatestPreflight(config),
          readDeployHistory(config, 3),
        ]);
        const contextBlock = buildContextBlock([
          projectCtx,
          formatDeployHistorySection(deployHistory),
          formatPreflightSection(preflight),
          formatTestRunsSection(testRuns),
        ]);
        const explainPrompt = await getPrompt('explain', config._configDir);
        await runAiPrompt(
          (contextBlock ? contextBlock + '\n\n' : '') + explainPrompt + trimmed.content,
          {
            config,
            allowedTools: ['Read', 'Grep', 'Glob'],
            cwd: projectRoot,
            aiEnabled: true,
            interactive: true,
          },
        );
      } catch (err) {
        print.error(`Explain failed: ${err.message}`);
        process.exitCode = resolveExitCode(err);
      }
    });
}
async function resolveLogContent(file, options, config) {
  if (file) {
    const projectRoot = config._projectRoot;
    let absolute;
    try {
      absolute = safeResolvePath(projectRoot, file);
    } catch (err) {
      print.error(err.message);
      process.exitCode = 1;
      return null;
    }
    if (!(await fs.pathExists(absolute))) {
      print.error(`Log file not found: ${file}`);
      process.exitCode = 1;
      return null;
    }
    return fs.readFile(absolute, 'utf8');
  }
  if (options.fromStdin) {
    return readStdin();
  }
  const logDir = config.logDir
    ? path.isAbsolute(config.logDir)
      ? config.logDir
      : path.join(config._projectRoot, config.logDir)
    : path.join(config._projectRoot, 'logs');
  if (!(await fs.pathExists(logDir))) {
    print.warning(`No log directory found at ${path.relative(config._projectRoot, logDir)}.`);
    print.info('Usage: sfdt explain <log-file>  |  sfdt explain --from-stdin  |  sf ... | sfdt explain --from-stdin');
    process.exitCode = 1;
    return null;
  }
  const candidates = await glob('**/*.{log,txt}', { cwd: logDir, absolute: true });
  if (candidates.length === 0) {
    print.warning(`No log files found in ${path.relative(config._projectRoot, logDir)}.`);
    process.exitCode = 1;
    return null;
  }
  const statted = await Promise.all(
    candidates.map(async (p) => ({ path: p, mtime: (await fs.stat(p)).mtimeMs })),
  );
  statted.sort((a, b) => b.mtime - a.mtime);
  const latest = statted[0].path;
  print.info(`Analyzing latest log: ${path.relative(config._projectRoot, latest)}`);
  return fs.readFile(latest, 'utf8');
}
function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}
function truncateLog(content) {
  if (content.length <= MAX_LOG_SIZE_BYTES) {
    return { content, truncated: false };
  }
  return { content: content.slice(-MAX_LOG_SIZE_BYTES), truncated: true };
}
