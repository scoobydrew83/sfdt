import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

import { execa } from 'execa';
import { isSafeGitRef, resolveBaseRef, diffNameStatus } from '../../src/lib/git-utils.js';

beforeEach(() => {
  vi.resetAllMocks();
});

describe('isSafeGitRef', () => {
  it('accepts branch names, SHAs, and rev syntax', () => {
    expect(isSafeGitRef('main')).toBe(true);
    expect(isSafeGitRef('feature/my-branch')).toBe(true);
    expect(isSafeGitRef('v1.2.3')).toBe(true);
    expect(isSafeGitRef('abc1234')).toBe(true);
    expect(isSafeGitRef('HEAD~2')).toBe(true);
    expect(isSafeGitRef('main@{upstream}')).toBe(true);
  });

  it('rejects refs starting with "-" (git option flags)', () => {
    expect(isSafeGitRef('--output=/tmp/x')).toBe(false);
    expect(isSafeGitRef('-c')).toBe(false);
  });

  it('rejects shell metacharacters, whitespace, and non-strings', () => {
    expect(isSafeGitRef('main; rm -rf /')).toBe(false);
    expect(isSafeGitRef('$(whoami)')).toBe(false);
    expect(isSafeGitRef('main head')).toBe(false);
    expect(isSafeGitRef('')).toBe(false);
    expect(isSafeGitRef(undefined)).toBe(false);
    expect(isSafeGitRef(null)).toBe(false);
  });
});

describe('resolveBaseRef', () => {
  it('returns commit SHAs as-is without invoking git', async () => {
    const sha = 'a'.repeat(40);
    expect(await resolveBaseRef(sha, 'HEAD', '/repo')).toBe(sha);
    expect(await resolveBaseRef('abc1234', 'HEAD', '/repo')).toBe('abc1234');
    expect(execa).not.toHaveBeenCalled();
  });

  it('returns the merge-base when git resolves one', async () => {
    execa.mockResolvedValueOnce({ exitCode: 0, stdout: 'deadbee\n' });
    const result = await resolveBaseRef('main', 'HEAD', '/repo');
    expect(execa).toHaveBeenCalledWith(
      'git',
      ['merge-base', 'main', 'HEAD'],
      { cwd: '/repo', reject: false },
    );
    expect(result).toBe('deadbee');
  });

  it('falls back to the base ref when merge-base fails', async () => {
    execa.mockResolvedValueOnce({ exitCode: 1, stdout: '' });
    expect(await resolveBaseRef('main', 'HEAD', '/repo')).toBe('main');
  });
});

describe('diffNameStatus', () => {
  it('runs git diff --name-status scoped to the given paths', async () => {
    execa.mockResolvedValueOnce({ exitCode: 0, stdout: 'M\tforce-app/x', stderr: '' });
    const result = await diffNameStatus('main', 'HEAD', ['force-app/'], '/repo');
    expect(execa).toHaveBeenCalledWith(
      'git',
      ['diff', '--name-status', 'main', 'HEAD', '--', 'force-app/'],
      { cwd: '/repo', reject: false },
    );
    expect(result.stdout).toContain('force-app/x');
  });
});
