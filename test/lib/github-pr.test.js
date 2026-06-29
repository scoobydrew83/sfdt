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
