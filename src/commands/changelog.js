import inquirer from 'inquirer';
import fs from 'fs-extra';
import path from 'path';
import { loadConfig } from '../lib/config.js';
import { isAiAvailable, runAiPrompt } from '../lib/ai.js';
import { print } from '../lib/output.js';
import { execa } from 'execa';
import { resolveExitCode } from '../lib/exit-codes.js';

export function registerChangelogCommand(program) {
  const changelog = program.command('changelog').description('Manage project CHANGELOG.md');

  changelog
    .command('generate')
    .description('Use AI to generate [Unreleased] entries from git history')
    .option('--limit <number>', 'Number of commits to analyze', '20')
    .action(async (options) => {
      try {
        const config = await loadConfig();
        const projectRoot = config._projectRoot;
        const changelogPath = path.join(projectRoot, 'CHANGELOG.md');

        if (!(await fs.pathExists(changelogPath))) {
          const { create } = await inquirer.prompt([
            {
              type: 'confirm',
              name: 'create',
              message: 'CHANGELOG.md not found. Create it with standard template?',
              default: true,
            },
          ]);

          if (create) {
            const template =
              '# Changelog\n\nAll notable changes to this project will be documented in this file.\n\n## [Unreleased]\n\n### Added\n\n### Fixed\n\n### Changed\n';
            await fs.writeFile(changelogPath, template);
            print.success('Created CHANGELOG.md');
          } else {
            return;
          }
        }

        if (!config.features?.ai || !(await isAiAvailable(config))) {
          print.error('AI features are disabled or no AI provider is configured.');
          print.info(
            'Set features.ai: true and configure ai.provider in .sfdt/config.json.',
          );
          return;
        }

        print.info(`Analyzing the last ${options.limit} commits...`);

        const prompt = [
          `Analyze the recent git commits in this Salesforce project and generate professional CHANGELOG.md entries.`,
          `Focus on: new features (Added), bug fixes (Fixed), breaking changes (Changed/Removed).`,
          `Categorize entries into: Added, Changed, Fixed, Deprecated, Removed, Security.`,
          `Format as a list of bullet points for each category.`,
          `ONLY provide the bullet points for the [Unreleased] section. Do not include headers like '## [Unreleased]'.`,
          `Run 'git log --oneline -n ${options.limit}' to see recent commits.`,
          `Output format example:`,
          `### Added\n- New Account trigger handler for automated validation\n- Support for Slack notifications`,
          `### Fixed\n- Issue with deployment manifest generation for PermissionSets`,
        ].join('\n');

        print.header('AI Changelog Generation');
        const response = await runAiPrompt(prompt, {
          config,
          allowedTools: ['Bash(git log:*)', 'Read'],
          cwd: projectRoot,
          aiEnabled: true,
          interactive: true,
        });

        if (response) {
          const { apply } = await inquirer.prompt([
            {
              type: 'confirm',
              name: 'apply',
              message:
                'Would you like to append these entries to your CHANGELOG.md [Unreleased] section?',
              default: true,
            },
          ]);

          if (apply) {
            // Simple append logic for now - in a real tool we'd parse and merge
            const currentContent = await fs.readFile(changelogPath, 'utf8');
            const unreleasedTag = '## [Unreleased]';

            if (currentContent.includes(unreleasedTag)) {
              const parts = currentContent.split(unreleasedTag);
              const newContent = `${parts[0]}${unreleasedTag}\n\n${response}${parts[1]}`;
              await fs.writeFile(changelogPath, newContent);
              print.success('Updated CHANGELOG.md');
            } else {
              await fs.appendFile(changelogPath, `\n\n${response}`);
              print.success('Appended to CHANGELOG.md');
            }
          }
        }
      } catch (err) {
        print.error(`Changelog generation failed: ${err.message}`);
        process.exitCode = resolveExitCode(err);
      }
    });

  changelog
    .command('release <version>')
    .description('Move [Unreleased] changes to a new version section')
    .action(async (version) => {
      if (!/^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/.test(version)) {
        print.error(`Invalid version: ${version} (expected semver e.g. 1.2.3)`);
        process.exitCode = 1;
        return;
      }
      try {
        const config = await loadConfig();
        print.info(`Releasing version ${version} in CHANGELOG.md...`);

        // Pass the script path as a positional arg to avoid shell interpolation
        const scriptPath = path.resolve(config._projectRoot, 'scripts/lib/changelog-utils.sh');
        await execa(
          'bash',
          ['-c', 'source "$1" && move_unreleased_to_version "$SFDT_VERSION"', 'bash', scriptPath],
          { cwd: config._projectRoot, env: { ...process.env, SFDT_VERSION: version } },
        );
        print.success(`CHANGELOG.md updated: [Unreleased] -> [${version}]`);
      } catch (err) {
        print.error(`Changelog release failed: ${err.message}`);
        process.exitCode = 1;
      }
    });

  changelog
    .command('check')
    .description('Verify [Unreleased] content against git changes')
    .action(async () => {
      try {
        const config = await loadConfig();
        const projectRoot = config._projectRoot;

        print.info('Checking CHANGELOG.md against git changes...');

        // Check if there are uncommitted changes
        const { stdout: gitStatus } = await execa('git', ['status', '--porcelain'], {
          cwd: projectRoot,
        });

        // Pass the script path as a positional arg to avoid shell interpolation
        const scriptPath = path.resolve(projectRoot, 'scripts/lib/changelog-utils.sh');
        const { stdout: contentStatus } = await execa(
          'bash',
          [
            '-c',
            'source "$1"; if has_unreleased_content; then echo "HAS_CONTENT"; else echo "EMPTY"; fi',
            'bash',
            scriptPath,
          ],
          { cwd: projectRoot },
        );

        if (gitStatus && contentStatus.trim() === 'EMPTY') {
          print.warning(
            'You have git changes but the [Unreleased] section in CHANGELOG.md is empty.',
          );
          print.info('Run "sfdt changelog generate" to update it with AI.');
          process.exitCode = 1;
        } else if (!gitStatus && contentStatus.trim() === 'HAS_CONTENT') {
          print.info('CHANGELOG.md has unreleased changes, but git is clean.');
        } else if (gitStatus && contentStatus.trim() === 'HAS_CONTENT') {
          print.success('CHANGELOG.md is synced with your changes.');
        } else {
          print.info('No changes in git or CHANGELOG.md.');
        }
      } catch (err) {
        print.error(`Changelog check failed: ${err.message}`);
        process.exitCode = 1;
      }
    });
}
