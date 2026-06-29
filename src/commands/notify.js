import path from 'path';
import fs from 'fs-extra';
import { loadConfig } from '../lib/config.js';
import { print } from '../lib/output.js';
import { resolveExitCode } from '../lib/exit-codes.js';
import { dispatch, dispatchSnapshot, notificationsConfigured } from '../lib/notifier.js';

const LIFECYCLE_EVENTS = ['deploy-success', 'deploy-failure', 'test-failure', 'release-created'];
const VALID_EVENTS = [...LIFECYCLE_EVENTS, 'snapshot'];

function printNotConfiguredHelp() {
  print.warning('Notifications are not configured.');
  console.log('');
  print.info('Enable a channel in .sfdt/config.json:');
  print.step('   {');
  print.step('     "features": { "notifications": true },');
  print.step('     "notifications": {');
  print.step('       "enabled": true,');
  print.step('       "channels": [');
  print.step('         { "type": "slack", "webhookUrlEnv": "SLACK_WEBHOOK_URL", "severityThreshold": "warn", "events": ["deploy-failure", "snapshot"] }');
  print.step('       ]');
  print.step('     }');
  print.step('   }');
  console.log('');
  print.info('Channel types: slack | teams | email | webhook. Secrets are referenced by env-var name.');
}

async function sendSnapshot(options) {
  const config = await loadConfig();
  if (!notificationsConfigured(config)) {
    printNotConfiguredHelp();
    process.exitCode = 1;
    return;
  }
  const type = options.type === 'audit' ? 'audit' : 'monitor';
  const logDir = config.logDir ?? path.join(config._projectRoot, 'logs');
  const snapPath = path.join(logDir, `${type}-latest.json`);
  if (!(await fs.pathExists(snapPath))) {
    print.error(`No ${type} snapshot found at ${snapPath} — run "sfdt ${type} all" first.`);
    process.exitCode = 1;
    return;
  }
  const snapshot = await fs.readJson(snapPath);
  print.info(`Dispatching ${type} snapshot (${snapshot.org ?? 'org'})…`);
  const { severity, results } = await dispatchSnapshot(snapshot, config, { type });
  if (results.length === 0) {
    print.info(`No channel subscribed to snapshots at severity "${severity}".`);
    return;
  }
  reportResults(results);
}

async function sendEvent(event, options) {
  const config = await loadConfig();
  if (!notificationsConfigured(config)) {
    printNotConfiguredHelp();
    process.exitCode = 1;
    return;
  }
  const ctx = {
    version: options.version,
    org: options.org || config.defaultOrg,
    message: options.message,
    projectName: config.projectName,
  };
  print.info(`Sending ${event} notification…`);
  const results = await dispatch(event, ctx, config);
  if (results.length === 0) {
    print.info(`No channel subscribed to "${event}".`);
    return;
  }
  reportResults(results);
}

function reportResults(results) {
  const failures = results.filter((r) => !r.ok);
  const sent = results.filter((r) => r.ok).map((r) => r.channel);
  if (sent.length) print.success(`Sent to: ${sent.join(', ')}`);
  if (failures.length) {
    const detail = failures.map((f) => `${f.channel} (${f.error})`).join('; ');
    print.error(`Failed: ${detail}`);
    process.exitCode = 1;
  }
}

export function registerNotifyCommand(program) {
  program
    .command('notify <event>')
    .description(`Send a notification (events: ${VALID_EVENTS.join(', ')})`)
    .option('--version <ver>', 'Version label')
    .option('--org <alias>', 'Org alias')
    .option('--message <msg>', 'Custom message')
    .option('--type <type>', 'For the "snapshot" event: audit | monitor', 'monitor')
    .action(async (event, options) => {
      try {
        if (!VALID_EVENTS.includes(event)) {
          print.error(`Unknown event: "${event}"\n  Valid events: ${VALID_EVENTS.join(', ')}`);
          process.exitCode = 1;
          return;
        }
        if (event === 'snapshot') {
          await sendSnapshot(options);
        } else {
          await sendEvent(event, options);
        }
      } catch (err) {
        print.error(`Notification failed: ${err.message}`);
        process.exitCode = resolveExitCode(err);
      }
    });
}
