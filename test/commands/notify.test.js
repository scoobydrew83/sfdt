import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../../src/lib/config.js', () => ({
  loadConfig: vi.fn(),
}));

vi.mock('../../src/lib/output.js', () => ({
  print: {
    header: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    step: vi.fn(),
  },
}));

import { loadConfig } from '../../src/lib/config.js';
import { print } from '../../src/lib/output.js';
import { registerNotifyCommand } from '../../src/commands/notify.js';

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerNotifyCommand(program);
  return program;
}

beforeEach(() => {
  vi.resetAllMocks();
  process.exitCode = undefined;
  loadConfig.mockResolvedValue({
    _projectRoot: '/project',
    defaultOrg: 'dev',
    projectName: 'My App',
    features: { notifications: true },
    notifications: {
      slack: { webhookUrl: 'https://hooks.slack.com/test' },
    },
  });
});

describe('notify command', () => {
  it('rejects unknown events', async () => {
    await createProgram().parseAsync(['node', 'sfdt', 'notify', 'unknown-event']);

    expect(print.error).toHaveBeenCalledWith(expect.stringContaining('Unknown event'));
    expect(process.exitCode).toBe(1);
  });

  it('warns when slack is not configured', async () => {
    loadConfig.mockResolvedValue({
      _projectRoot: '/project',
      features: { notifications: false },
    });

    await createProgram().parseAsync(['node', 'sfdt', 'notify', 'deploy-success']);

    expect(print.warning).toHaveBeenCalledWith(expect.stringContaining('not configured'));
    expect(process.exitCode).toBe(1);
  });

  it('sends notification to Slack on valid event', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    await createProgram().parseAsync([
      'node',
      'sfdt',
      'notify',
      'deploy-success',
      '--version',
      '1.0.0',
      '--message',
      'Deployed to prod',
    ]);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://hooks.slack.com/test',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.blocks[0].text.text).toContain('Deployment Successful');
    expect(print.success).toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('handles Slack API errors', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => 'invalid_token',
    });
    vi.stubGlobal('fetch', mockFetch);

    await createProgram().parseAsync(['node', 'sfdt', 'notify', 'deploy-failure']);

    expect(print.error).toHaveBeenCalledWith(expect.stringContaining('403'));
    expect(process.exitCode).toBe(1);

    vi.unstubAllGlobals();
  });

  it('includes org and version fields in payload', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    await createProgram().parseAsync([
      'node',
      'sfdt',
      'notify',
      'release-created',
      '--version',
      '2.0.0',
      '--org',
      'prod',
    ]);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const sectionFields = body.blocks[1].fields;
    const fieldTexts = sectionFields.map((f) => f.text);

    expect(fieldTexts).toEqual(
      expect.arrayContaining([expect.stringContaining('prod'), expect.stringContaining('2.0.0')]),
    );

    vi.unstubAllGlobals();
  });
});
