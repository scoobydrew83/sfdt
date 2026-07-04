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
