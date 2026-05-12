import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../../src/lib/config.js', () => ({
  loadConfig: vi.fn(),
}));

vi.mock('../../src/lib/script-runner.js', () => ({
  runScript: vi.fn(),
}));

vi.mock('../../src/lib/output.js', () => ({
  print: {
    header: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    step: vi.fn(),
  },
}));

vi.mock('fs-extra', () => ({
  default: {
    readJson: vi.fn(),
  },
}));

import { loadConfig } from '../../src/lib/config.js';
import { runScript } from '../../src/lib/script-runner.js';
import { print } from '../../src/lib/output.js';
import fs from 'fs-extra';
import { registerDriftCommand } from '../../src/commands/drift.js';

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerDriftCommand(program);
  return program;
}

beforeEach(() => {
  vi.resetAllMocks();
  process.exitCode = undefined;
  loadConfig.mockResolvedValue({
    _projectRoot: '/project',
    defaultOrg: 'dev',
    features: {},
  });
  fs.readJson.mockResolvedValue({});
});

describe('drift command', () => {
  it('uses defaultOrg when no --org flag', async () => {
    runScript.mockResolvedValue({ exitCode: 0 });

    await createProgram().parseAsync(['node', 'sfdt', 'drift']);

    expect(runScript).toHaveBeenCalledWith(
      'ops/drift.sh',
      expect.any(Object),
      expect.objectContaining({ env: { SFDT_TARGET_ORG: 'dev' } }),
    );
  });

  it('uses --org flag when provided', async () => {
    runScript.mockResolvedValue({ exitCode: 0 });

    await createProgram().parseAsync(['node', 'sfdt', 'drift', '--org', 'prod']);

    expect(runScript).toHaveBeenCalledWith(
      'ops/drift.sh',
      expect.any(Object),
      expect.objectContaining({ env: { SFDT_TARGET_ORG: 'prod' } }),
    );
  });

  it('sets exitCode 1 on failure', async () => {
    runScript.mockRejectedValue(new Error('drift failed'));

    await createProgram().parseAsync(['node', 'sfdt', 'drift']);

    expect(print.error).toHaveBeenCalledWith(expect.stringContaining('drift failed'));
    expect(process.exitCode).toBe(1);
  });

  describe('--json flag', () => {
    it('suppresses print calls when --json is active', async () => {
      runScript.mockResolvedValue({ exitCode: 0, stdout: '' });
      fs.readJson.mockResolvedValue({ status: 'PASS', components: [] });

      await createProgram().parseAsync(['node', 'sfdt', 'drift', '--json']);

      expect(print.header).not.toHaveBeenCalled();
      expect(print.success).not.toHaveBeenCalled();
    });

    it('writes standardized JSON to stdout when --json succeeds', async () => {
      const logFile = { timestamp: '2026-05-12T00:00:00.000Z', data: { status: 'drift', components: ['Foo__c'] } };
      runScript.mockResolvedValue({ exitCode: 0, stdout: '' });
      fs.readJson.mockResolvedValue(logFile);
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

      await createProgram().parseAsync(['node', 'sfdt', 'drift', '--json']);

      const written = JSON.parse(writeSpy.mock.calls.map((c) => c[0]).join(''));
      expect(written).toMatchObject({
        status: 'success',
        org: 'dev',
        exitCode: 0,
        driftStatus: 'drift',
        components: ['Foo__c'],
      });
      writeSpy.mockRestore();
    });

    it('falls back to top-level fields when log file has no data envelope', async () => {
      const logFile = { status: 'clean', components: [] };
      runScript.mockResolvedValue({ exitCode: 0, stdout: '' });
      fs.readJson.mockResolvedValue(logFile);
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

      await createProgram().parseAsync(['node', 'sfdt', 'drift', '--json']);

      const written = JSON.parse(writeSpy.mock.calls.map((c) => c[0]).join(''));
      expect(written).toMatchObject({ status: 'success', driftStatus: 'clean', components: [] });
      writeSpy.mockRestore();
    });

    it('emits error JSON when drift log cannot be read after script success', async () => {
      runScript.mockResolvedValue({ exitCode: 0 });
      fs.readJson.mockRejectedValue(new Error('ENOENT: drift-latest.json not found'));
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

      await createProgram().parseAsync(['node', 'sfdt', 'drift', '--json']);

      expect(process.exitCode).toBe(1);
      const written = JSON.parse(writeSpy.mock.calls.map((c) => c[0]).join(''));
      expect(written).toMatchObject({ status: 'error', message: expect.stringContaining('ENOENT') });
      writeSpy.mockRestore();
    });

    it('emits error JSON and sets exitCode on script failure with --json', async () => {
      const err = new Error('drift failed');
      err.exitCode = 1;
      runScript.mockRejectedValue(err);
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

      await createProgram().parseAsync(['node', 'sfdt', 'drift', '--json']);

      expect(process.exitCode).toBe(1);
      const written = writeSpy.mock.calls.map((c) => c[0]).join('');
      expect(JSON.parse(written)).toMatchObject({ status: 'error', message: 'drift failed' });
      writeSpy.mockRestore();
    });
  });
});
