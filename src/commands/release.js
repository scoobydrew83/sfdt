import fs from 'fs-extra';
import path from 'path';
import { execa } from 'execa';
import inquirer from 'inquirer';
import { loadConfig } from '../lib/config.js';
import { runScript } from '../lib/script-runner.js';
import { isAiAvailable, runAiPrompt } from '../lib/ai.js';
import { print } from '../lib/output.js';
import { resolveExitCode } from '../lib/exit-codes.js';

export function registerReleaseCommand(program) {
  program
    .command('release [version]')
    .description('Generate a release manifest and optionally AI-powered release notes')
    .action(async (version) => {
      try {
        const config = await loadConfig();
        const projectRoot = config._projectRoot;
        const args = version ? [version] : [];

        print.header('Generating Release Manifest');

        // Generate manifests + update CHANGELOG (no commit/tag/push)
        // Script outputs the resolved version to stdout
        const result = await runScript('core/generate-release-manifest.sh', config, {
          args,
          cwd: projectRoot,
          captureStdout: true,
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
            const releaseNotesDir = config.releaseNotesDir || 'release-notes';
            const notesFileName = `rl-${resolvedVersion}-RELEASE-NOTES.md`;
            const notesFilePath = path.join(projectRoot, releaseNotesDir, notesFileName);

            await fs.ensureDir(path.join(projectRoot, releaseNotesDir));

            print.info(`Generating release notes for ${resolvedVersion}...`);

            const prompt = [
              `Analyze the recent git log for this Salesforce project and generate concise, professional release notes.`,
              `Version: ${resolvedVersion}`,
              `Focus on: new features, bug fixes, breaking changes, and deployment notes.`,
              `Format as markdown with sections: ## What's New, ## Bug Fixes, ## Breaking Changes (if any), ## Deployment Notes.`,
              `Run 'git log --oneline -30' to see recent commits.`,
              `Write the release notes to: ${notesFilePath}`,
            ].join('\n');

            await runAiPrompt(prompt, {
              config,
              allowedTools: ['Bash(git log:*)', 'Read', 'Write'],
              cwd: projectRoot,
              aiEnabled: true,
              interactive: true,
            });

            if (await fs.pathExists(notesFilePath)) {
              print.success(`Release notes saved to ${releaseNotesDir}/${notesFileName}`);
            }
          }
        }

        // Git workflow: stage, commit, tag, deploy prompt, push
        await gitWorkflow(projectRoot, config, resolvedVersion);
      } catch (err) {
        print.error(`Release failed: ${err.message}`);
        process.exitCode = resolveExitCode(err);
      }
    });
}

async function gitWorkflow(projectRoot, config, version) {
  const manifestDir = config.manifestDir || 'manifest/release';
  const releaseNotesDir = config.releaseNotesDir || 'release-notes';
  const execOpts = { cwd: projectRoot, reject: false };

  print.header('Git Workflow');

  // Stage manifest files
  await execa('git', ['add', '-f', `${manifestDir}/rl-${version}-*`], execOpts);

  // Stage CHANGELOG.md if modified
  const changelogDiff = await execa('git', ['diff', '--quiet', 'CHANGELOG.md'], execOpts);
  if (changelogDiff.exitCode !== 0) {
    await execa('git', ['add', 'CHANGELOG.md'], execOpts);
  }

  // Stage release notes if they exist
  const notesFile = path.join(releaseNotesDir, `rl-${version}-RELEASE-NOTES.md`);
  if (await fs.pathExists(path.join(projectRoot, notesFile))) {
    await execa('git', ['add', notesFile], execOpts);
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

  await execa('git', ['commit', '-m', `release: Generate manifests for ${version}`], execOpts);
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
