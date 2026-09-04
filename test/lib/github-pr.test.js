import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('execa', () => ({ execa: vi.fn() }));
import { execa } from 'execa';
import { isGhAvailable, postPrComment } from '../../src/lib/github-pr.js';

beforeEach(() => vi.resetAllMocks());

describe('isGhAvailable', () => {
  it('is true when gh --version succeeds', async () => {
    execa.mockResolvedValueOnce({ stdout: 'gh version 2.0.0' });
    expect(await isGhAvailable()).toBe(true);
  });
  it('is false when gh is missing', async () => {
    execa.mockRejectedValueOnce(new Error('command not found: gh'));
    expect(await isGhAvailable()).toBe(false);
  });
});

describe('postPrComment', () => {
  it('refuses an empty body', async () => {
    const r = await postPrComment('   ');
    expect(r.ok).toBe(false);
    expect(execa).not.toHaveBeenCalled();
  });

  it('errors clearly when gh is unavailable', async () => {
    execa.mockRejectedValueOnce(new Error('not found')); // isGhAvailable
    const r = await postPrComment('hello');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/gh CLI not found/);
  });

  it('posts the comment via gh pr comment', async () => {
    execa
      .mockResolvedValueOnce({ stdout: 'gh version 2.0.0' }) // isGhAvailable
      .mockResolvedValueOnce({ stdout: 'https://github.com/x/y/pull/1#comment' }); // post
    const r = await postPrComment('hello', { pr: '42', cwd: '/p' });
    expect(r.ok).toBe(true);
    expect(execa).toHaveBeenLastCalledWith('gh', ['pr', 'comment', '42', '--body', 'hello'], { cwd: '/p' });
  });

  it('returns the gh error on failure', async () => {
    execa
      .mockResolvedValueOnce({ stdout: 'gh version 2.0.0' })
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { stderr: 'no PR found' }));
    const r = await postPrComment('hello');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no PR found/);
  });
});

describe('postPrComment is scoped to this repo and redacts (v0.24.0 security gate, H4)', () => {
  // `gh pr comment <ref>` accepts a full URL, and a URL names a *repository*.
  // The MCP tool sfdt_pr_comment passes a model-chosen value straight through,
  // so an injected model could post an org snapshot into a repo the operator
  // does not own, under the operator's own GitHub identity.
  const okGh = () => execa.mockResolvedValueOnce({ stdout: 'gh version 2.0.0' });

  it.each([
    'https://github.com/attacker/evil/pull/1',
    'attacker/evil#1',
    '1 --repo attacker/evil',
    '../../attacker/evil/pull/1',
  ])('refuses the cross-repo reference %j without invoking gh', async (pr) => {
    okGh();
    const res = await postPrComment('body', { pr });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/invalid PR reference/);
    // gh was called once for the availability probe, never for the comment.
    expect(execa).toHaveBeenCalledTimes(1);
  });

  it('accepts a bare PR number', async () => {
    okGh();
    execa.mockResolvedValueOnce({ stdout: 'posted' });
    const res = await postPrComment('body', { pr: '142' });
    expect(res.ok).toBe(true);
    expect(execa.mock.calls[1][1]).toEqual(['pr', 'comment', '142', '--body', 'body']);
  });

  it('redacts the snapshot body before it reaches GitHub', async () => {
    const SECRET = '00Dxx00000abcdEAA!secretvalue';
    okGh();
    execa.mockResolvedValueOnce({ stdout: 'posted' });
    await postPrComment(`monitor found token=${SECRET}`, {});
    expect(execa.mock.calls[1][1].join(' ')).not.toContain(SECRET);
  });
});
