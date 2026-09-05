import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// nodemailer is lazy-imported inside the notifier; provide a mock so the email
// path is testable without the real dependency or a live SMTP server.
const sendMail = vi.fn().mockResolvedValue({ messageId: 'x' });
const createTransport = vi.fn(() => ({ sendMail }));
vi.mock('nodemailer', () => ({ default: { createTransport } }));

// ai/prompts are lazy-imported by the summary path; mock them so no real provider runs.
vi.mock('../../src/lib/ai.js', () => ({
  isAiAvailable: vi.fn().mockResolvedValue(true),
  runAiPrompt: vi.fn().mockResolvedValue({ stdout: 'AI EXEC SUMMARY' }),
}));
vi.mock('../../src/lib/prompts.js', () => ({
  getPrompt: vi.fn().mockResolvedValue('Summarize:'),
  interpolate: (t) => t,
}));

import {
  resolveChannels,
  notificationsConfigured,
  dispatch,
  dispatchSnapshot,
  describeChannels,
} from '../../src/lib/notifier.js';

beforeEach(() => {
  vi.resetAllMocks();
  createTransport.mockImplementation(() => ({ sendMail }));
  sendMail.mockResolvedValue({ messageId: 'x' });
});
afterEach(() => vi.unstubAllGlobals());

describe('resolveChannels', () => {
  it('returns modern channels when notifications.enabled is true', () => {
    const channels = resolveChannels({
      notifications: { enabled: true, channels: [{ type: 'slack', webhookUrl: 'u' }] },
    });
    expect(channels).toHaveLength(1);
    expect(channels[0].type).toBe('slack');
  });

  it('ignores modern channels when enabled is not true', () => {
    expect(resolveChannels({ notifications: { channels: [{ type: 'slack', webhookUrl: 'u' }] } })).toHaveLength(0);
  });

  it('synthesizes a legacy slack channel from notifications.slack', () => {
    const channels = resolveChannels({
      features: { notifications: true },
      notifications: { slack: { webhookUrl: 'https://hooks.slack.com/x' } },
    });
    expect(channels).toHaveLength(1);
    // Legacy channels are pinned to the original four lifecycle events — they must
    // NOT auto-opt-in to newer events (e.g. snapshot) via a null/all-events filter.
    expect(channels[0]).toMatchObject({
      type: 'slack',
      events: ['deploy-success', 'deploy-failure', 'test-failure', 'release-created'],
    });
  });

  it('does not opt a legacy slack channel into the snapshot event', async () => {
    const { dispatchSnapshot } = await import('../../src/lib/notifier.js');
    const results = await dispatchSnapshot(
      { org: 'x', checks: [{ id: 'a', status: 'warn' }], summary: {} },
      { features: { notifications: true }, notifications: { slack: { webhookUrl: 'https://hooks.slack.com/x' } } },
      { type: 'audit' },
    );
    // The legacy channel does not allow 'snapshot', so nothing is dispatched.
    expect(results.results).toHaveLength(0);
  });

  it('does not synthesize legacy slack when the feature flag is off', () => {
    expect(
      resolveChannels({ features: { notifications: false }, notifications: { slack: { webhookUrl: 'u' } } }),
    ).toHaveLength(0);
  });
});

describe('notificationsConfigured', () => {
  it('is false with no channels', () => {
    expect(notificationsConfigured({ features: {} })).toBe(false);
  });
});

describe('dispatch (events)', () => {
  const config = {
    notifications: {
      enabled: true,
      channels: [{ type: 'slack', name: 'team', webhookUrl: 'https://hooks.slack.com/x', events: ['deploy-failure'] }],
    },
  };

  it('sends to channels whose events filter allows the event', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const results = await dispatch('deploy-failure', { org: 'dev' }, config);
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith('https://hooks.slack.com/x', expect.objectContaining({ method: 'POST' }));
  });

  it('skips channels whose events filter excludes the event', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const results = await dispatch('deploy-success', { org: 'dev' }, config);
    expect(results).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('records an error result (without throwing) on a non-ok response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => 'invalid' });
    vi.stubGlobal('fetch', fetchMock);
    const results = await dispatch('deploy-failure', { org: 'dev' }, config);
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toContain('403');
  });

  it('resolves a webhook URL from an env var name', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    process.env.SFDT_TEST_HOOK = 'https://env.example.com/hook';
    const cfg = {
      notifications: { enabled: true, channels: [{ type: 'slack', webhookUrlEnv: 'SFDT_TEST_HOOK' }] },
    };
    await dispatch('deploy-success', {}, cfg);
    expect(fetchMock).toHaveBeenCalledWith('https://env.example.com/hook', expect.anything());
    delete process.env.SFDT_TEST_HOOK;
  });
});

describe('headersEnv', () => {
  const cfgWith = (channel) => ({
    notifications: { enabled: true, channels: [{ type: 'webhook', url: 'https://x.example/h', ...channel }] },
  });

  afterEach(() => {
    delete process.env.SFDT_TEST_HEADER;
  });

  it('resolves a header value from an env var name', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    process.env.SFDT_TEST_HEADER = 'super-secret-token';
    const results = await dispatch('deploy-success', {}, cfgWith({ headersEnv: { 'X-Token': 'SFDT_TEST_HEADER' } }));
    expect(results[0].ok).toBe(true);
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ 'X-Token': 'super-secret-token' });
  });

  it('fails the channel with a named error when the env var is unset', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const results = await dispatch('deploy-success', {}, cfgWith({ headersEnv: { 'X-Token': 'SFDT_TEST_HEADER' } }));
    // Silently dropping an auth header would surface as a 401 from the far end.
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toContain('SFDT_TEST_HEADER');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('takes precedence over a literal headers entry of the same name', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    process.env.SFDT_TEST_HEADER = 'from-env';
    await dispatch(
      'deploy-success',
      {},
      cfgWith({ headers: { 'X-Token': 'from-config' }, headersEnv: { 'X-Token': 'SFDT_TEST_HEADER' } }),
    );
    expect(fetchMock.mock.calls[0][1].headers['X-Token']).toBe('from-env');
  });

  it('leaves literal headers untouched when no headersEnv is set', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    await dispatch('deploy-success', {}, cfgWith({ headers: { 'X-Plain': 'literal' } }));
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ 'X-Plain': 'literal' });
  });

  it('never leaks a resolved header value through describeChannels', async () => {
    process.env.SFDT_TEST_HEADER = 'super-secret-token';
    const described = JSON.stringify(describeChannels(cfgWith({ headersEnv: { 'X-Token': 'SFDT_TEST_HEADER' } })));
    expect(described).not.toContain('super-secret-token');
    expect(described).not.toContain('SFDT_TEST_HEADER');
  });
});

describe('dispatch (googlechat)', () => {
  const config = {
    notifications: {
      enabled: true,
      channels: [
        { type: 'googlechat', name: 'chat', webhookUrl: 'https://chat.googleapis.com/v1/spaces/x/messages?key=k', events: ['deploy-failure'] },
      ],
    },
  };

  it('routes an allowed event to a googlechat channel with a { text } payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const results = await dispatch('deploy-failure', { org: 'dev', message: 'boom' }, config);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ channel: 'chat', type: 'googlechat', ok: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://chat.googleapis.com/v1/spaces/x/messages?key=k');
    const body = JSON.parse(init.body);
    expect(Object.keys(body)).toEqual(['text']);
    expect(body.text).toContain('*Deployment Failed*');
    expect(body.text).toContain('*Org:* dev');
    expect(body.text).toContain('boom');
  });

  it('honours the events filter for googlechat channels', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const results = await dispatch('deploy-success', { org: 'dev' }, config);
    expect(results).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves the googlechat webhook URL from an env var name', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    process.env.SFDT_TEST_GCHAT_HOOK = 'https://chat.googleapis.com/v1/spaces/env/messages';
    const cfg = {
      notifications: { enabled: true, channels: [{ type: 'googlechat', webhookUrlEnv: 'SFDT_TEST_GCHAT_HOOK' }] },
    };
    await dispatch('deploy-success', {}, cfg);
    expect(fetchMock).toHaveBeenCalledWith('https://chat.googleapis.com/v1/spaces/env/messages', expect.anything());
    delete process.env.SFDT_TEST_GCHAT_HOOK;
  });
});

describe('dispatchSnapshot (severity routing)', () => {
  const snapshot = {
    org: 'dev',
    checks: [
      { id: 'a', title: 'A', status: 'ok', summary: 'fine' },
      { id: 'b', title: 'B', status: 'warn', summary: 'careful' },
    ],
    summary: { ok: 1, warn: 1, fail: 0, error: 0 },
  };

  it('routes to channels at or below the snapshot severity', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const config = {
      notifications: {
        enabled: true,
        channels: [
          { type: 'slack', name: 'low', webhookUrl: 'u1', severityThreshold: 'warn', events: ['snapshot'] },
          { type: 'teams', name: 'high', webhookUrl: 'u2', severityThreshold: 'fail', events: ['snapshot'] },
        ],
      },
    };
    const { severity, results } = await dispatchSnapshot(snapshot, config, { type: 'monitor' });
    expect(severity).toBe('warn');
    expect(results.map((r) => r.channel)).toEqual(['low']); // 'high' (fail) filtered out
  });

  it('formats a Teams MessageCard for teams channels', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const config = {
      notifications: { enabled: true, channels: [{ type: 'teams', webhookUrl: 'u', severityThreshold: 'warn', events: ['snapshot'] }] },
    };
    await dispatchSnapshot(snapshot, config, { type: 'monitor' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body['@type']).toBe('MessageCard');
  });

  it('applies severityThreshold to googlechat channels and formats a text snapshot', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const config = {
      notifications: {
        enabled: true,
        channels: [
          { type: 'googlechat', name: 'low', webhookUrl: 'g1', severityThreshold: 'warn', events: ['snapshot'] },
          { type: 'googlechat', name: 'high', webhookUrl: 'g2', severityThreshold: 'fail', events: ['snapshot'] },
        ],
      },
    };
    const { results } = await dispatchSnapshot(snapshot, config, { type: 'audit' });
    expect(results.map((r) => r.channel)).toEqual(['low']); // 'high' (fail) filtered out
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.text).toContain('*Audit report — dev*');
    expect(body.text).toContain('careful');
  });

  it('shapes a Loki push payload for webhook format=loki', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const config = {
      notifications: {
        enabled: true,
        channels: [{ type: 'webhook', format: 'loki', url: 'http://loki/push', severityThreshold: 'warn', events: ['snapshot'] }],
      },
    };
    await dispatchSnapshot(snapshot, config, { type: 'monitor' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.streams[0].stream.org).toBe('dev');
    expect(Array.isArray(body.streams[0].values)).toBe(true);
  });

  it('replaces the body with an AI summary when notifications.summary.enabled', async () => {
    const { isAiAvailable, runAiPrompt } = await import('../../src/lib/ai.js');
    const { getPrompt } = await import('../../src/lib/prompts.js');
    isAiAvailable.mockResolvedValue(true);
    runAiPrompt.mockResolvedValue({ stdout: 'AI EXEC SUMMARY' });
    getPrompt.mockResolvedValue('Summarize:');
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const config = {
      features: { ai: true },
      notifications: {
        enabled: true,
        summary: { enabled: true },
        channels: [{ type: 'slack', webhookUrl: 'u', severityThreshold: 'warn', events: ['snapshot'] }],
      },
    };
    await dispatchSnapshot(snapshot, config, { type: 'monitor' });
    expect(runAiPrompt).toHaveBeenCalled();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(JSON.stringify(body)).toContain('AI EXEC SUMMARY');
  });

  it('falls back to the normal snapshot body when AI is unavailable', async () => {
    const { isAiAvailable } = await import('../../src/lib/ai.js');
    isAiAvailable.mockResolvedValue(false);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const config = {
      features: { ai: true },
      notifications: {
        enabled: true,
        summary: { enabled: true },
        channels: [{ type: 'slack', webhookUrl: 'u', severityThreshold: 'warn', events: ['snapshot'] }],
      },
    };
    await dispatchSnapshot(snapshot, config, { type: 'monitor' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(JSON.stringify(body)).not.toContain('AI EXEC SUMMARY');
  });

  it('redacts secrets in the Loki payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const leaky = {
      org: 'dev',
      checks: [{ id: 'a', title: 'A', status: 'warn', summary: 'token=00Dxx00000abcdEAA!secretvalue' }],
      summary: { ok: 0, warn: 1, fail: 0, error: 0 },
    };
    const config = {
      notifications: {
        enabled: true,
        channels: [{ type: 'webhook', format: 'loki', url: 'http://loki/push', severityThreshold: 'warn', events: ['snapshot'] }],
      },
    };
    await dispatchSnapshot(leaky, config, { type: 'monitor' });
    const raw = fetchMock.mock.calls[0][1].body;
    expect(raw).not.toContain('00Dxx00000abcdEAA!secretvalue');
  });

  it('sends email via the lazy nodemailer transport', async () => {
    const config = {
      notifications: {
        enabled: true,
        channels: [
          {
            type: 'email',
            from: 'ci@example.com',
            to: ['admin@example.com'],
            smtp: { hostEnv: 'SFDT_SMTP_HOST', portEnv: 'SFDT_SMTP_PORT' },
            severityThreshold: 'warn',
            events: ['snapshot'],
          },
        ],
      },
    };
    process.env.SFDT_SMTP_HOST = 'smtp.example.com';
    process.env.SFDT_SMTP_PORT = '587';
    const { results } = await dispatchSnapshot(snapshot, config, { type: 'monitor' });
    expect(results[0].ok).toBe(true);
    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({ host: 'smtp.example.com', port: 587 }));
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: 'admin@example.com' }));
    delete process.env.SFDT_SMTP_HOST;
    delete process.env.SFDT_SMTP_PORT;
  });
});

/**
 * Every rendered body leaves the machine over the network, so every renderer is
 * redacted — not just the `webhook` type. Slack, Teams and Google Chat were
 * left raw while the branch beside them carried a comment explaining exactly why
 * they should not be (sfdt-private#14, M2).
 */
describe('redaction covers every renderer, not just webhook', () => {
  const SECRET = 'force://PlatformCLI::5Aep861_REPLAYABLE_ORG_CREDENTIAL@example.my.salesforce.com';

  function cfgFor(type) {
    return {
      notifications: {
        enabled: true,
        channels: [{ type, name: type, webhookUrl: 'https://hooks.example.com/x' }],
      },
    };
  }

  it.each(['slack', 'teams', 'googlechat', 'webhook'])(
    'redacts an sfdx auth URL carried in the message for a %s channel',
    async (type) => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', fetchMock);

      const results = await dispatch(
        'deploy-failure',
        { org: 'dev', message: `Deploy failed. ${SECRET}` },
        cfgFor(type),
      );

      expect(results[0].ok).toBe(true);
      const sent = JSON.stringify(fetchMock.mock.calls[0][1].body);
      expect(sent).not.toContain('force://PlatformCLI');
      expect(sent).toContain('REDACTED');
    },
  );

  it('still sends a usable body — redaction replaces the secret, not the message', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    await dispatch('deploy-failure', { org: 'dev', message: 'Apex test AccountTest failed' }, cfgFor('slack'));

    const sent = JSON.stringify(fetchMock.mock.calls[0][1].body);
    expect(sent).toContain('AccountTest');
  });
});

describe('every channel redacts, email included (v0.24.0 security gate, H3)', () => {
  // `sendToChannel` used to redact per webhook shape, *below* the email branch —
  // and the email branch returns early. So email, the one channel that mails a
  // body out through the operator's own SMTP relay, sent raw org output, while
  // the comment above the webhook block claimed every body was redacted.
  const SECRET = '00Dxx00000abcdEAA!secretvalue';

  // The first cut of the H3 fix redacted `message` up front and dropped the
  // `redactSensitiveData(renderWebhook(...))` wrapper. But renderWebhook embeds
  // the raw `snapshot` argument and renderLoki the raw `org` — neither is part
  // of `message` — so webhook channels started shipping the full unredacted
  // checks[] array. Caught in review on PR #351. These assert every channel
  // type against the same snapshot so the gap cannot reopen for one of them.
  const CHANNELS = [
    ['webhook', { type: 'webhook', url: 'http://x/hook' }],
    ['loki',    { type: 'webhook', format: 'loki', url: 'http://x/loki' }],
    ['slack',   { type: 'slack', webhookUrl: 'http://x/slack' }],
    ['teams',   { type: 'teams', webhookUrl: 'http://x/teams' }],
    ['googlechat', { type: 'googlechat', webhookUrl: 'http://x/gchat' }],
  ];

  it.each(CHANNELS)('does not post a raw session id to a %s channel', async (_label, base) => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const leaky = {
      org: 'dev',
      checks: [{ id: 'a', title: 'A', status: 'warn', summary: `token=${SECRET}` }],
      summary: { ok: 0, warn: 1, fail: 0, error: 0 },
    };
    await dispatchSnapshot(leaky, {
      notifications: {
        enabled: true,
        channels: [{ ...base, severityThreshold: 'warn', events: ['snapshot'] }],
      },
    }, { type: 'monitor' });
    expect(fetchMock).toHaveBeenCalled();
    expect(String(fetchMock.mock.calls[0][1].body)).not.toContain(SECRET);
  });

  it('does not mail a raw session id', async () => {
    sendMail.mockClear();
    const leaky = {
      org: 'dev',
      checks: [{ id: 'a', title: 'A', status: 'warn', summary: `token=${SECRET}` }],
      summary: { ok: 0, warn: 1, fail: 0, error: 0 },
    };
    const config = {
      notifications: {
        enabled: true,
        channels: [{
          type: 'email',
          from: 'ci@example.com',
          to: ['admin@example.com'],
          smtp: { hostEnv: 'SFDT_SMTP_HOST', portEnv: 'SFDT_SMTP_PORT' },
          severityThreshold: 'warn',
          events: ['snapshot'],
        }],
      },
    };
    process.env.SFDT_SMTP_HOST = 'smtp.example.com';
    process.env.SFDT_SMTP_PORT = '587';
    await dispatchSnapshot(leaky, config, { type: 'monitor' });
    expect(sendMail).toHaveBeenCalled();
    expect(JSON.stringify(sendMail.mock.calls[0][0])).not.toContain(SECRET);
  });
});

describe('webhook redirects are refused (issue #21)', () => {
  // undici follows by default, and 307/308 preserve method AND body — so a
  // configured host answering `307 Location: https://attacker.example` receives
  // the notification body plus any headersEnv gateway token. undici strips
  // Authorization cross-origin but not custom headers. This defeats
  // config-trust's URL check rather than merely lacking depth: that validates
  // the configured URL and has no say over a redirect target.
  beforeEach(() => { process.env.GW_TOKEN = 'gateway-secret'; });
  afterEach(() => { delete process.env.GW_TOKEN; });

  it.each([301, 302, 307, 308])('refuses HTTP %i instead of resending the body', async (status) => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false, status,
      headers: { get: () => 'https://attacker.example/collect' },
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchMock);

    const results = await dispatch(
      'snapshot',
      { message: 'B' },
      { notifications: { enabled: true, channels: [
        { type: 'webhook', url: 'http://relay.example/hook', headersEnv: { 'X-Api-Key': 'GW_TOKEN' } },
      ] } },
    );

    expect(results[0].ok).toBe(false);
    expect(results[0].error).toMatch(/redirected/i);
    // one attempt only — the point is that the body never reaches the second host
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].redirect).toBe('manual');
    // The gateway token WAS on the first request — which is the whole point:
    // following the redirect would have re-sent it to the attacker's host.
    expect(fetchMock.mock.calls[0][1].headers['X-Api-Key']).toBe('gateway-secret');
  });
});
