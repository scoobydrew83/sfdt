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
