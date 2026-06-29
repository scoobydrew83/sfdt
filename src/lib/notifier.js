/**
 * Provider-agnostic notification dispatcher.
 *
 * Resolves notification channels from config, routes messages by event type and
 * (for snapshots) by per-channel severity threshold, and sends via the right
 * formatter. Slack / Teams / webhook use native fetch; email lazy-loads
 * nodemailer so the dependency is only required when an email channel is used.
 *
 * Channel secrets (webhook URLs, SMTP credentials) are referenced by env-var
 * NAME (the `*Env` fields), never stored inline — mirroring `ai.apiKeyEnv`.
 * Inline URLs remain supported for backward compatibility but are discouraged.
 */

import { maxStatus, meetsThreshold } from './check-status.js';
import { redactSensitiveData } from './audit-logger.js';
import {
  buildEventMessage,
  buildSnapshotMessage,
  renderSlack,
  renderTeams,
  renderWebhook,
  renderLoki,
  renderEmail,
} from './notifier-formatters.js';

/**
 * Resolve the list of active channels from config.
 *
 * - The modern shape is `notifications.channels[]`, active when
 *   `notifications.enabled === true`.
 * - The legacy single-Slack shape (`notifications.slack.webhookUrl`) is honoured
 *   when the `features.notifications` flag is on, for backward compatibility.
 *
 * @param {object} config
 * @returns {Array<object>} normalised channel objects (unresolved URLs).
 */
export function resolveChannels(config) {
  const n = config?.notifications ?? {};
  const channels = [];
  if (n.enabled === true && Array.isArray(n.channels)) {
    for (const ch of n.channels) channels.push({ ...ch });
  }
  if (config?.features?.notifications === true && n.slack && (n.slack.webhookUrl || n.slack.webhookUrlEnv)) {
    channels.push({
      type: 'slack',
      name: 'slack',
      webhookUrl: n.slack.webhookUrl,
      webhookUrlEnv: n.slack.webhookUrlEnv,
      severityThreshold: 'warn',
      // Pin to the four lifecycle events this channel handled before the modern
      // channels[] shape existed — otherwise a null filter silently opts legacy
      // users into newer events (e.g. `snapshot`) they never configured.
      events: ['deploy-success', 'deploy-failure', 'test-failure', 'release-created'],
    });
  }
  return channels;
}

/** True when at least one channel is configured (used for the "not configured" path). */
export function notificationsConfigured(config) {
  return resolveChannels(config).length > 0;
}

/**
 * Redacted, secret-free description of configured channels for the GUI. Never
 * returns URLs, env-var values, or SMTP credentials — only whether a target is
 * resolvable.
 */
export function describeChannels(config) {
  return resolveChannels(config).map((ch) => ({
    name: channelLabel(ch),
    type: ch.type,
    severityThreshold: ch.severityThreshold || 'warn',
    events: Array.isArray(ch.events) ? ch.events : null,
    target: ch.type === 'email' ? Array.isArray(ch.to) && ch.to.length > 0 : !!channelUrl(ch),
  }));
}

function channelUrl(ch) {
  if (ch.webhookUrl) return ch.webhookUrl;
  if (ch.webhookUrlEnv && process.env[ch.webhookUrlEnv]) return process.env[ch.webhookUrlEnv];
  if (ch.url) return ch.url;
  if (ch.urlEnv && process.env[ch.urlEnv]) return process.env[ch.urlEnv];
  return null;
}

function channelLabel(ch) {
  return ch.name || ch.type;
}

function eventAllowed(ch, event) {
  if (!Array.isArray(ch.events)) return true; // no filter → all events
  return ch.events.includes(event);
}

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = await res.text();
    } catch {
      detail = '';
    }
    throw new Error(`${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return res;
}

async function sendEmail(ch, message) {
  const get = (name) => (name ? process.env[name] : undefined);
  const smtp = ch.smtp ?? {};
  const host = get(smtp.hostEnv);
  const port = Number.parseInt(get(smtp.portEnv) ?? '587', 10);
  const user = get(smtp.userEnv);
  const pass = get(smtp.passwordEnv);
  if (!host) throw new Error(`SMTP host env var (${smtp.hostEnv || 'unset'}) is empty`);
  if (!Array.isArray(ch.to) || ch.to.length === 0) throw new Error('email channel has no "to" recipients');

  let nodemailer;
  try {
    ({ default: nodemailer } = await import('nodemailer'));
  } catch {
    throw new Error('nodemailer is not installed — run `npm install nodemailer` to enable email notifications');
  }
  const transport = nodemailer.createTransport({
    host,
    port,
    secure: ch.smtp?.secure ?? port === 465,
    auth: user ? { user, pass } : undefined,
  });
  const { subject, text, html } = renderEmail(message);
  await transport.sendMail({ from: ch.from || user, to: ch.to.join(', '), subject, text, html });
}

/**
 * Send one already-built message to a single channel. Never throws — returns a
 * result record so one bad channel can't abort the others.
 */
async function sendToChannel(ch, message, { kind, snapshot, org } = {}) {
  const label = channelLabel(ch);
  try {
    if (ch.type === 'email') {
      await sendEmail(ch, message);
      return { channel: label, type: ch.type, ok: true };
    }
    const url = channelUrl(ch);
    if (!url) {
      return { channel: label, type: ch.type, ok: false, error: 'no webhook URL resolved (check webhookUrl/webhookUrlEnv/url)' };
    }
    let body;
    if (ch.type === 'slack') body = renderSlack(message);
    else if (ch.type === 'teams') body = renderTeams(message);
    else if (ch.type === 'webhook') {
      // Both webhook shapes go to an external sink, so redact either way.
      body = ch.format === 'loki'
        ? redactSensitiveData(renderLoki(message, { kind, org }))
        : redactSensitiveData(renderWebhook(message, { kind, snapshot }));
    } else {
      return { channel: label, type: ch.type, ok: false, error: `unsupported channel type: ${ch.type}` };
    }
    await postJson(url, body, ch.headers);
    return { channel: label, type: ch.type, ok: true };
  } catch (err) {
    return { channel: label, type: ch.type, ok: false, error: err.message };
  }
}

/**
 * Dispatch a discrete lifecycle event (deploy-success, deploy-failure, …) to all
 * channels whose `events` filter allows it. Explicit events bypass severity
 * routing — they were requested directly.
 *
 * @returns {Promise<Array<{channel,type,ok,error?}>>}
 */
export async function dispatch(event, ctx, config) {
  const channels = resolveChannels(config).filter((ch) => eventAllowed(ch, event));
  if (channels.length === 0) return [];
  const message = buildEventMessage(event, ctx);
  return Promise.all(channels.map((ch) => sendToChannel(ch, message, { kind: event })));
}

/**
 * Send a test message to every configured channel, ignoring event filters and
 * severity thresholds (so a user can verify wiring). Returns per-channel results.
 */
export async function dispatchTest(config) {
  const channels = resolveChannels(config);
  if (channels.length === 0) return [];
  const message = buildEventMessage('snapshot', { message: 'Test notification from sfdt — your channel is wired correctly.' });
  message.title = 'SFDT Test Notification';
  return Promise.all(channels.map((ch) => sendToChannel(ch, message, { kind: 'test' })));
}

/**
 * Build a 1–2 paragraph AI executive summary of a snapshot, or null if AI is
 * unavailable/disabled. Lazy-imports ai/prompts so the no-summary path stays
 * cheap. The snapshot payload is redacted before being sent to the model.
 */
async function buildSnapshotSummary(snapshot, type, config) {
  try {
    const { isAiAvailable, runAiPrompt } = await import('./ai.js');
    if (!config?.features?.ai || !(await isAiAvailable(config))) return null;
    const { getPrompt, interpolate } = await import('./prompts.js');
    const tmpl = await getPrompt('monitor-summary', config._configDir);
    const compact = {
      org: snapshot?.org ?? null,
      summary: snapshot?.summary ?? {},
      checks: (snapshot?.checks ?? []).map((c) => ({ id: c.id, title: c.title, status: c.status, summary: c.summary })),
    };
    const payload = redactSensitiveData(JSON.stringify(compact));
    const prompt = `${interpolate(tmpl, { type, org: snapshot?.org ?? 'org' })}\n\nSNAPSHOT JSON:\n${payload}`;
    const res = await runAiPrompt(prompt, {
      config,
      allowedTools: [],
      cwd: config._projectRoot,
      aiEnabled: true,
      interactive: false,
    });
    const text = typeof res?.stdout === 'string' ? res.stdout.trim() : '';
    return text || null;
  } catch {
    return null;
  }
}

/**
 * Dispatch an audit/monitor snapshot. Routes only to channels that (a) allow the
 * 'snapshot' event and (b) have a severityThreshold at or below the snapshot's
 * worst status.
 *
 * @param {object} snapshot - { org, checks, summary }
 * @param {object} config
 * @param {object} [options]
 * @param {'audit'|'monitor'} [options.type]
 * @returns {Promise<{severity, results: Array}>}
 */
export async function dispatchSnapshot(snapshot, config, { type = 'monitor' } = {}) {
  const severity = maxStatus(snapshot?.checks);
  const channels = resolveChannels(config).filter(
    (ch) => eventAllowed(ch, 'snapshot') && meetsThreshold(severity, ch.severityThreshold || 'warn'),
  );
  if (channels.length === 0) return { severity, results: [] };
  const message = buildSnapshotMessage({ ...snapshot, _severity: severity }, type);
  // Optional AI executive summary replaces the raw findings list in the body.
  if (config?.notifications?.summary?.enabled) {
    const summary = await buildSnapshotSummary(snapshot, type, config);
    if (summary) message.text = summary;
  }
  const results = await Promise.all(
    channels.map((ch) => sendToChannel(ch, message, { kind: `${type}-snapshot`, snapshot, org: snapshot?.org })),
  );
  return { severity, results };
}
