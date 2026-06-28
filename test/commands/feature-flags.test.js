import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

vi.mock('fs-extra', () => ({
  default: {
    pathExists: vi.fn(),
    readJson: vi.fn(),
    outputJson: vi.fn(),
    remove: vi.fn(),
  },
}));

vi.mock('../../src/lib/config.js', () => ({
  getConfigDir: vi.fn(),
}));

vi.mock('../../src/lib/output.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    print: {
      header: vi.fn(),
      success: vi.fn(),
      error: vi.fn(),
      warning: vi.fn(),
      info: vi.fn(),
      step: vi.fn(),
    },
  };
});

import fs from 'fs-extra';
import { getConfigDir } from '../../src/lib/config.js';
import { print } from '../../src/lib/output.js';
import { registerFeatureFlagsCommand } from '../../src/commands/feature-flags.js';

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerFeatureFlagsCommand(program);
  return program;
}

const FILE = '/project/.sfdt/feature-flags.json';

beforeEach(() => {
  vi.resetAllMocks();
  process.exitCode = undefined;
  getConfigDir.mockReturnValue('/project/.sfdt');
  fs.pathExists.mockResolvedValue(false);
  fs.readJson.mockResolvedValue({ disabled: [] });
  fs.outputJson.mockResolvedValue(undefined);
  fs.remove.mockResolvedValue(undefined);
});

describe('feature-flags list', () => {
  it('reports no disabled features when the file does not exist', async () => {
    fs.pathExists.mockResolvedValue(false);
    await createProgram().parseAsync(['node', 'sfdt', 'feature-flags', 'list']);
    expect(print.info).toHaveBeenCalledWith('No features are disabled.');
  });

  it('lists disabled features when the file has entries', async () => {
    fs.pathExists.mockResolvedValue(true);
    fs.readJson.mockResolvedValue({ disabled: ['canvas-search', 'flow-deploy'] });
    await createProgram().parseAsync(['node', 'sfdt', 'feature-flags', 'list']);
    expect(print.step).toHaveBeenCalledWith('• canvas-search');
    expect(print.step).toHaveBeenCalledWith('• flow-deploy');
  });

  it('--json prints the disabled list and file path', async () => {
    fs.pathExists.mockResolvedValue(true);
    fs.readJson.mockResolvedValue({ disabled: ['canvas-search'] });
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().parseAsync(['node', 'sfdt', 'feature-flags', 'list', '--json']);
    const written = spy.mock.calls[0][0];
    const parsed = JSON.parse(written);
    expect(parsed).toEqual({ status: 0, result: { ok: true, file: FILE, disabled: ['canvas-search'] }, warnings: [] });
    spy.mockRestore();
  });

  it('tolerates a malformed JSON file by reporting an error', async () => {
    fs.pathExists.mockResolvedValue(true);
    fs.readJson.mockRejectedValue(new Error('Unexpected token'));
    await createProgram().parseAsync(['node', 'sfdt', 'feature-flags', 'list']);
    expect(print.error).toHaveBeenCalledWith(expect.stringContaining('Unexpected token'));
    expect(process.exitCode).toBeDefined();
  });

  it('treats a non-array "disabled" field as empty', async () => {
    fs.pathExists.mockResolvedValue(true);
    fs.readJson.mockResolvedValue({ disabled: 'nope' });
    await createProgram().parseAsync(['node', 'sfdt', 'feature-flags', 'list']);
    expect(print.info).toHaveBeenCalledWith('No features are disabled.');
  });

  it('notes the file exists when the disabled list is empty', async () => {
    fs.pathExists.mockResolvedValue(true);
    fs.readJson.mockResolvedValue({ disabled: [] });
    await createProgram().parseAsync(['node', 'sfdt', 'feature-flags', 'list']);
    expect(print.info).toHaveBeenCalledWith('No features are disabled.');
    // file exists → no "does not exist yet" suffix
    expect(print.step).toHaveBeenCalledWith(`(file: ${FILE})`);
  });

  it('--json reports the error envelope on a malformed file', async () => {
    fs.pathExists.mockResolvedValue(true);
    fs.readJson.mockRejectedValue(new Error('Unexpected token'));
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().parseAsync(['node', 'sfdt', 'feature-flags', 'list', '--json']);
    const parsed = JSON.parse(spy.mock.calls[0][0]);
    expect(parsed.message).toContain('Unexpected token');
    expect(parsed.status).toBeGreaterThan(0);
    spy.mockRestore();
  });
});

describe('feature-flags disable', () => {
  it('adds a new feature id to the disabled list', async () => {
    fs.pathExists.mockResolvedValue(false);
    await createProgram().parseAsync(['node', 'sfdt', 'feature-flags', 'disable', 'canvas-search']);
    expect(fs.outputJson).toHaveBeenCalledWith(
      FILE,
      { disabled: ['canvas-search'] },
      { spaces: 2 },
    );
    expect(print.success).toHaveBeenCalledWith(expect.stringContaining("Disabled 'canvas-search'"));
  });

  it('is a no-op when the feature is already disabled', async () => {
    fs.pathExists.mockResolvedValue(true);
    fs.readJson.mockResolvedValue({ disabled: ['canvas-search'] });
    await createProgram().parseAsync(['node', 'sfdt', 'feature-flags', 'disable', 'canvas-search']);
    expect(fs.outputJson).not.toHaveBeenCalled();
    expect(print.info).toHaveBeenCalledWith(expect.stringContaining('already disabled'));
  });

  it('keeps the disabled list sorted alphabetically', async () => {
    fs.pathExists.mockResolvedValue(true);
    fs.readJson.mockResolvedValue({ disabled: ['flow-deploy'] });
    await createProgram().parseAsync(['node', 'sfdt', 'feature-flags', 'disable', 'canvas-search']);
    expect(fs.outputJson).toHaveBeenCalledWith(
      FILE,
      { disabled: ['canvas-search', 'flow-deploy'] },
      { spaces: 2 },
    );
  });

  it('--json reports the changed flag', async () => {
    fs.pathExists.mockResolvedValue(false);
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().parseAsync(['node', 'sfdt', 'feature-flags', 'disable', 'canvas-search', '--json']);
    const parsed = JSON.parse(spy.mock.calls[0][0]);
    expect(parsed).toEqual({
      status: 0,
      result: {
        ok: true,
        file: FILE,
        changed: true,
        disabled: ['canvas-search'],
      },
      warnings: [],
    });
    spy.mockRestore();
  });

  it('rejects an invalid feature id', async () => {
    await createProgram().parseAsync(['node', 'sfdt', 'feature-flags', 'disable', 'bad id!']);
    expect(print.error).toHaveBeenCalledWith(expect.stringContaining('featureId must match'));
    expect(process.exitCode).toBeDefined();
    expect(fs.outputJson).not.toHaveBeenCalled();
  });

  it('--json emits an error envelope for an invalid feature id', async () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().parseAsync(['node', 'sfdt', 'feature-flags', 'disable', 'bad id!', '--json']);
    const parsed = JSON.parse(spy.mock.calls[0][0]);
    expect(parsed.message).toContain('featureId must match');
    expect(parsed.status).toBeGreaterThan(0);
    spy.mockRestore();
  });
});

describe('feature-flags enable', () => {
  it('removes a feature id from the disabled list', async () => {
    fs.pathExists.mockResolvedValue(true);
    fs.readJson.mockResolvedValue({ disabled: ['canvas-search', 'flow-deploy'] });
    await createProgram().parseAsync(['node', 'sfdt', 'feature-flags', 'enable', 'canvas-search']);
    expect(fs.outputJson).toHaveBeenCalledWith(
      FILE,
      { disabled: ['flow-deploy'] },
      { spaces: 2 },
    );
    expect(print.success).toHaveBeenCalledWith(expect.stringContaining("Enabled 'canvas-search'"));
  });

  it('is a no-op when the feature was not in the list', async () => {
    fs.pathExists.mockResolvedValue(true);
    fs.readJson.mockResolvedValue({ disabled: ['flow-deploy'] });
    await createProgram().parseAsync(['node', 'sfdt', 'feature-flags', 'enable', 'canvas-search']);
    expect(fs.outputJson).not.toHaveBeenCalled();
    expect(print.info).toHaveBeenCalledWith(expect.stringContaining('was not disabled'));
  });

  it('--json reports the changed flag and remaining disabled list', async () => {
    fs.pathExists.mockResolvedValue(true);
    fs.readJson.mockResolvedValue({ disabled: ['canvas-search', 'flow-deploy'] });
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().parseAsync(['node', 'sfdt', 'feature-flags', 'enable', 'canvas-search', '--json']);
    const parsed = JSON.parse(spy.mock.calls[0][0]);
    expect(parsed).toEqual({
      status: 0,
      result: { ok: true, file: FILE, changed: true, disabled: ['flow-deploy'] },
      warnings: [],
    });
    spy.mockRestore();
  });

  it('--json emits an error envelope for an invalid feature id', async () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().parseAsync(['node', 'sfdt', 'feature-flags', 'enable', 'bad id!', '--json']);
    const parsed = JSON.parse(spy.mock.calls[0][0]);
    expect(parsed.message).toContain('featureId must match');
    spy.mockRestore();
  });

  it('reports an error for an invalid feature id (non-json)', async () => {
    await createProgram().parseAsync(['node', 'sfdt', 'feature-flags', 'enable', 'bad id!']);
    expect(print.error).toHaveBeenCalledWith(expect.stringContaining('featureId must match'));
    expect(process.exitCode).toBeDefined();
  });
});

describe('feature-flags clear', () => {
  it('empties the disabled list (writes {disabled: []})', async () => {
    fs.pathExists.mockResolvedValue(true);
    await createProgram().parseAsync(['node', 'sfdt', 'feature-flags', 'clear']);
    expect(fs.outputJson).toHaveBeenCalledWith(FILE, { disabled: [] }, { spaces: 2 });
    expect(fs.remove).not.toHaveBeenCalled();
  });

  it('--remove deletes the file when present', async () => {
    fs.pathExists.mockResolvedValue(true);
    await createProgram().parseAsync(['node', 'sfdt', 'feature-flags', 'clear', '--remove']);
    expect(fs.remove).toHaveBeenCalledWith(FILE);
    expect(fs.outputJson).not.toHaveBeenCalled();
  });

  it('--remove is a no-op when the file does not exist', async () => {
    fs.pathExists.mockResolvedValue(false);
    await createProgram().parseAsync(['node', 'sfdt', 'feature-flags', 'clear', '--remove']);
    expect(fs.remove).not.toHaveBeenCalled();
    expect(print.success).toHaveBeenCalledWith(expect.stringContaining('did not exist'));
  });

  it('--json reports the cleared state', async () => {
    fs.pathExists.mockResolvedValue(true);
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().parseAsync(['node', 'sfdt', 'feature-flags', 'clear', '--json']);
    const parsed = JSON.parse(spy.mock.calls[0][0]);
    expect(parsed).toEqual({
      status: 0,
      result: { ok: true, file: FILE, removed: false, existed: true, disabled: [] },
      warnings: [],
    });
    spy.mockRestore();
  });

  it('reports an error when the write fails', async () => {
    fs.pathExists.mockResolvedValue(true);
    fs.outputJson.mockRejectedValue(new Error('disk full'));
    await createProgram().parseAsync(['node', 'sfdt', 'feature-flags', 'clear']);
    expect(print.error).toHaveBeenCalledWith(expect.stringContaining('disk full'));
    expect(process.exitCode).toBeDefined();
  });

  it('--json emits an error envelope when the write fails', async () => {
    fs.pathExists.mockResolvedValue(true);
    fs.outputJson.mockRejectedValue(new Error('disk full'));
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().parseAsync(['node', 'sfdt', 'feature-flags', 'clear', '--json']);
    const parsed = JSON.parse(spy.mock.calls[0][0]);
    expect(parsed.message).toContain('disk full');
    expect(parsed.status).toBeGreaterThan(0);
    spy.mockRestore();
  });
});
