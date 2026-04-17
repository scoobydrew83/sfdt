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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf-8'));

export function createCli() {
  const program = new Command();

  program
    .name('sfdt')
    .description(
      'Salesforce DevTools — deployment, testing, quality, and release management for any Salesforce DX project',
    )
    .version(pkg.version, '-v, --version');

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

  return program;
}
