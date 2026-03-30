import inquirer from 'inquirer';
import { loadConfig } from '../lib/config.js';
import { runScript } from '../lib/script-runner.js';
import { isClaudeAvailable, runAiPrompt } from '../lib/ai.js';
import { print } from '../lib/output.js';

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

        await runScript('core/generate-release-manifest.sh', config, {
          args,
          cwd: projectRoot,
        });

        print.success('Release manifest generated.');

        // Offer AI release notes if enabled
        const aiEnabled = config.features?.ai;
        if (aiEnabled && await isClaudeAvailable()) {
          const { generateNotes } = await inquirer.prompt([
            {
              type: 'confirm',
              name: 'generateNotes',
              message: 'Generate AI-powered release notes from git log?',
              default: true,
            },
          ]);

          if (generateNotes) {
            const versionLabel = version || 'latest';
            print.info(`Generating release notes for ${versionLabel}...`);

            const prompt = [
              `Analyze the recent git log for this Salesforce project and generate concise, professional release notes.`,
              `Version: ${versionLabel}`,
              `Focus on: new features, bug fixes, breaking changes, and deployment notes.`,
              `Format as markdown with sections: ## What's New, ## Bug Fixes, ## Breaking Changes (if any), ## Deployment Notes.`,
              `Run 'git log --oneline -30' to see recent commits.`,
            ].join('\n');

            await runAiPrompt(prompt, {
              allowedTools: ['Bash(git log:*)', 'Read'],
              cwd: projectRoot,
              aiEnabled: true,
              interactive: true,
            });
          }
        }
      } catch (err) {
        print.error(`Release failed: ${err.message}`);
        process.exitCode = 1;
      }
    });
}
