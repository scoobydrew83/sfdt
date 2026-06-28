/**
 * Per-channel payload formatters for the notifier.
 *
 * The notifier builds a single normalised "message" object and each renderer
 * turns it into the wire shape its channel expects. Keeping the Slack event
 * block layout here (header at [0], section fields at [1]) preserves the shape
 * the original notify command emitted, so existing Slack workspaces and tests
 * keep working.
 *
 *   message = {
 *     severity: 'ok'|'warn'|'fail'|'error',  // optional (snapshots)
 *     title:   string,
 *     emoji:   string,   // slack-style :emoji:
 *     color:   string,   // hex, e.g. '#36a64f'
 *     fields:  [{ label, value }],
 *     text:    string,   // free-form body
 *     footer:  string,
 *   }
 */

export const EVENT_CONFIGS = {
  'deploy-success': { color: '#36a64f', emoji: ':white_check_mark:', title: 'Deployment Successful' },
  'deploy-failure': { color: '#e01e5a', emoji: ':x:', title: 'Deployment Failed' },
  'test-failure': { color: '#e01e5a', emoji: ':warning:', title: 'Test Failure' },
  'release-created': { color: '#2eb886', emoji: ':rocket:', title: 'Release Created' },
  snapshot: { color: '#36a64f', emoji: ':clipboard:', title: 'Org Health Report' },
};

const SEVERITY_STYLE = {
  ok: { emoji: ':white_check_mark:', color: '#36a64f' },
  warn: { emoji: ':warning:', color: '#daa038' },
  error: { emoji: ':x:', color: '#e01e5a' },
  fail: { emoji: ':x:', color: '#e01e5a' },
};

function nowIso() {
  return new Date().toISOString();
}

/**
 * Normalised message for a discrete lifecycle event (deploy/test/release).
 */
export function buildEventMessage(event, { version, org, message, projectName } = {}) {
  const cfg = EVENT_CONFIGS[event] ?? EVENT_CONFIGS.snapshot;
  const fields = [];
  if (projectName) fields.push({ label: 'Project', value: projectName });
  if (org) fields.push({ label: 'Org', value: org });
  if (version) fields.push({ label: 'Version', value: version });
  return {
    title: cfg.title,
    emoji: cfg.emoji,
    color: cfg.color,
    fields,
    text: message || '',
    footer: `Sent by sfdt | ${nowIso()}`,
  };
}

/**
 * Normalised message summarising an audit/monitor snapshot.
 */
export function buildSnapshotMessage(snapshot, type = 'monitor') {
  const checks = Array.isArray(snapshot?.checks) ? snapshot.checks : [];
  const s = snapshot?.summary ?? { ok: 0, warn: 0, fail: 0, error: 0 };
  // severity is computed by the caller (notifier) which owns maxStatus; accept
  // it on the snapshot if present, else fall back to a coarse derivation.
  const severity = snapshot?._severity
    ?? (s.fail > 0 ? 'fail' : s.error > 0 ? 'error' : s.warn > 0 ? 'warn' : 'ok');
  const style = SEVERITY_STYLE[severity] ?? SEVERITY_STYLE.ok;
  const label = type === 'audit' ? 'Audit' : 'Monitor';
  const problems = checks
    .filter((c) => c.status && c.status !== 'ok')
    .slice(0, 8)
    .map((c) => `• *${c.title}* — ${c.summary}`)
    .join('\n');
  return {
    severity,
    title: `${label} report — ${snapshot?.org ?? 'org'}`,
    emoji: style.emoji,
    color: style.color,
    fields: [
      { label: 'Org', value: snapshot?.org ?? 'unknown' },
      { label: 'Result', value: `${s.ok} ok · ${s.warn} warn · ${s.fail} fail · ${s.error} error` },
    ],
    text: problems || 'All checks passed.',
    footer: `Sent by sfdt | ${nowIso()}`,
  };
}

/**
 * Slack incoming-webhook payload (Block Kit). Header at index 0, section fields
 * at index 1 — matches the legacy layout.
 */
export function renderSlack(message) {
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `${message.emoji} ${message.title}`, emoji: true } },
  ];
  if (message.fields?.length) {
    blocks.push({
      type: 'section',
      fields: message.fields.map((f) => ({ type: 'mrkdwn', text: `*${f.label}:*\n${f.value}` })),
    });
  }
  if (message.text) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: message.text } });
  }
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: message.footer }] });
  return { blocks, attachments: [{ color: message.color, blocks: [] }] };
}

/**
 * Microsoft Teams MessageCard (legacy connector format — broadly supported).
 */
export function renderTeams(message) {
  return {
    '@type': 'MessageCard',
    '@context': 'http://schema.org/extensions',
    themeColor: String(message.color || '#36a64f').replace('#', ''),
    summary: message.title,
    title: message.title,
    sections: [
      {
        facts: (message.fields ?? []).map((f) => ({ name: f.label, value: String(f.value) })),
        text: message.text || '',
        markdown: true,
      },
    ],
  };
}

/**
 * Generic JSON webhook payload (also the base for Loki shaping).
 */
export function renderWebhook(message, { kind, snapshot } = {}) {
  return {
    source: 'sfdt',
    kind: kind || 'notification',
    severity: message.severity ?? null,
    title: message.title,
    text: message.text,
    fields: message.fields ?? [],
    snapshot: snapshot ?? undefined,
    timestamp: nowIso(),
  };
}

/**
 * Grafana Loki push payload. Emits one log line carrying the message text with
 * severity/kind/org labels. Timestamp is nanoseconds since epoch as a string.
 */
export function renderLoki(message, { kind, org } = {}) {
  const ns = `${Date.now()}000000`;
  const line = JSON.stringify({
    title: message.title,
    severity: message.severity ?? null,
    text: message.text,
    fields: message.fields ?? [],
  });
  return {
    streams: [
      {
        stream: {
          source: 'sfdt',
          kind: kind || 'notification',
          severity: message.severity ?? 'info',
          ...(org ? { org } : {}),
        },
        values: [[ns, line]],
      },
    ],
  };
}

/**
 * GitHub-flavored markdown body for PR comments.
 */
export function renderMarkdown(message) {
  const lines = [`### ${message.title}`];
  if (message.fields?.length) {
    lines.push('');
    for (const f of message.fields) lines.push(`- **${f.label}:** ${f.value}`);
  }
  if (message.text) {
    lines.push('', message.text);
  }
  if (message.footer) {
    lines.push('', `_${message.footer}_`);
  }
  return lines.join('\n');
}

/**
 * Plain-text + minimal-HTML body for email channels (used in Step 3).
 */
export function renderEmail(message) {
  const facts = (message.fields ?? []).map((f) => `${f.label}: ${f.value}`).join('\n');
  const subject = message.severity ? `[${message.severity.toUpperCase()}] ${message.title}` : message.title;
  const text = [message.title, '', facts, '', message.text, '', message.footer]
    .filter((l) => l !== undefined)
    .join('\n');
  const html =
    `<h2>${escapeHtml(message.title)}</h2>` +
    (message.fields?.length
      ? `<ul>${message.fields.map((f) => `<li><b>${escapeHtml(f.label)}:</b> ${escapeHtml(String(f.value))}</li>`).join('')}</ul>`
      : '') +
    `<pre>${escapeHtml(message.text || '')}</pre>` +
    `<p style="color:#888;font-size:12px">${escapeHtml(message.footer || '')}</p>`;
  return { subject, text, html };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
