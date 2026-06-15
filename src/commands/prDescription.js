import fs from 'fs-extra';
import path from 'path';
import { execa } from 'execa';
import { loadConfig } from '../lib/config.js';
import { isAiAvailable, aiUnavailableMessage, runAiPrompt } from '../lib/ai.js';
import { getPrompt } from '../lib/prompts.js';
import { print } from '../lib/output.js';
import { resolveExitCode } from '../lib/exit-codes.js';
import { safeResolvePath } from '../lib/project-detect.js';
import { isSafeGitRef, resolveBaseRef, diffNameStatus } from '../lib/git-utils.js';
import { parseDiffToMetadata, countMembers } from '../lib/metadata-mapper.js';

const VALID_FORMATS = ['github', 'slack', 'markdown'];


export function registerPrDescriptionCommand(program) {
  program
    .command('pr-description')
    .alias('pr-desc')
    .description('Generate a PR description or Slack message from deployment changes')
    .option('--base <ref>', 'Base branch to diff against', 'main')
    .option('--head <ref>', 'Head ref', 'HEAD')
    .option('--format <fmt>', `Output format: ${VALID_FORMATS.join('|')}`, 'github')
    .option('--output <path>', 'Write result to this file instead of stdout')
    .option('--commit-limit <n>', 'Max commits to include in the context sent to AI', '30')
    .action(async (options) => {
      try {
        if (!VALID_FORMATS.includes(options.format)) {
          print.error(
            `Unknown format "${options.format}". Valid: ${VALID_FORMATS.join(', ')}`,
          );
          process.exitCode = 1;
          return;
        }

        if (!isSafeGitRef(options.base) || !isSafeGitRef(options.head)) {
          print.error('Invalid git ref — refs must not start with "-" or contain shell metacharacters');
          process.exitCode = 1;
          return;
        }

        const config = await loadConfig();
        const projectRoot = config._projectRoot;
        const sourcePath = config.defaultSourcePath || 'force-app/main/default';
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

        print.header(`PR Description (${options.base}...${options.head}, ${options.format})`);

        const context = await collectDiffContext(projectRoot, sourcePath, options);

        if (!context.hasChanges) {
          print.warning(`No commits or metadata changes between ${options.base} and ${options.head}.`);
          return;
        }

        const promptKey = options.format === 'slack' ? 'pr-slack' : 'pr-github';
        const basePrompt = await getPrompt(promptKey, config._configDir);
        const prompt = buildPrompt(basePrompt, context);

        const response = await runAiPrompt(prompt, {
          config,
          allowedTools: ['Read', 'Grep'],
          cwd: projectRoot,
          aiEnabled: true,
          interactive: false,
        });

        if (!response || response.exitCode !== 0) {
          print.error('AI call failed or returned no output.');
          process.exitCode = 1;
          return;
        }

        const output = (response.stdout || '').trim();
        if (!output) {
          print.error('AI returned empty output.');
          process.exitCode = 1;
          return;
        }

        if (options.output) {
          const absolute = safeResolvePath(projectRoot, options.output);
          await fs.ensureDir(path.dirname(absolute));
          await fs.writeFile(absolute, output + '\n');
          print.success(`Wrote ${options.format} description → ${path.relative(projectRoot, absolute)}`);
        } else {
          console.log('');
          console.log(output);
          console.log('');
        }
      } catch (err) {
        print.error(`PR description generation failed: ${err.message}`);
        process.exitCode = resolveExitCode(err);
      }
    });
}

/**
 * Gather the raw inputs the AI will summarize: commit messages, file list,
 * and a structured metadata component breakdown.
 */
async function collectDiffContext(cwd, sourcePath, options) {
  const execOpts = { cwd, reject: false };

  // Scope the diff to the merge-base so commits already on the base branch are
  // excluded (matches manifest.js). Without this, a feature branch that has
  // diverged from base would surface metadata changes that predate the branch.
  const baseRef = await resolveBaseRef(options.base, options.head, cwd);

  // Commit log
  const commitLimit = Math.max(1, parseInt(options.commitLimit, 10) || 30);
  const log = await execa(
    'git',
    ['log', '--pretty=format:%h %s', `-n`, String(commitLimit), `${baseRef}..${options.head}`],
    execOpts,
  );

  // Name-status diff scoped to the source root (force-app/, etc.)
  const diff = await diffNameStatus(
    baseRef,
    options.head,
    [`${sourcePath.split('/')[0]}/`],
    cwd,
  );

  const commits = (log.stdout || '').split('\n').filter(Boolean);
  const metadata = parseDiffToMetadata(diff.stdout || '', { sourcePath });

  const addCount = countMembers(metadata.additive);
  const delCount = countMembers(metadata.destructive);
  const hasChanges = commits.length > 0 || addCount > 0 || delCount > 0;

  return { commits, metadata, addCount, delCount, hasChanges };
}

function buildPrompt(basePrompt, context) {
  const componentSection = formatMetadataForPrompt(context.metadata);
  const commitSection = context.commits.length
    ? context.commits.map((c) => `- ${c}`).join('\n')
    : '(no commits — working tree diff only)';

  return `${basePrompt}
--- COMMIT LOG (most recent first) ---
${commitSection}

--- METADATA CHANGES (${context.addCount} additive, ${context.delCount} destructive) ---
${componentSection}
`;
}

function formatMetadataForPrompt(metadata) {
  const lines = [];

  if (Object.keys(metadata.additive).length > 0) {
    lines.push('Additive:');
    for (const [type, members] of Object.entries(metadata.additive)) {
      const preview = members.slice(0, 10).join(', ');
      const suffix = members.length > 10 ? `, ...${members.length - 10} more` : '';
      lines.push(`  - ${type} (${members.length}): ${preview}${suffix}`);
    }
  }

  if (Object.keys(metadata.destructive).length > 0) {
    lines.push('Destructive:');
    for (const [type, members] of Object.entries(metadata.destructive)) {
      const preview = members.slice(0, 10).join(', ');
      const suffix = members.length > 10 ? `, ...${members.length - 10} more` : '';
      lines.push(`  - ${type} (${members.length}): ${preview}${suffix}`);
    }
  }

  if (lines.length === 0) {
    return '(no metadata changes detected in source directory)';
  }
  return lines.join('\n');
}
