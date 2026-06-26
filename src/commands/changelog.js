import inquirer from 'inquirer';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadConfig } from '../lib/config.js';
import { isAiAvailable, runAiPrompt, providerSupportsAgenticTools } from '../lib/ai.js';
import { gatherGitLog, frameProvidedContext } from '../lib/ai-context.js';
import { getPrompt, interpolate } from '../lib/prompts.js';
import { print } from '../lib/output.js';
import { execa } from 'execa';
import { resolveExitCode } from '../lib/exit-codes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPTS_DIR = path.resolve(__dirname, '..', '..', 'scripts');

function resolveChangelogPath(config, pkgName) {
  if (!pkgName) return 'CHANGELOG.md';
  const changelogDir = config.changelogDir || 'changelogs';
  return path.join(changelogDir, `${pkgName}.md`);
}

function resolvePackage(config, pkgName) {
  if (!pkgName) return null;
  const dirs = config.packageDirectories ?? [];
  const pkg = dirs.find((d) => d.name === pkgName);
  if (!pkg) {
    const valid = dirs.map((d) => d.name).filter(Boolean);
    throw new Error(
      `Unknown package "${pkgName}". Valid options: ${valid.length ? valid.join(', ') : '(none configured)'}`,
    );
  }
  return pkg;
}

export function registerChangelogCommand(program) {
  const changelog = program.command('changelog').description('Manage project CHANGELOG');

  changelog
    .command('generate')
    .description('Use AI to generate [Unreleased] entries from git history')
    .option('--limit <number>', 'Number of commits to analyze', '20')
    .option('--package <name>', 'Scope changelog to a specific package directory')
    .action(async (options) => {
      try {
        const config = await loadConfig();
        const projectRoot = config._projectRoot;

        let pkg = null;
        try {
          pkg = resolvePackage(config, options.package);
        } catch (err) {
          print.error(err.message);
          process.exitCode = 1;
          return;
        }

        const changelogRelPath = resolveChangelogPath(config, options.package);
        const changelogPath = path.join(projectRoot, changelogRelPath);

        await fs.ensureDir(path.dirname(changelogPath));

        if (!(await fs.pathExists(changelogPath))) {
          const label = options.package ? `${changelogRelPath}` : 'CHANGELOG.md';
          const { create } = await inquirer.prompt([
            {
              type: 'confirm',
              name: 'create',
              message: `${label} not found. Create it with standard template?`,
              default: true,
            },
          ]);

          if (create) {
            const template =
              '# Changelog\n\nAll notable changes to this project will be documented in this file.\n\n## [Unreleased]\n\n### Added\n\n### Fixed\n\n### Changed\n';
            await fs.writeFile(changelogPath, template);
            print.success(`Created ${label}`);
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

        const scopeDesc = pkg ? ` for package "${pkg.name}" (${pkg.path})` : '';
        print.info(`Analyzing the last ${options.limit} commits${scopeDesc}...`);

        const changelogTemplate = await getPrompt('changelog', config._configDir);
        let prompt = interpolate(changelogTemplate, {
          limit: options.limit,
          ...(pkg ? { packagePath: pkg.path, packageName: pkg.name } : {}),
        });

        // HTTP providers can't run `git log` themselves — pre-gather it.
        if (!providerSupportsAgenticTools(config)) {
          const gitLog = await gatherGitLog(projectRoot, {
            limit: options.limit,
            pkgPath: pkg?.path,
          });
          prompt += frameProvidedContext('Git history', gitLog);
        }

        print.header('AI Changelog Generation');
        // Capture (not interactive) so the generated entries are returned on
        // stdout and can be appended to the changelog.
        const response = await runAiPrompt(prompt, {
          config,
          allowedTools: ['Bash(git log:*)', 'Read'],
          cwd: projectRoot,
          aiEnabled: true,
          interactive: false,
        });

        if (response && response.exitCode !== 0) {
          print.error(response.stderr?.trim() || 'AI changelog generation failed.');
          process.exitCode = 1;
          return;
        }

        const entries = response?.stdout?.trim();
        if (entries) {
          console.log(`\n${entries}\n`);
          const { apply } = await inquirer.prompt([
            {
              type: 'confirm',
              name: 'apply',
              message: `Would you like to append these entries to your ${changelogRelPath} [Unreleased] section?`,
              default: true,
            },
          ]);

          if (apply) {
            const currentContent = await fs.readFile(changelogPath, 'utf8');
            const unreleasedTag = '## [Unreleased]';

            if (currentContent.includes(unreleasedTag)) {
              const parts = currentContent.split(unreleasedTag);
              const newContent = `${parts[0]}${unreleasedTag}\n\n${entries}\n${parts[1]}`;
              await fs.writeFile(changelogPath, newContent);
            } else {
              await fs.appendFile(changelogPath, `\n\n${entries}\n`);
            }
            print.success(`Updated ${changelogRelPath}`);
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
    .option('--package <name>', 'Target a specific package changelog')
    .action(async (version, options) => {
      if (!/^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/.test(version)) {
        print.error(`Invalid version: ${version} (expected semver e.g. 1.2.3)`);
        process.exitCode = 1;
        return;
      }
      try {
        const config = await loadConfig();

        try {
          resolvePackage(config, options.package);
        } catch (err) {
          print.error(err.message);
          process.exitCode = 1;
          return;
        }

        const changelogRelPath = resolveChangelogPath(config, options.package);
        const changelogPath = path.join(config._projectRoot, changelogRelPath);

        print.info(`Releasing version ${version} in ${changelogRelPath}...`);

        const scriptPath = path.join(SCRIPTS_DIR, 'lib', 'changelog-utils.sh');
        await execa(
          'bash',
          [
            '-c',
            'source "$1" && move_unreleased_to_version "$SFDT_VERSION" "${SFDT_CHANGELOG_FILE:-CHANGELOG.md}"',
            'bash',
            scriptPath,
          ],
          {
            cwd: config._projectRoot,
            env: { ...process.env, SFDT_VERSION: version, SFDT_CHANGELOG_FILE: changelogPath },
          },
        );
        print.success(`${changelogRelPath} updated: [Unreleased] -> [${version}]`);
      } catch (err) {
        print.error(`Changelog release failed: ${err.message}`);
        process.exitCode = 1;
      }
    });

  changelog
    .command('check')
    .description('Verify [Unreleased] content against git changes')
    .option('--package <name>', 'Check a specific package changelog')
    .action(async (options) => {
      try {
        const config = await loadConfig();
        const projectRoot = config._projectRoot;

        let pkg = null;
        try {
          pkg = resolvePackage(config, options.package);
        } catch (err) {
          print.error(err.message);
          process.exitCode = 1;
          return;
        }

        const changelogRelPath = resolveChangelogPath(config, options.package);
        const changelogPath = path.join(projectRoot, changelogRelPath);

        print.info(`Checking ${changelogRelPath} against git changes...`);

        const gitStatusArgs = pkg
          ? ['status', '--porcelain', '--', pkg.path]
          : ['status', '--porcelain'];
        const { stdout: gitStatus } = await execa('git', gitStatusArgs, { cwd: projectRoot });

        const scriptPath = path.join(SCRIPTS_DIR, 'lib', 'changelog-utils.sh');
        const { stdout: contentStatus } = await execa(
          'bash',
          [
            '-c',
            'source "$1"; if has_unreleased_content "${SFDT_CHANGELOG_FILE:-CHANGELOG.md}"; then echo "HAS_CONTENT"; else echo "EMPTY"; fi',
            'bash',
            scriptPath,
          ],
          { cwd: projectRoot, env: { ...process.env, SFDT_CHANGELOG_FILE: changelogPath } },
        );

        if (gitStatus && contentStatus.trim() === 'EMPTY') {
          print.warning(
            `You have git changes but the [Unreleased] section in ${changelogRelPath} is empty.`,
          );
          const hint = options.package
            ? `sfdt changelog generate --package ${options.package}`
            : 'sfdt changelog generate';
          print.info(`Run "${hint}" to update it with AI.`);
          process.exitCode = 1;
        } else if (!gitStatus && contentStatus.trim() === 'HAS_CONTENT') {
          print.info(`${changelogRelPath} has unreleased changes, but git is clean.`);
        } else if (gitStatus && contentStatus.trim() === 'HAS_CONTENT') {
          print.success(`${changelogRelPath} is synced with your changes.`);
        } else {
          print.info(`No changes in git or ${changelogRelPath}.`);
        }
      } catch (err) {
        print.error(`Changelog check failed: ${err.message}`);
        process.exitCode = 1;
      }
    });
}
