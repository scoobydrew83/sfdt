import fs from 'fs-extra';
import path from 'path';
import { glob } from 'glob';
import { loadConfig } from '../lib/config.js';
import { isAiAvailable, aiUnavailableMessage, runAiPrompt } from '../lib/ai.js';
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

const MAX_LOG_SIZE_BYTES = 512 * 1024; // 512 KB cap sent to the model
const MAX_HEURISTIC_ERRORS = 20;

const EXPLAIN_PROMPT = `You are a Salesforce deployment engineer helping a developer interpret a failing deployment log. Analyze the log and produce a concise report with these sections:

## Root Cause
One or two sentences identifying the single most likely cause of the failure.

## Failing Components
Bulleted list of component names + the specific error. Keep each bullet to one line.

## Suggested Fixes
Ordered list of concrete steps the developer can take. Prefer specific commands, file paths, or config changes over generic advice. Call out anything that requires an admin (e.g., permission set edits) separately.

## References
Link or reference (name only, no fabricated URLs) any Salesforce docs or metadata types that are relevant.

Rules:
- Do not invent error codes or component names that are not in the log.
- If the log is truncated or ambiguous, say so in Root Cause.
- Use the allowed tools to inspect the repo when a fix requires looking at actual metadata.

--- DEPLOYMENT LOG ---
`;

/**
 * Pattern-based fallback when AI is unavailable. Picks up the most common
 * Salesforce deployment error prefixes and prints a short summary.
 */
const HEURISTIC_PATTERNS = [
  {
    pattern: /No such column '([^']+)' on entity '([^']+)'/g,
    hint: (m) => `Missing field ${m[1]} on ${m[2]} — add the field to your manifest or create it.`,
  },
  {
    pattern: /Variable does not exist: (\w+)/g,
    hint: (m) => `Apex is referencing an unknown symbol "${m[1]}" — check imports and name.`,
  },
  {
    pattern: /Invalid type: (\w+)/g,
    hint: (m) => `Apex type "${m[1]}" is not defined in the target org.`,
  },
  {
    pattern: /Average test coverage across all Apex Classes and Triggers is (\d+)%/g,
    hint: (m) => `Overall coverage is ${m[1]}% — below the 75% org requirement.`,
  },
  {
    pattern: /Your organization must have at least \d+ percent code coverage/g,
    hint: () => 'Add tests or exclude low-coverage classes from this deployment.',
  },
  {
    pattern: /insufficient access rights on cross-reference id/gi,
    hint: () => 'A referenced record or metadata row is not visible to the deploying user.',
  },
  {
    pattern: /duplicate value found/gi,
    hint: () => 'A unique constraint (DeveloperName or external ID) collided — rename the component.',
  },
  {
    pattern: /Entity is not org-accessible/gi,
    hint: () => 'A referenced object/permission is not enabled in the target org.',
  },
];

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
        if (logContent === null) return; // message already printed

        const trimmed = truncateLog(logContent);

        if (trimmed.truncated) {
          print.warning(
            `Log is larger than ${Math.floor(MAX_LOG_SIZE_BYTES / 1024)} KB — only the tail will be analyzed.`,
          );
        }

        print.info(`Analyzing ${trimmed.content.split('\n').length} lines of log output...`);

        // Always print the heuristic summary first — it is fast and works offline.
        printHeuristicSummary(trimmed.content);

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

        await runAiPrompt(
          (contextBlock ? contextBlock + '\n\n' : '') + EXPLAIN_PROMPT + trimmed.content,
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

/**
 * Resolve log content from one of: explicit file arg, stdin, or the most
 * recent log in the project log directory.
 * Returns null (after printing an appropriate message) if nothing was found.
 */
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

  // Default: find the latest log
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

  // Pick most recently modified
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
  // Keep the tail — error details are usually at the bottom
  return { content: content.slice(-MAX_LOG_SIZE_BYTES), truncated: true };
}

function printHeuristicSummary(content) {
  const findings = [];
  for (const { pattern, hint } of HEURISTIC_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      findings.push(hint(match));
      if (findings.length >= MAX_HEURISTIC_ERRORS) break;
    }
    if (findings.length >= MAX_HEURISTIC_ERRORS) break;
  }

  if (findings.length === 0) {
    print.info('No known error patterns matched heuristically — AI analysis recommended.');
    return;
  }

  print.header('Heuristic Summary');
  const deduped = [...new Set(findings)];
  for (const hint of deduped) {
    print.step(`• ${hint}`);
  }
  console.log('');
}
