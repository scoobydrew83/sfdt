import { describe, it, expect, vi, beforeEach } from 'vitest';

const isToolAvailableSpy = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/tool-check.js', () => ({ isToolAvailable: isToolAvailableSpy }));

const execaSpy = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({ execa: execaSpy }));

import { checkSf, checkNode, checkGit } from '../../src/lib/doctor-runner.js';

beforeEach(() => vi.resetAllMocks());

describe('checkSf', () => {
  it('ok when sf is present', async () => {
    isToolAvailableSpy.mockResolvedValue({ available: true, version: '@salesforce/cli/2.100.0' });
    const r = await checkSf();
    expect(r.name).toBe('sf CLI');
    expect(r.status).toBe('ok');
    expect(r.detail).toContain('2.100.0');
  });
  it('warn when present but version is unparseable', async () => {
    isToolAvailableSpy.mockResolvedValue({ available: true, version: null });
    expect((await checkSf()).status).toBe('warn');
  });
  it('fail when sf is absent', async () => {
    isToolAvailableSpy.mockResolvedValue({ available: false, version: null });
    const r = await checkSf();
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/not found|install/i);
  });
});

describe('checkNode', () => {
  it('ok when the running node satisfies the engines floor', async () => {
    // The test process runs node >=22.15.0 (repo engines), so this is ok here.
    expect((await checkNode()).status).toBe('ok');
  });
});

describe('checkGit', () => {
  it('ok when git is present and inside a repo', async () => {
    isToolAvailableSpy.mockResolvedValue({ available: true, version: 'git version 2.44' });
    execaSpy.mockResolvedValue({ exitCode: 0, stdout: 'true', stderr: '' });
    expect((await checkGit()).status).toBe('ok');
  });
  it('warn when git is present but not inside a repo', async () => {
    isToolAvailableSpy.mockResolvedValue({ available: true, version: 'git version 2.44' });
    execaSpy.mockResolvedValue({ exitCode: 128, stdout: '', stderr: 'not a git repository' });
    expect((await checkGit()).status).toBe('warn');
  });
  it('fail when git is absent', async () => {
    isToolAvailableSpy.mockResolvedValue({ available: false, version: null });
    expect((await checkGit()).status).toBe('fail');
  });
});
