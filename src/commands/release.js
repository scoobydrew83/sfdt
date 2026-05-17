import fs from 'fs-extra';
import path from 'path';
import { execa } from 'execa';
import inquirer from 'inquirer';
import { loadConfig } from '../lib/config.js';
import { runScript } from '../lib/script-runner.js';
import { isAiAvailable, runAiPrompt } from '../lib/ai.js';
import { getPrompt, interpolate } from '../lib/prompts.js';
import { print } from '../lib/output.js';
import { resolveExitCode } from '../lib/exit-codes.js';

export function registerReleaseCommand(program) {
  program
    .command('release [version]')
    .description('Generate a release manifest and optionally AI-powered release notes')
    .option('--package <name|all>', 'Package directory to generate manifest for: a short name or "all"', 'all')
    .option('--name <label>', 'Release label (semver, free-form, or "today")')
    .action(async (version, options) => {
      try {
        const config = await loadConfig();
        const projectRoot = config._projectRoot;
        const args = version ? [version] : [];

        let releaseName = options.name || version || null;
        if (releaseName === 'today') {
          releaseName = new Date().toISOString().slice(0, 10);
        }
        if (releaseName && !/^[A-Za-z0-9._-]+$/.test(releaseName)) {
          print.error('Release name may only contain letters, numbers, dots, underscores, and hyphens.');
          process.exitCode = 1;
          return;
        }
        const pkgTarget = options.package || 'all';
        if (pkgTarget !== 'all') {
          const validPackages = (config.packageDirectories ?? []).map((p) => p.name).filter(Boolean);
          if (!validPackages.includes(pkgTarget)) {
            print.error(`Unknown package "${pkgTarget}". Valid options: all${validPackages.length ? ', ' + validPackages.join(', ') : ''}`);
            process.exitCode = 1;
            return;
          }
        }

        // Resolve changelog file: per-package file or global CHANGELOG.md
        const changelogDir = config.changelogDir || 'changelogs';
        const changelogFile = pkgTarget !== 'all'
          ? path.join(changelogDir, `${pkgTarget}.md`)
          : 'CHANGELOG.md';

        print.header('Generating Release Manifest');

        // Generate manifests + update changelog (no commit/tag/push)
        // Script outputs the resolved version to stdout
        const result = await runScript('core/generate-release-manifest.sh', config, {
          args,
          cwd: projectRoot,
          captureStdout: true,
          env: {
            SFDT_PACKAGE_TARGET: pkgTarget,
            SFDT_CHANGELOG_FILE: changelogFile,
            ...(releaseName ? { SFDT_RELEASE_NAME: releaseName } : {}),
          },
        });

        const resolvedVersion = (result.stdout || '').trim() || version || 'latest';

        print.success('Release manifest generated.');

        // Offer AI release notes if enabled
        const aiEnabled = config.features?.ai;
        if (aiEnabled && (await isAiAvailable(config))) {
          const { generateNotes } = await inquirer.prompt([
            {
              type: 'confirm',
              name: 'generateNotes',
              message: 'Generate AI-powered release notes from git log?',
              default: true,
            },
          ]);

          if (generateNotes) {
            const { notesRelPath, notesFilePath } = resolveNotesPath(
              config, projectRoot, pkgTarget, resolvedVersion,
            );

            await fs.ensureDir(path.dirname(notesFilePath));

            const pkgDesc = pkgTarget !== 'all' ? ` for package "${pkgTarget}"` : '';
            print.info(`Generating release notes for ${resolvedVersion}${pkgDesc}...`);

            const releaseNotesTemplate = await getPrompt('release-notes', config._configDir);
            const prompt = interpolate(releaseNotesTemplate, {
              version: resolvedVersion,
              outputPath: notesFilePath,
              ...(pkgTarget !== 'all' ? { packageName: pkgTarget } : {}),
            });

            await runAiPrompt(prompt, {
              config,
              allowedTools: ['Bash(git log:*)', 'Read', 'Write'],
              cwd: projectRoot,
              aiEnabled: true,
              interactive: true,
            });

            if (await fs.pathExists(notesFilePath)) {
              print.success(`Release notes saved to ${notesRelPath}`);
            }
          }
        }

        // Git workflow: stage, commit, tag, deploy prompt, push
        await gitWorkflow(projectRoot, config, releaseName || resolvedVersion, pkgTarget, changelogFile);
      } catch (err) {
        print.error(`Release failed: ${err.message}`);
        process.exitCode = resolveExitCode(err);
      }
    });
}

function resolveNotesPath(config, projectRoot, pkgTarget, version) {
  const releaseNotesDir = config.releaseNotesDir || 'release-notes';
  const layout = config.manifestLayout || 'flat';

  let notesFileName, notesSubdir;
  if (pkgTarget !== 'all') {
    if (layout === 'subpath') {
      notesFileName = `rl-${version}-RELEASE-NOTES.md`;
      notesSubdir = pkgTarget;
    } else {
      notesFileName = `rl-${version}-${pkgTarget}-RELEASE-NOTES.md`;
      notesSubdir = '';
    }
  } else {
    notesFileName = `rl-${version}-RELEASE-NOTES.md`;
    notesSubdir = '';
  }

  const notesRelPath = notesSubdir
    ? path.join(releaseNotesDir, notesSubdir, notesFileName)
    : path.join(releaseNotesDir, notesFileName);
  const notesFilePath = path.join(projectRoot, notesRelPath);
  return { notesRelPath, notesFilePath };
}

async function gitWorkflow(projectRoot, config, version, pkgTarget, changelogFile) {
  const manifestDir = config.manifestDir || 'manifest/release';
  const execOpts = { cwd: projectRoot, reject: false };

  print.header('Git Workflow');

  // Stage manifest files — flat layout and subpath layout (one dir deeper)
  await execa('git', ['add', '-f', `${manifestDir}/rl-${version}-*`], execOpts);
  await execa('git', ['add', '-f', `${manifestDir}/*/rl-${version}-*`], execOpts);

  // Stage changelog if modified
  const changelogDiff = await execa('git', ['diff', '--quiet', changelogFile], execOpts);
  if (changelogDiff.exitCode !== 0) {
    await execa('git', ['add', changelogFile], execOpts);
  }

  // Stage release notes if they exist
  const { notesRelPath, notesFilePath } = resolveNotesPath(config, projectRoot, pkgTarget, version);
  if (await fs.pathExists(notesFilePath)) {
    await execa('git', ['add', notesRelPath], execOpts);
  }

  // Show staged files
  const status = await execa('git', ['status', '--short'], execOpts);
  const stagedFiles = (status.stdout || '').split('\n').filter((l) => /^[AM]/.test(l));

  if (stagedFiles.length === 0) {
    print.warning('No files to commit (manifests may already be committed)');
    return;
  }

  print.info('Staged files:');
  for (const line of stagedFiles) {
    print.step(`  ${line}`);
  }

  // Commit
  const { doCommit } = await inquirer.prompt([
    { type: 'confirm', name: 'doCommit', message: 'Commit these changes?', default: true },
  ]);

  if (!doCommit) {
    print.warning('Changes not committed');
    return;
  }

  const pkgLabel = pkgTarget !== 'all' ? `${pkgTarget} ` : '';
  await execa('git', ['commit', '-m', `release: Generate manifests for ${pkgLabel}${version}`], execOpts);
  print.success('Changes committed');

  // Tag
  const tag = `v${version}`;
  const { doTag } = await inquirer.prompt([
    { type: 'confirm', name: 'doTag', message: `Create git tag ${tag}?`, default: true },
  ]);

  if (doTag) {
    await execa('git', ['tag', '-a', tag, '-m', `Release ${version}`], execOpts);
    print.success(`Tag ${tag} created`);
  }

  // Offer deployment before push
  const { proceedToDeploy } = await inquirer.prompt([
    { type: 'confirm', name: 'proceedToDeploy', message: 'Proceed to deployment?', default: false },
  ]);

  if (proceedToDeploy) {
    print.header('Deploying');
    await runScript('core/deployment-assistant.sh', config, { cwd: projectRoot });
    print.success('Deployment completed successfully.');
  }

  // Push
  if (doTag) {
    const { doPush } = await inquirer.prompt([
      { type: 'confirm', name: 'doPush', message: `Push tag ${tag} to remote?`, default: false },
    ]);

    if (doPush) {
      await execa('git', ['push', 'origin', tag], execOpts);
      print.success('Tag pushed to remote');
    }
  }
}
