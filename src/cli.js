import { Command } from 'commander';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

import { registerInitCommand } from './commands/init.js';
import { registerDeployCommand } from './commands/deploy.js';
import { registerReleaseCommand } from './commands/release.js';
import { registerTestCommand } from './commands/test.js';
import { registerPullCommand } from './commands/pull.js';
import { registerQualityCommand } from './commands/quality.js';
import { registerPreflightCommand } from './commands/preflight.js';
import { registerRollbackCommand } from './commands/rollback.js';
import { registerSmokeCommand } from './commands/smoke.js';
import { registerReviewCommand } from './commands/review.js';
import { registerNotifyCommand } from './commands/notify.js';
import { registerDriftCommand } from './commands/drift.js';
import { registerChangelogCommand } from './commands/changelog.js';
import { registerManifestCommand } from './commands/manifest.js';
import { registerExplainCommand } from './commands/explain.js';
import { registerPrDescriptionCommand } from './commands/prDescription.js';
import { registerUiCommand } from './commands/ui.js';
import { registerCompareCommand } from './commands/compare.js';
import { registerCompletionCommand } from './commands/completion.js';
import { registerUpdateCommand } from './commands/update.js';
import { registerConfigCommand } from './commands/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf-8'));

export function createCli() {
  const program = new Command();

  program
    .name('sfdt')
    .description(
      'Salesforce DevTools — deployment, testing, quality, and release management for any Salesforce DX project',
    )
    .version(pkg.version, '-v, --version', 'Print the sfdt version and exit')
    .addHelpCommand('help [command]', 'Display help for a command');

  // Register all commands
  registerInitCommand(program);
  registerDeployCommand(program);
  registerReleaseCommand(program);
  registerTestCommand(program);
  registerPullCommand(program);
  registerQualityCommand(program);
  registerPreflightCommand(program);
  registerRollbackCommand(program);
  registerSmokeCommand(program);
  registerReviewCommand(program);
  registerNotifyCommand(program);
  registerDriftCommand(program);
  registerChangelogCommand(program);
  registerManifestCommand(program);
  registerExplainCommand(program);
  registerPrDescriptionCommand(program);
  registerUiCommand(program);
  registerCompareCommand(program);
  registerCompletionCommand(program);
  registerUpdateCommand(program);
  registerConfigCommand(program);

  // Explicit `sfdt version` subcommand (mirrors the -v / --version flag)
  program
    .command('version')
    .description('Print the sfdt version')
    .action(() => {
      console.log(`sfdt v${pkg.version}`);
    });

  return program;
}
