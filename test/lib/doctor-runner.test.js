import { describe, it, expect, vi, beforeEach } from 'vitest';

const isToolAvailableSpy = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/tool-check.js', () => ({ isToolAvailable: isToolAvailableSpy }));

const execaSpy = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({ execa: execaSpy }));

const pathExistsSpy = vi.hoisted(() => vi.fn());
const getConfigDirSpy = vi.hoisted(() => vi.fn());
const validateConfigSpy = vi.hoisted(() => vi.fn());
const loadConfigSpy = vi.hoisted(() => vi.fn());
const isAiAvailableSpy = vi.hoisted(() => vi.fn());

vi.mock('fs-extra', () => ({ default: { pathExists: pathExistsSpy } }));
vi.mock('../../src/lib/config.js', () => ({
  getConfigDir: getConfigDirSpy,
  validateConfig: validateConfigSpy,
  loadConfig: loadConfigSpy,
}));
vi.mock('../../src/lib/ai.js', () => ({
  isAiAvailable: isAiAvailableSpy,
  aiUnavailableMessage: () => 'Claude Code CLI not installed',
}));

const checkOrgInfoSpy = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/monitor-runner.js', () => ({ checkOrgInfo: checkOrgInfoSpy }));

import { checkSf, checkNode, checkGit, checkConfig, checkAi, checkOrg, runCoreDoctor } from '../../src/lib/doctor-runner.js';

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

describe('checkConfig', () => {
  it('warn when no .sfdt/ project is found', async () => {
    getConfigDirSpy.mockImplementation(() => { throw new Error('no project'); });
    const r = await checkConfig(null, new Error('no project'));
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/sfdt init/);
  });
  it('warn when config.json is absent (not initialized)', async () => {
    getConfigDirSpy.mockReturnValue('/proj/.sfdt');
    pathExistsSpy.mockResolvedValue(false);
    expect((await checkConfig(null, new Error('not found'))).status).toBe('warn');
  });
  it('fail when config.json exists but failed to load', async () => {
    getConfigDirSpy.mockReturnValue('/proj/.sfdt');
    pathExistsSpy.mockResolvedValue(true);
    const r = await checkConfig(null, new Error('Failed to parse config.json'));
    expect(r.status).toBe('fail');
  });
  it('fail when config loaded but is schema-invalid', async () => {
    getConfigDirSpy.mockReturnValue('/proj/.sfdt');
    pathExistsSpy.mockResolvedValue(true);
    validateConfigSpy.mockImplementation(() => { throw new Error('unknown key "foo"'); });
    expect((await checkConfig({ any: 'thing' }, null)).status).toBe('fail');
  });
  it('ok when config is present and valid', async () => {
    getConfigDirSpy.mockReturnValue('/proj/.sfdt');
    pathExistsSpy.mockResolvedValue(true);
    validateConfigSpy.mockReturnValue(undefined);
    expect((await checkConfig({ any: 'thing' }, null)).status).toBe('ok');
  });
});

describe('checkAi', () => {
  it('warn when AI features are disabled', async () => {
    const r = await checkAi({ features: { ai: false } });
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/disabled/i);
  });
  it('warn when config is unavailable', async () => {
    expect((await checkAi(null)).status).toBe('warn');
  });
  it('ok when AI is enabled and the provider is available', async () => {
    isAiAvailableSpy.mockResolvedValue(true);
    expect((await checkAi({ features: { ai: true } })).status).toBe('ok');
  });
  it('warn with the provider message when AI is enabled but unavailable', async () => {
    isAiAvailableSpy.mockResolvedValue(false);
    const r = await checkAi({ features: { ai: true } });
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/not installed/);
  });
});

describe('checkOrg', () => {
  it('warn when no org alias is available', async () => {
    const r = await checkOrg(undefined, 1000);
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/no default org|--org/i);
  });
  it('ok when checkOrgInfo reports ok', async () => {
    checkOrgInfoSpy.mockResolvedValue({ status: 'ok', summary: 'Production on NA123' });
    const r = await checkOrg('myOrg', 1000);
    expect(r.status).toBe('ok');
    expect(r.detail).toContain('NA123');
  });
  it('forwards timeoutMs to checkOrgInfo so the sf subprocess is bounded too', async () => {
    checkOrgInfoSpy.mockResolvedValue({ status: 'ok', summary: 'Production on NA123' });
    await checkOrg('myOrg', 1234);
    expect(checkOrgInfoSpy).toHaveBeenCalledWith('myOrg', { timeoutMs: 1234 });
  });
  it('downgrades a checkOrgInfo error to warn (never fail)', async () => {
    checkOrgInfoSpy.mockResolvedValue({ status: 'error', summary: 'No authorized org' });
    expect((await checkOrg('myOrg', 1000)).status).toBe('warn');
  });
  it('warn on timeout when checkOrgInfo hangs', async () => {
    checkOrgInfoSpy.mockImplementation(() => new Promise(() => {})); // never resolves
    const r = await checkOrg('myOrg', 20);
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/timed out/i);
  });
  it('clears the timeout timer when checkOrgInfo resolves first (no dangling handle)', async () => {
    vi.useFakeTimers();
    try {
      checkOrgInfoSpy.mockResolvedValue({ status: 'ok', summary: 'Prod' });
      await checkOrg('myOrg', 5000);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('runCoreDoctor', () => {
  it('returns six results and ok=false when any check fails', async () => {
    loadConfigSpy.mockResolvedValue({ defaultOrg: 'myOrg', features: { ai: false } });
    getConfigDirSpy.mockReturnValue('/proj/.sfdt');
    pathExistsSpy.mockResolvedValue(true);
    validateConfigSpy.mockReturnValue(undefined);
    isToolAvailableSpy.mockResolvedValue({ available: false, version: null }); // sf+git fail
    execaSpy.mockResolvedValue({ exitCode: 0, stdout: 'true', stderr: '' });
    checkOrgInfoSpy.mockResolvedValue({ status: 'ok', summary: 'Prod' });

    const { results, ok } = await runCoreDoctor({ timeoutMs: 50 });
    expect(results).toHaveLength(6);
    expect(ok).toBe(false); // sf absent → fail
  });

  it('ok=true when nothing fails (warns allowed)', async () => {
    loadConfigSpy.mockResolvedValue({ defaultOrg: 'myOrg', features: { ai: false } });
    getConfigDirSpy.mockReturnValue('/proj/.sfdt');
    pathExistsSpy.mockResolvedValue(true);
    validateConfigSpy.mockReturnValue(undefined);
    isToolAvailableSpy.mockResolvedValue({ available: true, version: 'x/1.2.3' });
    execaSpy.mockResolvedValue({ exitCode: 0, stdout: 'true', stderr: '' });
    checkOrgInfoSpy.mockResolvedValue({ status: 'ok', summary: 'Prod' });

    const { ok } = await runCoreDoctor({ timeoutMs: 50 });
    expect(ok).toBe(true);
  });
});
