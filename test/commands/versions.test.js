import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../../src/lib/config.js', () => ({ loadConfig: vi.fn() }));
vi.mock('../../src/lib/api-versions.js', () => ({
  scanLocalApiVersions: vi.fn(),
  fetchOrgApiVersions: vi.fn(),
  buildReport: vi.fn(),
}));

import { loadConfig } from '../../src/lib/config.js';
import { scanLocalApiVersions, fetchOrgApiVersions, buildReport } from '../../src/lib/api-versions.js';
import { registerVersionsCommand } from '../../src/commands/versions.js';

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerVersionsCommand(program);
  return program;
}

const LOCAL = { components: [], sourceApiVersion: '66.0' };
const REPORT = {
  thresholds: { minApiVersion: 45, warnBehind: 0, effectiveFloor: 45 },
  local: { sourceApiVersion: '66.0', totalComponents: 0, byType: {}, outliers: [], unspecified: 0 },
  org: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  loadConfig.mockResolvedValue({ _projectRoot: '/p', defaultOrg: 'dev', audit: {} });
  scanLocalApiVersions.mockResolvedValue(LOCAL);
  buildReport.mockReturnValue(REPORT);
});
afterEach(() => {
  process.exitCode = undefined;
});

describe('versions command', () => {
  it('runs local + org and emits the sf-native JSON envelope', async () => {
    fetchOrgApiVersions.mockResolvedValue({ ceiling: 67, release: "Summer '26", preview: false, byType: {}, degraded: [] });
    const logSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await createProgram().parseAsync(['node', 'sfdt', 'versions', '--json']);

    expect(fetchOrgApiVersions).toHaveBeenCalledWith('dev');
    const out = logSpy.mock.calls.map((c) => c[0]).join('');
    const envelope = JSON.parse(out);
    expect(envelope).toMatchObject({ status: 0, result: REPORT });
    expect(process.exitCode).toBeUndefined();
    logSpy.mockRestore();
  });

  it('--local-only never touches the org', async () => {
    await createProgram().parseAsync(['node', 'sfdt', 'versions', '--local-only']);
    expect(fetchOrgApiVersions).not.toHaveBeenCalled();
    expect(buildReport).toHaveBeenCalledWith(LOCAL, null, expect.any(Object));
  });

  it('--org overrides the configured default', async () => {
    fetchOrgApiVersions.mockResolvedValue({ ceiling: null, release: null, preview: false, byType: {}, degraded: [] });
    await createProgram().parseAsync(['node', 'sfdt', 'versions', '--org', 'uat']);
    expect(fetchOrgApiVersions).toHaveBeenCalledWith('uat');
  });

  it('degrades to a local-only report when the org is unreachable (exit 0)', async () => {
    fetchOrgApiVersions.mockRejectedValue(new Error('no such org'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await createProgram().parseAsync(['node', 'sfdt', 'versions']);

    expect(buildReport).toHaveBeenCalledWith(LOCAL, null, expect.any(Object));
    expect(errSpy.mock.calls.join('\n')).toContain('local-only report');
    expect(process.exitCode).toBeUndefined();
    errSpy.mockRestore();
  });

  it('passes the configured audit thresholds through', async () => {
    loadConfig.mockResolvedValue({
      _projectRoot: '/p',
      defaultOrg: null,
      audit: { minApiVersion: 50, apiVersionWarnBehind: 3 },
    });
    await createProgram().parseAsync(['node', 'sfdt', 'versions']);
    expect(buildReport).toHaveBeenCalledWith(LOCAL, null, { minApiVersion: 50, warnBehind: 3 });
  });

  it('emits the JSON error envelope with a nonzero exit on failure', async () => {
    loadConfig.mockRejectedValue(new Error('Run `sfdt init` first'));
    const logSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await createProgram().parseAsync(['node', 'sfdt', 'versions', '--json']);

    const envelope = JSON.parse(logSpy.mock.calls.map((c) => c[0]).join(''));
    expect(envelope.message).toContain('sfdt init');
    expect(envelope.exitCode).toBeGreaterThan(0);
    expect(process.exitCode).toBeGreaterThan(0);
    logSpy.mockRestore();
  });
});
