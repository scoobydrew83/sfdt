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

import fs from 'fs-extra';
import { getConfigDir } from '../../src/lib/config.js';
import { nativeHostStatus } from '../../host/installers/install-host.js';
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
});

describe('runExtensionDoctor', () => {
  it('passes the bridge ping check when /api/bridge/ping returns ok', async () => {
    const fetchImpl = mockFetchOk({
      ok: true,
      data: { serverVersion: '0.8.1', protocolVersion: '1.2' },
    });
    const { results, ok } = await runExtensionDoctor({ port: 7654, fetchImpl });
    const bridge = results.find((r) => r.name === 'sfdt ui bridge');
    expect(bridge.status).toBe('pass');
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
    expect(ff.status).toBe('pass');
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
    expect(tel.status).toBe('pass');
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

  it('warns and defaults to --extension when no diagnostic group is selected', async () => {
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
    expect(out).toContain('defaulting to --extension');
    logSpy.mockRestore();
  });
});
