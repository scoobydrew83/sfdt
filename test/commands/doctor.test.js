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
  nativeHostStatus: vi.fn(),
}));

vi.mock('../../src/lib/doctor-runner.js', () => ({
  runCoreDoctor: vi.fn(),
}));

import fs from 'fs-extra';
import { getConfigDir } from '../../src/lib/config.js';
import { nativeHostStatus } from '../../host/installers/install-host.js';
import { runCoreDoctor } from '../../src/lib/doctor-runner.js';
import {
  registerDoctorCommand,
  runExtensionDoctor,
} from '../../src/commands/doctor.js';

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerDoctorCommand(program);
  return program;
}

function mockFetchOk(body, status = 200) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
}

function mockFetchThrows(err = new Error('connect ECONNREFUSED')) {
  return vi.fn(async () => {
    throw err;
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  process.exitCode = undefined;
  getConfigDir.mockReturnValue('/project/.sfdt');
  fs.pathExists.mockResolvedValue(false);
  nativeHostStatus.mockResolvedValue({ platform: 'darwin', browsers: [] });
  runCoreDoctor.mockResolvedValue({
    ok: true,
    results: [{ name: 'sf CLI', status: 'ok', detail: 'Present' }],
  });
});

describe('runExtensionDoctor', () => {
  it('passes the bridge ping check when /api/bridge/ping returns ok', async () => {
    const fetchImpl = mockFetchOk({
      ok: true,
      data: { serverVersion: '0.8.1', protocolVersion: '1.2' },
    });
    const { results, ok } = await runExtensionDoctor({ port: 7654, fetchImpl });
    const bridge = results.find((r) => r.name === 'sfdt ui bridge');
    expect(bridge.status).toBe('ok');
    expect(bridge.detail).toContain('0.8.1');
    expect(bridge.detail).toContain('1.2');
    expect(ok).toBe(true);
  });

  it('fails the bridge ping check when the bridge is unreachable', async () => {
    const fetchImpl = mockFetchThrows();
    const { results, ok } = await runExtensionDoctor({ port: 7654, fetchImpl });
    const bridge = results.find((r) => r.name === 'sfdt ui bridge');
    expect(bridge.status).toBe('fail');
    expect(bridge.detail).toContain('sfdt ui');
    expect(ok).toBe(false);
  });

  it('warns (not fails) when no native host is installed', async () => {
    nativeHostStatus.mockResolvedValue({
      platform: 'darwin',
      browsers: [{ browser: 'chrome', installed: false }],
    });
    const { results } = await runExtensionDoctor({
      port: 7654,
      fetchImpl: mockFetchOk({ ok: true, data: {} }),
    });
    const host = results.find((r) => r.name === 'native messaging host');
    expect(host.status).toBe('warn');
  });

  it('passes when feature-flags.json is absent (default state)', async () => {
    fs.pathExists.mockImplementation(async (p) => false);
    const { results } = await runExtensionDoctor({
      port: 7654,
      fetchImpl: mockFetchOk({ ok: true, data: {} }),
    });
    const ff = results.find((r) => r.name === 'feature-flags.json');
    expect(ff.status).toBe('ok');
    expect(ff.detail).toContain('Not present');
  });

  it('fails when feature-flags.json is malformed', async () => {
    fs.pathExists.mockImplementation(async (p) => p.endsWith('feature-flags.json'));
    fs.readJson.mockImplementation(async (p) => {
      if (p.endsWith('feature-flags.json')) {
        throw new Error('Unexpected token { in JSON');
      }
      return {};
    });
    const { results, ok } = await runExtensionDoctor({
      port: 7654,
      fetchImpl: mockFetchOk({ ok: true, data: {} }),
    });
    const ff = results.find((r) => r.name === 'feature-flags.json');
    expect(ff.status).toBe('fail');
    expect(ok).toBe(false);
  });

  it('warns when telemetry-snapshot.json is absent', async () => {
    const { results } = await runExtensionDoctor({
      port: 7654,
      fetchImpl: mockFetchOk({ ok: true, data: {} }),
    });
    const tel = results.find((r) => r.name === 'telemetry-snapshot.json');
    expect(tel.status).toBe('warn');
  });

  it('fails when feature-flags.json is missing the "disabled" array', async () => {
    fs.pathExists.mockImplementation(async (p) => p.endsWith('feature-flags.json'));
    fs.readJson.mockImplementation(async (p) => {
      if (p.endsWith('feature-flags.json')) return { somethingElse: true };
      return {};
    });
    const { results, ok } = await runExtensionDoctor({
      port: 7654,
      fetchImpl: mockFetchOk({ ok: true, data: {} }),
    });
    const ff = results.find((r) => r.name === 'feature-flags.json');
    expect(ff.status).toBe('fail');
    expect(ff.detail).toContain('disabled');
    expect(ok).toBe(false);
  });

  it('passes and lists disabled features when feature-flags.json is valid', async () => {
    fs.pathExists.mockImplementation(async (p) => p.endsWith('feature-flags.json'));
    fs.readJson.mockImplementation(async (p) => {
      if (p.endsWith('feature-flags.json')) return { disabled: ['canvas-search', 'apex-log'] };
      return {};
    });
    const { results } = await runExtensionDoctor({
      port: 7654,
      fetchImpl: mockFetchOk({ ok: true, data: {} }),
    });
    const ff = results.find((r) => r.name === 'feature-flags.json');
    expect(ff.status).toBe('ok');
    expect(ff.detail).toContain('canvas-search');
  });

  it('warns when nativeHostStatus throws', async () => {
    nativeHostStatus.mockRejectedValue(new Error('registry error'));
    const { results } = await runExtensionDoctor({
      port: 7654,
      fetchImpl: mockFetchOk({ ok: true, data: {} }),
    });
    const host = results.find((r) => r.name === 'native messaging host');
    expect(host.status).toBe('warn');
    expect(host.detail).toContain('registry error');
  });

  it('passes the native host check when at least one browser has it installed', async () => {
    nativeHostStatus.mockResolvedValue({
      platform: 'darwin',
      browsers: [{ browser: 'chrome', installed: true }, { browser: 'edge', installed: false }],
    });
    const { results } = await runExtensionDoctor({
      port: 7654,
      fetchImpl: mockFetchOk({ ok: true, data: {} }),
    });
    const host = results.find((r) => r.name === 'native messaging host');
    expect(host.status).toBe('ok');
    expect(host.detail).toContain('chrome');
  });

  it('fails the bridge check on a non-2xx HTTP status', async () => {
    const { results } = await runExtensionDoctor({
      port: 7654,
      fetchImpl: mockFetchOk({}, 503),
    });
    const bridge = results.find((r) => r.name === 'sfdt ui bridge');
    expect(bridge.status).toBe('fail');
    expect(bridge.detail).toContain('503');
  });

  it('fails telemetry check when the snapshot is unreadable', async () => {
    fs.pathExists.mockImplementation(async (p) => p.endsWith('telemetry-snapshot.json'));
    fs.readJson.mockImplementation(async (p) => {
      if (p.endsWith('telemetry-snapshot.json')) throw new Error('corrupt json');
      return {};
    });
    const { results, ok } = await runExtensionDoctor({
      port: 7654,
      fetchImpl: mockFetchOk({ ok: true, data: {} }),
    });
    const tel = results.find((r) => r.name === 'telemetry-snapshot.json');
    expect(tel.status).toBe('fail');
    expect(ok).toBe(false);
  });

  it('passes telemetry check when snapshot is present', async () => {
    fs.pathExists.mockImplementation(async (p) => p.endsWith('telemetry-snapshot.json'));
    fs.readJson.mockImplementation(async (p) => {
      if (p.endsWith('telemetry-snapshot.json')) {
        return {
          monthKey: '2026-05',
          writtenAt: '2026-05-17T00:00:00Z',
          counters: { 'canvas-search': { activated: 1, errored: 0, disabled_remote: 0 } },
        };
      }
      return {};
    });
    const { results } = await runExtensionDoctor({
      port: 7654,
      fetchImpl: mockFetchOk({ ok: true, data: {} }),
    });
    const tel = results.find((r) => r.name === 'telemetry-snapshot.json');
    expect(tel.status).toBe('ok');
    expect(tel.detail).toContain('2026-05');
  });
});

describe('sfdt doctor command wiring', () => {
  it('--json emits a structured result with ok/results', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    // Stub fetch so the bridge check doesn't actually try to hit localhost
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetchOk({
      ok: true,
      data: { serverVersion: 'X', protocolVersion: 'Y' },
    });
    try {
      await createProgram().parseAsync(['node', 'sfdt', 'doctor', '--extension', '--json']);
    } finally {
      globalThis.fetch = originalFetch;
    }
    const out = writeSpy.mock.calls.map((c) => c[0]).join('');
    const parsed = JSON.parse(out);
    expect(parsed.status).toBe(0);
    expect(parsed.result.ok).toBe(true);
    expect(parsed.result.results).toHaveLength(4);
    expect(parsed.result.results.map((r) => r.name)).toContain('sfdt ui bridge');
    writeSpy.mockRestore();
  });

  it('sets exitCode 1 when any check fails (--json)', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetchThrows();
    try {
      await createProgram().parseAsync(['node', 'sfdt', 'doctor', '--extension', '--json']);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(process.exitCode).toBe(1);
    writeSpy.mockRestore();
  });

  it('pretty-prints results when --json is not set, with the extension stack header', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetchOk({
      ok: true,
      data: { serverVersion: 'X', protocolVersion: 'Y' },
    });
    try {
      await createProgram().parseAsync(['node', 'sfdt', 'doctor', '--extension']);
    } finally {
      globalThis.fetch = originalFetch;
    }
    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('Extension stack diagnostic');
    expect(out).toContain('sfdt ui bridge');
    logSpy.mockRestore();
  });

  it('prints the red failure summary and sets exitCode 1 in pretty mode when a check fails', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetchThrows();
    try {
      await createProgram().parseAsync(['node', 'sfdt', 'doctor', '--extension']);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(process.exitCode).toBe(1);
    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toMatch(/Some checks failed/i);
    logSpy.mockRestore();
  });

  it('rejects an out-of-range --port as a JSON error', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().parseAsync(['node', 'sfdt', 'doctor', '--extension', '--port', '70000', '--json']);
    const out = writeSpy.mock.calls.map((c) => c[0]).join('');
    expect(JSON.parse(out)).toMatchObject({ status: 1, message: expect.stringMatching(/--port/) });
    writeSpy.mockRestore();
  });

  it('reports a non-numeric --port failure on stderr in pretty mode', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'doctor', '--extension', '--port', 'abc']);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('doctor failed'));
    expect(process.exitCode).toBe(1);
    errSpy.mockRestore();
  });

  it('runs the extension checks even when --extension is omitted', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetchOk({
      ok: true,
      data: { serverVersion: 'X', protocolVersion: 'Y' },
    });
    try {
      await createProgram().parseAsync(['node', 'sfdt', 'doctor']);
    } finally {
      globalThis.fetch = originalFetch;
    }
    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    // The extension checks run by default; no apologetic "defaulting" preamble.
    expect(out).toContain('Extension stack diagnostic');
    expect(out).not.toContain('defaulting to --extension');
    logSpy.mockRestore();
  });

  it('runs both groups by default and tags results with their group', async () => {
    // emitJson writes via process.stdout.write (see output.js), not console.log —
    // spy on stdout to match every other --json test in this file.
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetchOk({ ok: true, data: { serverVersion: 'X', protocolVersion: 'Y' } });
    try {
      await createProgram().parseAsync(['node', 'sfdt', 'doctor', '--json']);
    } finally {
      globalThis.fetch = originalFetch;
    }
    const printed = JSON.parse(writeSpy.mock.calls.map((c) => String(c[0])).join(''));
    const groups = new Set(printed.result.results.map((r) => r.group));
    expect(groups).toEqual(new Set(['core', 'extension']));
    writeSpy.mockRestore();
  });

  it('runs only core checks with --core', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().parseAsync(['node', 'sfdt', 'doctor', '--core', '--json']);
    const printed = JSON.parse(writeSpy.mock.calls.map((c) => String(c[0])).join(''));
    expect(printed.result.results.every((r) => r.group === 'core')).toBe(true);
    writeSpy.mockRestore();
  });

  it('exits 1 when any merged result fails', async () => {
    runCoreDoctor.mockResolvedValue({ ok: false, results: [{ name: 'sf CLI', status: 'fail', detail: 'absent' }] });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetchOk({ ok: true, data: {} });
    try {
      await createProgram().parseAsync(['node', 'sfdt', 'doctor', '--json']);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(process.exitCode).toBe(1);
  });
});
