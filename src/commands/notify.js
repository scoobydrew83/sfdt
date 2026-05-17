import { loadConfig } from '../lib/config.js';
import { print } from '../lib/output.js';
import { resolveExitCode } from '../lib/exit-codes.js';

const VALID_EVENTS = ['deploy-success', 'deploy-failure', 'test-failure', 'release-created'];

const EVENT_CONFIGS = {
  'deploy-success': {
    color: '#36a64f',
    emoji: ':white_check_mark:',
    title: 'Deployment Successful',
  },
  'deploy-failure': {
    color: '#e01e5a',
    emoji: ':x:',
    title: 'Deployment Failed',
  },
  'test-failure': {
    color: '#e01e5a',
    emoji: ':warning:',
    title: 'Test Failure',
  },
  'release-created': {
    color: '#2eb886',
    emoji: ':rocket:',
    title: 'Release Created',
  },
};

function buildSlackPayload(event, { version, org, message, projectName }) {
  const eventConfig = EVENT_CONFIGS[event];

  const fields = [];
  if (projectName) {
    fields.push({ type: 'mrkdwn', text: `*Project:*\n${projectName}` });
  }
  if (org) {
    fields.push({ type: 'mrkdwn', text: `*Org:*\n${org}` });
  }
  if (version) {
    fields.push({ type: 'mrkdwn', text: `*Version:*\n${version}` });
  }

  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `${eventConfig.emoji} ${eventConfig.title}`,
        emoji: true,
      },
    },
  ];

  if (fields.length > 0) {
    blocks.push({
      type: 'section',
      fields,
    });
  }

  if (message) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: message,
      },
    });
  }

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `Sent by sfdt | ${new Date().toISOString()}`,
      },
    ],
  });

  return {
    blocks,
    attachments: [
      {
        color: eventConfig.color,
        blocks: [],
      },
    ],
  };
}

export function registerNotifyCommand(program) {
  program
    .command('notify <event>')
    .description('Send a notification to Slack for deployment events')
    .option('--version <ver>', 'Version label')
    .option('--org <alias>', 'Org alias')
    .option('--message <msg>', 'Custom message')
    .action(async (event, options) => {
      try {
        if (!VALID_EVENTS.includes(event)) {
          print.error(`Unknown event: "${event}"\n` + `  Valid events: ${VALID_EVENTS.join(', ')}`);
          process.exitCode = 1;
          return;
        }

        const config = await loadConfig();

        const webhookUrl =
          config.features?.notifications && config.notifications?.slack?.webhookUrl;

        if (!webhookUrl) {
          print.warning('Slack notifications are not configured.');
          console.log('');
          print.info('To set up Slack notifications:');
          print.step(
            '1. Create a Slack Incoming Webhook at https://api.slack.com/messaging/webhooks',
          );
          print.step('2. Add the webhook URL to .sfdt/config.json:');
          console.log('');
          print.step('   {');
          print.step('     "features": { "notifications": true },');
          print.step('     "notifications": {');
          print.step('       "slack": {');
          print.step('         "webhookUrl": "https://hooks.slack.com/services/T.../B.../..."');
          print.step('       }');
          print.step('     }');
          print.step('   }');
          console.log('');
          process.exitCode = 1;
          return;
        }

        const payload = buildSlackPayload(event, {
          version: options.version,
          org: options.org || config.defaultOrg,
          message: options.message,
          projectName: config.projectName,
        });

        print.info(`Sending ${event} notification to Slack...`);

        const response = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          const body = await response.text();
          throw new Error(`Slack API returned ${response.status}: ${body}`);
        }

        print.success(`Notification sent: ${event}`);
      } catch (err) {
        print.error(`Notification failed: ${err.message}`);
        process.exitCode = resolveExitCode(err);
      }
    });
}
