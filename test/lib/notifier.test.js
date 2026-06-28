import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// nodemailer is lazy-imported inside the notifier; provide a mock so the email
// path is testable without the real dependency or a live SMTP server.
const sendMail = vi.fn().mockResolvedValue({ messageId: 'x' });
const createTransport = vi.fn(() => ({ sendMail }));
vi.mock('nodemailer', () => ({ default: { createTransport } }));

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
    expect(channels[0]).toMatchObject({ type: 'slack', events: null });
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
