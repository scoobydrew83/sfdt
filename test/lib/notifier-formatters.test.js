/**
 * Direct unit tests for the notifier payload formatters.
 *
 * Each renderer takes the normalised message object produced by
 * buildEventMessage / buildSnapshotMessage and turns it into the wire shape
 * its channel expects; these tests pin those shapes for a representative
 * audit snapshot fixture so channel payloads can't drift silently.
 */

import { describe, it, expect } from 'vitest';
import {
  EVENT_CONFIGS,
  buildEventMessage,
  buildSnapshotMessage,
  renderSlack,
  renderTeams,
  renderGoogleChat,
  renderWebhook,
  renderLoki,
  renderMarkdown,
  renderEmail,
} from '../../src/lib/notifier-formatters.js';

// Representative audit snapshot — same shape as logs/audit-latest.json
// ({ org, checks[], summary }) used by the notifier tests.
const SNAPSHOT = {
  org: 'dev-org',
  checks: [
    { id: 'legacy-api', title: 'Legacy API usage', status: 'ok', summary: 'none found' },
    { id: 'unused-flows', title: 'Unused flow versions', status: 'warn', summary: '3 obsolete versions' },
    { id: 'audit-trail', title: 'Suspicious setup actions', status: 'fail', summary: '1 profile change' },
  ],
  summary: { ok: 1, warn: 1, fail: 1, error: 0 },
  _severity: 'fail',
};

const snapshotMessage = () => buildSnapshotMessage(SNAPSHOT, 'audit');

describe('buildEventMessage', () => {
  it('maps a known event to its config and collects fields', () => {
    const msg = buildEventMessage('deploy-failure', { org: 'dev-org', version: '1.2.3', projectName: 'Proj', message: 'boom' });
    expect(msg.title).toBe(EVENT_CONFIGS['deploy-failure'].title);
    expect(msg.color).toBe('#e01e5a');
    expect(msg.fields).toEqual([
      { label: 'Project', value: 'Proj' },
      { label: 'Org', value: 'dev-org' },
      { label: 'Version', value: '1.2.3' },
    ]);
    expect(msg.text).toBe('boom');
    expect(msg.footer).toMatch(/^Sent by sfdt \| /);
  });

  it('falls back to the snapshot config for unknown events', () => {
    const msg = buildEventMessage('mystery-event', {});
    expect(msg.title).toBe(EVENT_CONFIGS.snapshot.title);
    expect(msg.fields).toEqual([]);
  });
});

describe('buildSnapshotMessage', () => {
  it('summarises checks, styles by severity, and lists non-ok findings', () => {
    const msg = snapshotMessage();
    expect(msg.severity).toBe('fail');
    expect(msg.title).toBe('Audit report — dev-org');
    expect(msg.color).toBe('#e01e5a');
    expect(msg.fields).toEqual([
      { label: 'Org', value: 'dev-org' },
      { label: 'Result', value: '1 ok · 1 warn · 1 fail · 0 error' },
    ]);
    expect(msg.text).toContain('*Unused flow versions* — 3 obsolete versions');
    expect(msg.text).toContain('*Suspicious setup actions* — 1 profile change');
    expect(msg.text).not.toContain('Legacy API usage'); // ok checks excluded
  });

  it('derives severity when the caller did not precompute it', () => {
    const msg = buildSnapshotMessage({ org: 'o', checks: [], summary: { ok: 2, warn: 1, fail: 0, error: 0 } }, 'monitor');
    expect(msg.severity).toBe('warn');
    expect(msg.title).toBe('Monitor report — o');
  });

  it('reports all-clear when every check is ok', () => {
    const msg = buildSnapshotMessage({ org: 'o', checks: [{ id: 'a', title: 'A', status: 'ok', summary: 's' }], summary: { ok: 1, warn: 0, fail: 0, error: 0 } });
    expect(msg.text).toBe('All checks passed.');
  });
});

describe('renderSlack', () => {
  it('emits Block Kit blocks: header[0], section fields[1], body, context footer', () => {
    const msg = snapshotMessage();
    const payload = renderSlack(msg);
    expect(payload.blocks[0]).toEqual({
      type: 'header',
      text: { type: 'plain_text', text: `${msg.emoji} ${msg.title}`, emoji: true },
    });
    expect(payload.blocks[1].type).toBe('section');
    expect(payload.blocks[1].fields).toEqual([
      { type: 'mrkdwn', text: '*Org:*\ndev-org' },
      { type: 'mrkdwn', text: '*Result:*\n1 ok · 1 warn · 1 fail · 0 error' },
    ]);
    expect(payload.blocks[2]).toEqual({ type: 'section', text: { type: 'mrkdwn', text: msg.text } });
    expect(payload.blocks.at(-1)).toEqual({ type: 'context', elements: [{ type: 'mrkdwn', text: msg.footer }] });
    expect(payload.attachments).toEqual([{ color: '#e01e5a', blocks: [] }]);
  });

  it('omits the fields and body sections when empty', () => {
    const payload = renderSlack({ title: 'T', emoji: ':x:', color: '#000', fields: [], text: '', footer: 'f' });
    expect(payload.blocks.map((b) => b.type)).toEqual(['header', 'context']);
  });
});

describe('renderTeams', () => {
  it('emits a legacy MessageCard with facts and stripped themeColor', () => {
    const msg = snapshotMessage();
    const payload = renderTeams(msg);
    expect(payload['@type']).toBe('MessageCard');
    expect(payload['@context']).toBe('http://schema.org/extensions');
    expect(payload.themeColor).toBe('e01e5a');
    expect(payload.summary).toBe(msg.title);
    expect(payload.title).toBe(msg.title);
    expect(payload.sections).toHaveLength(1);
    expect(payload.sections[0].markdown).toBe(true);
    expect(payload.sections[0].text).toBe(msg.text);
    expect(payload.sections[0].facts).toEqual([
      { name: 'Org', value: 'dev-org' },
      { name: 'Result', value: '1 ok · 1 warn · 1 fail · 0 error' },
    ]);
  });

  it('defaults themeColor when the message has no color', () => {
    expect(renderTeams({ title: 'T', fields: [], text: '' }).themeColor).toBe('36a64f');
  });
});

describe('renderGoogleChat', () => {
  it('emits a simple { text } payload with bold title, fields, body, and italic footer', () => {
    const msg = snapshotMessage();
    const payload = renderGoogleChat(msg);
    expect(Object.keys(payload)).toEqual(['text']);
    const lines = payload.text.split('\n');
    expect(lines[0]).toBe('*Audit report — dev-org*');
    expect(lines[1]).toBe('*Org:* dev-org');
    expect(lines[2]).toBe('*Result:* 1 ok · 1 warn · 1 fail · 0 error');
    expect(payload.text).toContain(msg.text);
    expect(lines.at(-1)).toBe(`_${msg.footer}_`);
  });

  it('omits body and footer lines when absent', () => {
    const payload = renderGoogleChat({ title: 'T', fields: [], text: '', footer: '' });
    expect(payload).toEqual({ text: '*T*' });
  });
});

describe('renderWebhook', () => {
  it('emits the generic JSON envelope including kind, severity, and snapshot', () => {
    const msg = snapshotMessage();
    const payload = renderWebhook(msg, { kind: 'audit-snapshot', snapshot: SNAPSHOT });
    expect(payload).toMatchObject({
      source: 'sfdt',
      kind: 'audit-snapshot',
      severity: 'fail',
      title: msg.title,
      text: msg.text,
      fields: msg.fields,
      snapshot: SNAPSHOT,
    });
    expect(typeof payload.timestamp).toBe('string');
    expect(Number.isNaN(Date.parse(payload.timestamp))).toBe(false);
  });

  it('defaults kind and nulls severity for plain event messages', () => {
    const payload = renderWebhook(buildEventMessage('deploy-success', { org: 'o' }));
    expect(payload.kind).toBe('notification');
    expect(payload.severity).toBeNull();
    expect(payload.snapshot).toBeUndefined();
  });
});

describe('renderLoki', () => {
  it('emits a single-stream push payload with labels and a ns timestamp', () => {
    const msg = snapshotMessage();
    const payload = renderLoki(msg, { kind: 'audit-snapshot', org: 'dev-org' });
    expect(payload.streams).toHaveLength(1);
    const { stream, values } = payload.streams[0];
    expect(stream).toEqual({ source: 'sfdt', kind: 'audit-snapshot', severity: 'fail', org: 'dev-org' });
    expect(values).toHaveLength(1);
    const [ts, line] = values[0];
    expect(ts).toMatch(/^\d+000000$/); // ms epoch padded to nanoseconds
    const parsed = JSON.parse(line);
    expect(parsed).toEqual({ title: msg.title, severity: 'fail', text: msg.text, fields: msg.fields });
  });

  it('omits the org label and defaults severity to info when absent', () => {
    const payload = renderLoki({ title: 'T', text: 't', fields: [] }, {});
    expect(payload.streams[0].stream).toEqual({ source: 'sfdt', kind: 'notification', severity: 'info' });
  });
});

describe('renderMarkdown', () => {
  it('renders a GitHub-flavored markdown body with heading, fields, body, and footer', () => {
    const msg = snapshotMessage();
    const md = renderMarkdown(msg);
    const lines = md.split('\n');
    expect(lines[0]).toBe('### Audit report — dev-org');
    expect(md).toContain('- **Org:** dev-org');
    expect(md).toContain('- **Result:** 1 ok · 1 warn · 1 fail · 0 error');
    expect(md).toContain(msg.text);
    expect(lines.at(-1)).toBe(`_${msg.footer}_`);
  });

  it('renders only the heading when everything else is empty', () => {
    expect(renderMarkdown({ title: 'T', fields: [], text: '', footer: '' })).toBe('### T');
  });
});

describe('renderEmail', () => {
  it('prefixes the subject with the severity and includes facts in text and html', () => {
    const msg = snapshotMessage();
    const { subject, text, html } = renderEmail(msg);
    expect(subject).toBe('[FAIL] Audit report — dev-org');
    expect(text).toContain('Org: dev-org');
    expect(text).toContain(msg.text);
    expect(html).toContain('<li><b>Org:</b> dev-org</li>');
  });

  it('escapes HTML in the html body and drops the severity prefix when absent', () => {
    const { subject, html } = renderEmail({ title: '<b>T</b>', fields: [], text: 'a < b', footer: '' });
    expect(subject).toBe('<b>T</b>');
    expect(html).toContain('&lt;b&gt;T&lt;/b&gt;');
    expect(html).toContain('a &lt; b');
  });
});
