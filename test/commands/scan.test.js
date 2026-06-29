import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../../src/lib/config.js', () => ({ loadConfig: vi.fn() }));
vi.mock('../../src/lib/org-inventory.js', () => ({ fetchInventory: vi.fn() }));
vi.mock('../../src/lib/exit-codes.js', () => ({ resolveExitCode: vi.fn() }));
vi.mock('fs-extra', () => ({
  default: { ensureDir: vi.fn(), writeJson: vi.fn() },
}));
vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
  })),
}));

import { loadConfig } from '../../src/lib/config.js';
import { fetchInventory } from '../../src/lib/org-inventory.js';
import { resolveExitCode } from '../../src/lib/exit-codes.js';
import fs from 'fs-extra';
import ora from 'ora';
import { registerScanCommand } from '../../src/commands/scan.js';

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerScanCommand(program);
  return program;
}

const mockConfig = {
  _projectRoot: '/project',
  defaultOrg: 'dev-org',
  logDir: '/project/logs',
};

const mockInventory = new Map([
  ['ApexClass', new Set(['MyClass', 'OtherClass'])],
  ['CustomObject', new Set(['Account__c'])],
]);

beforeEach(() => {
  vi.resetAllMocks();
  process.exitCode = undefined;
  loadConfig.mockResolvedValue(mockConfig);
  fetchInventory.mockResolvedValue(mockInventory);
  fs.ensureDir.mockResolvedValue(undefined);
  fs.writeJson.mockResolvedValue(undefined);
  resolveExitCode.mockReturnValue(1);
});

describe('scan command', () => {
  it('uses config.defaultOrg when no --org is provided', async () => {
    await createProgram().parseAsync(['node', 'sfdt', 'scan']);

    expect(fetchInventory).toHaveBeenCalledWith('dev-org', mockConfig);
  });

  it('uses --org alias when provided', async () => {
    await createProgram().parseAsync(['node', 'sfdt', 'scan', '--org', 'staging']);

    expect(fetchInventory).toHaveBeenCalledWith('staging', mockConfig);
  });

  it('writes JSON to config.logDir/scan-latest.json by default', async () => {
    await createProgram().parseAsync(['node', 'sfdt', 'scan']);

    expect(fs.ensureDir).toHaveBeenCalledWith('/project/logs');
    expect(fs.writeJson).toHaveBeenCalledWith(
      '/project/logs/scan-latest.json',
      expect.any(Object),
      { spaces: 2 },
    );
  });

  it('falls back to _projectRoot/logs when config.logDir is absent', async () => {
    loadConfig.mockResolvedValue({ _projectRoot: '/project', defaultOrg: 'dev-org' });

    await createProgram().parseAsync(['node', 'sfdt', 'scan']);

    expect(fs.ensureDir).toHaveBeenCalledWith('/project/logs');
    expect(fs.writeJson).toHaveBeenCalledWith(
      '/project/logs/scan-latest.json',
      expect.any(Object),
      { spaces: 2 },
    );
  });

  it('writes to the --output path when provided', async () => {
    await createProgram().parseAsync(['node', 'sfdt', 'scan', '--output', '/tmp/out.json']);

    expect(fs.writeJson).toHaveBeenCalledWith(
      '/tmp/out.json',
      expect.any(Object),
      { spaces: 2 },
    );
  });

  it('writes correct JSON shape with org, inventory, and summary', async () => {
    await createProgram().parseAsync(['node', 'sfdt', 'scan']);

    const [, written] = fs.writeJson.mock.calls[0];
    expect(written).toMatchObject({
      org: 'dev-org',
      summary: { totalTypes: 2, totalMembers: 3 },
      inventory: {
        ApexClass: expect.arrayContaining(['MyClass', 'OtherClass']),
        CustomObject: expect.arrayContaining(['Account__c']),
      },
    });
    expect(written.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('prints table output when --format table is given', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await createProgram().parseAsync(['node', 'sfdt', 'scan', '--format', 'table']);

    const logged = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(logged).toContain('ApexClass');
    expect(logged).toContain('CustomObject');
    logSpy.mockRestore();
  });

  it('does not print table output for default json format', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await createProgram().parseAsync(['node', 'sfdt', 'scan']);

    const logged = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(logged).not.toContain('ApexClass');
    logSpy.mockRestore();
  });

  it('sets process.exitCode when fetchInventory throws', async () => {
    const err = new Error('sf CLI not available');
    fetchInventory.mockRejectedValue(err);
    resolveExitCode.mockReturnValue(2);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await createProgram().parseAsync(['node', 'sfdt', 'scan']);

    expect(process.exitCode).toBe(2);
    expect(resolveExitCode).toHaveBeenCalledWith(err);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Scan failed'));
    errorSpy.mockRestore();
  });

  it('uses the ora spinner during fetch', async () => {
    await createProgram().parseAsync(['node', 'sfdt', 'scan']);

    const spinnerInstance = ora.mock.results[0].value;
    expect(spinnerInstance.start).toHaveBeenCalled();
    expect(spinnerInstance.succeed).toHaveBeenCalled();
  });

  it('calls spinner.fail when fetchInventory throws', async () => {
    fetchInventory.mockRejectedValue(new Error('Network error'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await createProgram().parseAsync(['node', 'sfdt', 'scan']);

    const spinnerInstance = ora.mock.results[0].value;
    expect(spinnerInstance.fail).toHaveBeenCalled();
  });

  describe('--json mode', () => {
    it('writes JSON shape to stdout instead of a file', async () => {
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

      await createProgram().parseAsync(['node', 'sfdt', 'scan', '--json']);

      expect(fs.writeJson).not.toHaveBeenCalled();
      const written = writeSpy.mock.calls.map((c) => c[0]).join('');
      const parsed = JSON.parse(written);
      expect(parsed).toMatchObject({
        status: 0,
        result: {
          org: 'dev-org',
          summary: { totalTypes: 2, totalMembers: 3 },
          inventory: {
            ApexClass: expect.arrayContaining(['MyClass', 'OtherClass']),
            CustomObject: expect.arrayContaining(['Account__c']),
          },
        },
      });
      expect(parsed.result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      writeSpy.mockRestore();
    });

    it('does not create a spinner when --json is active', async () => {
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

      await createProgram().parseAsync(['node', 'sfdt', 'scan', '--json']);

      expect(ora).not.toHaveBeenCalled();
    });

    it('emits error JSON to stdout when fetchInventory throws', async () => {
      const err = new Error('sf CLI not found');
      fetchInventory.mockRejectedValue(err);
      resolveExitCode.mockReturnValue(3);
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

      await createProgram().parseAsync(['node', 'sfdt', 'scan', '--json']);

      expect(process.exitCode).toBe(3);
      const written = writeSpy.mock.calls.map((c) => c[0]).join('');
      expect(JSON.parse(written)).toMatchObject({ status: 3, message: 'sf CLI not found', exitCode: 3 });
      writeSpy.mockRestore();
    });
  });
});
