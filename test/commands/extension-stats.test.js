import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

vi.mock('fs-extra', () => ({
  default: {
    pathExists: vi.fn(),
    readJson: vi.fn(),
  },
}));

vi.mock('../../src/lib/config.js', () => ({
  getConfigDir: vi.fn(),
}));

vi.mock('../../host/installers/install-host.js', () => ({
  installNativeHost: vi.fn(),
  uninstallNativeHost: vi.fn(),
  nativeHostStatus: vi.fn(),
}));

import fs from 'fs-extra';
import { getConfigDir } from '../../src/lib/config.js';
import {
  installNativeHost,
  uninstallNativeHost,
  nativeHostStatus,
} from '../../host/installers/install-host.js';
import { registerExtensionCommand } from '../../src/commands/extension.js';

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerExtensionCommand(program);
  return program;
}

beforeEach(() => {
  vi.resetAllMocks();
  process.exitCode = undefined;
  getConfigDir.mockReturnValue('/project/.sfdt');
});

describe('sfdt extension stats', () => {
  it('reports missing snapshot with exit code 1 when file absent', async () => {
    fs.pathExists.mockResolvedValue(false);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'extension', 'stats']);
    expect(process.exitCode).toBe(1);
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('No telemetry snapshot'))).toBe(true);
    logSpy.mockRestore();
  });

  it('--json reports missing snapshot as { ok: false, error }', async () => {
    fs.pathExists.mockResolvedValue(false);
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().parseAsync(['node', 'sfdt', 'extension', 'stats', '--json']);
    const parsed = JSON.parse(writeSpy.mock.calls[0][0]);
    expect(parsed.ok).toBe(false);
    expect(parsed.file).toBe('/project/.sfdt/telemetry-snapshot.json');
    writeSpy.mockRestore();
  });

  it('pretty-prints feature counts sorted by activations', async () => {
    fs.pathExists.mockResolvedValue(true);
    fs.readJson.mockResolvedValue({
      monthKey: '2026-05',
      writtenAt: '2026-05-17T00:00:00.000Z',
      counters: {
        'flow-deploy': { activated: 1, errored: 0, disabled_remote: 0 },
        'canvas-search': { activated: 5, errored: 1, disabled_remote: 0 },
      },
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'extension', 'stats']);
    const allOutput = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allOutput).toContain('2026-05');
    expect(allOutput).toContain('canvas-search');
    expect(allOutput).toContain('flow-deploy');
    // canvas-search (5 activations) should come before flow-deploy (1)
    const idxCS = allOutput.indexOf('canvas-search');
    const idxFD = allOutput.indexOf('flow-deploy');
    expect(idxCS).toBeLessThan(idxFD);
    logSpy.mockRestore();
  });

  it('--json mode returns the full snapshot envelope', async () => {
    const snapshot = {
      monthKey: '2026-05',
      writtenAt: '2026-05-17T00:00:00.000Z',
      counters: { 'canvas-search': { activated: 3, errored: 0, disabled_remote: 0 } },
    };
    fs.pathExists.mockResolvedValue(true);
    fs.readJson.mockResolvedValue(snapshot);
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().parseAsync(['node', 'sfdt', 'extension', 'stats', '--json']);
    const parsed = JSON.parse(writeSpy.mock.calls[0][0]);
    expect(parsed.ok).toBe(true);
    expect(parsed.file).toBe('/project/.sfdt/telemetry-snapshot.json');
    expect(parsed.monthKey).toBe('2026-05');
    expect(parsed.counters['canvas-search'].activated).toBe(3);
    writeSpy.mockRestore();
  });

  it('--limit caps the number of features displayed', async () => {
    fs.pathExists.mockResolvedValue(true);
    fs.readJson.mockResolvedValue({
      monthKey: '2026-05',
      counters: {
        a: { activated: 5, errored: 0, disabled_remote: 0 },
        b: { activated: 4, errored: 0, disabled_remote: 0 },
        c: { activated: 3, errored: 0, disabled_remote: 0 },
        d: { activated: 2, errored: 0, disabled_remote: 0 },
      },
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'extension', 'stats', '--limit', '2']);
    const allOutput = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allOutput).toContain('a ');
    expect(allOutput).toContain('b ');
    expect(allOutput).toContain('2 more');
    logSpy.mockRestore();
  });
});

describe('sfdt extension install-host', () => {
  it('installs the native host and pretty-prints per-browser results', async () => {
    installNativeHost.mockResolvedValue({
      ok: true,
      platform: 'darwin',
      hostPath: '/usr/local/bin/sfdt-host',
      results: [
        { browser: 'chrome', ok: true, manifestPath: '/Users/me/Library/Chrome/com.sfdt.host.json' },
        { browser: 'edge', ok: false, error: 'Edge not installed' },
      ],
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync([
      'node', 'sfdt', 'extension', 'install-host',
      '--extension-id', 'abcdefghijklmnopabcdefghijklmnop',
      '--browser', 'chrome',
    ]);
    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('Installed native host on darwin');
    expect(out).toContain('/usr/local/bin/sfdt-host');
    expect(out).toContain('chrome');
    expect(out).toContain('edge');
    expect(process.exitCode).toBeFalsy();
    logSpy.mockRestore();
  });

  it('--json mode emits the full result envelope', async () => {
    installNativeHost.mockResolvedValue({
      ok: true,
      platform: 'darwin',
      hostPath: '/usr/local/bin/sfdt-host',
      results: [{ browser: 'chrome', ok: true, manifestPath: '/m.json' }],
    });
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().parseAsync([
      'node', 'sfdt', 'extension', 'install-host',
      '--extension-id', 'abcdefghijklmnopabcdefghijklmnop',
      '--json',
    ]);
    const parsed = JSON.parse(writeSpy.mock.calls[0][0]);
    expect(parsed.ok).toBe(true);
    expect(parsed.platform).toBe('darwin');
    expect(parsed.results).toHaveLength(1);
    writeSpy.mockRestore();
  });

  it('reports installer failure with exit code 1', async () => {
    installNativeHost.mockResolvedValue({ ok: false, error: 'Permission denied' });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await createProgram().parseAsync([
      'node', 'sfdt', 'extension', 'install-host',
      '--extension-id', 'abcdefghijklmnopabcdefghijklmnop',
    ]);
    expect(process.exitCode).toBe(1);
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes('Permission denied'))).toBe(true);
    errSpy.mockRestore();
  });

  it('rejects an unsupported --browser value', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await createProgram().parseAsync([
      'node', 'sfdt', 'extension', 'install-host',
      '--extension-id', 'abcdefghijklmnopabcdefghijklmnop',
      '--browser', 'safari',
    ]);
    expect(process.exitCode).toBeGreaterThan(0);
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes('--browser must be one of'))).toBe(true);
    errSpy.mockRestore();
  });

  it('catches installer exceptions and emits JSON error when --json is set', async () => {
    installNativeHost.mockRejectedValue(new Error('disk full'));
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().parseAsync([
      'node', 'sfdt', 'extension', 'install-host',
      '--extension-id', 'abcdefghijklmnopabcdefghijklmnop',
      '--json',
    ]);
    const parsed = JSON.parse(writeSpy.mock.calls[0][0]);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe('disk full');
    writeSpy.mockRestore();
  });
});

describe('sfdt extension uninstall-host', () => {
  it('pretty-prints per-browser removal results', async () => {
    uninstallNativeHost.mockResolvedValue({
      platform: 'darwin',
      results: [
        { browser: 'chrome', removed: true, manifestPath: '/path/chrome.json' },
        { browser: 'edge', removed: false, reason: 'not installed' },
      ],
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'extension', 'uninstall-host']);
    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('Uninstalled native host on darwin');
    expect(out).toContain('chrome');
    expect(out).toContain('edge');
    expect(out).toContain('not installed');
    logSpy.mockRestore();
  });

  it('--json mode emits the result envelope', async () => {
    uninstallNativeHost.mockResolvedValue({
      platform: 'darwin',
      results: [{ browser: 'chrome', removed: true, manifestPath: '/m.json' }],
    });
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().parseAsync(['node', 'sfdt', 'extension', 'uninstall-host', '--json']);
    const parsed = JSON.parse(writeSpy.mock.calls[0][0]);
    expect(parsed.platform).toBe('darwin');
    expect(parsed.results[0].removed).toBe(true);
    writeSpy.mockRestore();
  });

  it('rejects an unsupported --browser value', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await createProgram().parseAsync([
      'node', 'sfdt', 'extension', 'uninstall-host', '--browser', 'firefox',
    ]);
    expect(process.exitCode).toBeGreaterThan(0);
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes('--browser must be one of'))).toBe(true);
    errSpy.mockRestore();
  });
});

describe('sfdt extension status', () => {
  it('pretty-prints installed and not-installed browsers', async () => {
    nativeHostStatus.mockResolvedValue({
      platform: 'darwin',
      browsers: [
        { browser: 'chrome', installed: true, manifestPath: '/path/chrome.json', hostPath: '/usr/local/bin/sfdt-host' },
        { browser: 'edge', installed: false },
      ],
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'extension', 'status']);
    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('Native host status — darwin');
    expect(out).toContain('chrome');
    expect(out).toContain('edge');
    expect(out).toContain('not installed');
    expect(out).toContain('launcher: /usr/local/bin/sfdt-host');
    logSpy.mockRestore();
  });

  it('--json mode emits the status envelope', async () => {
    nativeHostStatus.mockResolvedValue({
      platform: 'darwin',
      browsers: [{ browser: 'chrome', installed: false }],
    });
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().parseAsync(['node', 'sfdt', 'extension', 'status', '--json']);
    const parsed = JSON.parse(writeSpy.mock.calls[0][0]);
    expect(parsed.platform).toBe('darwin');
    expect(parsed.browsers[0].installed).toBe(false);
    writeSpy.mockRestore();
  });

  it('catches errors and reports them', async () => {
    nativeHostStatus.mockRejectedValue(new Error('boom'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'extension', 'status']);
    expect(process.exitCode).toBeGreaterThan(0);
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes('boom'))).toBe(true);
    errSpy.mockRestore();
  });
});
