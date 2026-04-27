import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../../src/lib/config.js', () => ({ loadConfig: vi.fn() }));
vi.mock('../../src/lib/output.js', () => ({
  print: { header: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn(), step: vi.fn() },
}));
vi.mock('../../src/lib/org-inventory.js', () => ({
  fetchInventory: vi.fn(),
}));
vi.mock('../../src/lib/org-diff.js', () => ({
  diffInventories: vi.fn(),
}));
vi.mock('../../src/lib/metadata-mapper.js', () => ({
  renderPackageXml: vi.fn(),
}));
vi.mock('fs-extra', () => ({
  default: { outputJson: vi.fn(), outputFile: vi.fn(), ensureDir: vi.fn() },
}));

import { loadConfig } from '../../src/lib/config.js';
import { print } from '../../src/lib/output.js';
import { fetchInventory } from '../../src/lib/org-inventory.js';
import { diffInventories } from '../../src/lib/org-diff.js';
import { renderPackageXml } from '../../src/lib/metadata-mapper.js';
import fs from 'fs-extra';
import { registerCompareCommand } from '../../src/commands/compare.js';

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerCompareCommand(program);
  return program;
}

const mockConfig = {
  _projectRoot: '/project',
  defaultOrg: 'dev',
  sourceApiVersion: '63.0',
  features: {},
};

beforeEach(() => {
  vi.resetAllMocks();
  process.exitCode = undefined;
  loadConfig.mockResolvedValue(mockConfig);
  fetchInventory.mockResolvedValue(new Map([['ApexClass', new Set(['MyClass'])]]));
  diffInventories.mockReturnValue([{ type: 'ApexClass', member: 'MyClass', status: 'source-only' }]);
  fs.outputJson.mockResolvedValue(undefined);
  fs.ensureDir.mockResolvedValue(undefined);
});

describe('compare command', () => {
  it('uses local as default source and defaultOrg as default target', async () => {
    await createProgram().parseAsync(['node', 'sfdt', 'compare']);

    expect(fetchInventory).toHaveBeenCalledWith('local', mockConfig);
    expect(fetchInventory).toHaveBeenCalledWith('dev', mockConfig);
  });

  it('respects --source and --target flags', async () => {
    await createProgram().parseAsync(['node', 'sfdt', 'compare', '--source', 'sandbox', '--target', 'prod']);

    expect(fetchInventory).toHaveBeenCalledWith('sandbox', mockConfig);
    expect(fetchInventory).toHaveBeenCalledWith('prod', mockConfig);
  });

  it('writes compare-latest.json to logs dir', async () => {
    await createProgram().parseAsync(['node', 'sfdt', 'compare']);

    expect(fs.outputJson).toHaveBeenCalledWith(
      expect.stringContaining('compare-latest.json'),
      expect.objectContaining({ items: expect.any(Array), source: 'local', target: 'dev' }),
      { spaces: 2 },
    );
  });

  it('writes package.xml when --output is provided', async () => {
    renderPackageXml.mockReturnValue('<?xml version="1.0"?>...');
    fs.outputFile.mockResolvedValue(undefined);

    await createProgram().parseAsync(['node', 'sfdt', 'compare', '--output', 'out.xml']);

    expect(renderPackageXml).toHaveBeenCalled();
    expect(fs.outputFile).toHaveBeenCalledWith(expect.stringContaining('out.xml'), expect.stringContaining('<?xml'));
  });

  it('sets exitCode 1 on failure', async () => {
    fetchInventory.mockRejectedValue(new Error('sf auth expired'));

    await createProgram().parseAsync(['node', 'sfdt', 'compare']);

    expect(print.error).toHaveBeenCalledWith(expect.stringContaining('sf auth expired'));
    expect(process.exitCode).toBe(1);
  });
});
