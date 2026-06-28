import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../../src/lib/config.js', () => ({ loadConfig: vi.fn() }));
vi.mock('../../src/lib/github-pr.js', () => ({ postPrComment: vi.fn() }));
vi.mock('fs-extra', () => ({
  default: { pathExists: vi.fn(), readJson: vi.fn(), readFile: vi.fn() },
}));
vi.mock('../../src/lib/output.js', () => ({
  print: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn(), header: vi.fn(), step: vi.fn() },
}));

import { loadConfig } from '../../src/lib/config.js';
import { postPrComment } from '../../src/lib/github-pr.js';
import fs from 'fs-extra';
import { registerPrCommand } from '../../src/commands/pr.js';

function run(args) {
  const program = new Command();
  program.exitOverride();
  registerPrCommand(program);
  return program.parseAsync(['node', 'sfdt', 'pr', ...args]);
}

beforeEach(() => {
  vi.resetAllMocks();
  process.exitCode = undefined;
  loadConfig.mockResolvedValue({ _projectRoot: '/p', logDir: '/p/logs' });
  postPrComment.mockResolvedValue({ ok: true });
});

describe('pr comment', () => {
  it('renders the monitor snapshot into a markdown comment', async () => {
    fs.pathExists.mockResolvedValue(true);
    fs.readJson.mockResolvedValue({
      org: 'dev',
      checks: [{ id: 'limits', title: 'Org limits', status: 'warn', summary: '1 limit high' }],
      summary: { ok: 0, warn: 1, fail: 0, error: 0 },
    });
    await run(['comment', '--type', 'monitor', '--json']);
    expect(postPrComment).toHaveBeenCalled();
    const body = postPrComment.mock.calls[0][0];
    expect(body).toContain('Monitor report');
  });

  it('posts inline --body text', async () => {
    await run(['comment', '--body', 'hello world', '--json']);
    expect(postPrComment).toHaveBeenCalledWith('hello world', expect.objectContaining({ cwd: '/p' }));
  });

  it('fails when the snapshot is missing', async () => {
    fs.pathExists.mockResolvedValue(false);
    await run(['comment', '--type', 'audit', '--json']);
    expect(process.exitCode).toBeGreaterThan(0);
    expect(postPrComment).not.toHaveBeenCalled();
  });

  it('sets a non-zero exit code when gh post fails', async () => {
    postPrComment.mockResolvedValue({ ok: false, error: 'no PR' });
    await run(['comment', '--body', 'x', '--json']);
    expect(process.exitCode).toBe(1);
  });
});
