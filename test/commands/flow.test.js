import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../../src/lib/config.js', () => ({ loadConfig: vi.fn() }));
vi.mock('../../src/lib/flow-analyzer.js', () => ({
  runFlowScan: vi.fn(),
  runFlowConflicts: vi.fn(),
}));
vi.mock('../../src/lib/exit-codes.js', () => ({ resolveExitCode: vi.fn(() => 1) }));
vi.mock('fs-extra', () => ({ default: { ensureDir: vi.fn(), writeJson: vi.fn() } }));
vi.mock('ora', () => ({
  default: vi.fn(() => ({ start: vi.fn().mockReturnThis(), succeed: vi.fn().mockReturnThis(), fail: vi.fn().mockReturnThis() })),
}));

import fs from 'fs-extra';
import { loadConfig } from '../../src/lib/config.js';
import { runFlowScan, runFlowConflicts } from '../../src/lib/flow-analyzer.js';
import { registerFlowCommand } from '../../src/commands/flow.js';

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerFlowCommand(program);
  return program;
}

const scanOutput = {
  totalFlows: 2,
  averageScore: 80,
  totalErrors: 1,
  reports: [
    { overallScore: 50, rating: 'Poor', label: 'Flow A' },
    { overallScore: 90, rating: 'Good', label: 'Flow B' },
  ],
};
const conflictsOutput = {
  totalGroups: 1,
  totalFlowsInConflicts: 2,
  groups: [
    {
      objectApiName: 'Account',
      triggerTiming: 'before',
      triggerEvent: 'create',
      flows: [
        { label: 'Flow A', entryCriteriaSummary: 'IsActive = true' },
        { label: 'Flow B', entryCriteriaSummary: null },
      ],
    },
  ],
};

beforeEach(() => {
  vi.resetAllMocks();
  process.exitCode = undefined;
  loadConfig.mockResolvedValue({ _projectRoot: '/p', defaultOrg: 'dev', sourceApiVersion: '60.0' });
  runFlowScan.mockResolvedValue(scanOutput);
  runFlowConflicts.mockResolvedValue(conflictsOutput);
  fs.ensureDir.mockResolvedValue(undefined);
  fs.writeJson.mockResolvedValue(undefined);
});

describe('flow scan', () => {
  it('emits JSON to stdout in --json mode without writing a file', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().parseAsync(['node', 'sfdt', 'flow', 'scan', '--json']);
    expect(runFlowScan).toHaveBeenCalledWith('dev', '60.0');
    expect(fs.writeJson).not.toHaveBeenCalled();
    const out = writeSpy.mock.calls.map((c) => c[0]).join('');
    expect(JSON.parse(out)).toMatchObject({ status: 0, result: { totalFlows: 2 } });
    writeSpy.mockRestore();
  });

  it('writes a report file and prints worst offenders in pretty mode', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'flow', 'scan']);
    expect(fs.writeJson).toHaveBeenCalledWith('/p/logs/flow-scan-latest.json', scanOutput, { spaces: 2 });
    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('Worst offenders');
    expect(out).toContain('Flow A');
    logSpy.mockRestore();
  });

  it('honors --org and --output overrides', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'flow', 'scan', '--org', 'qa', '--output', 'out/x.json']);
    expect(runFlowScan).toHaveBeenCalledWith('qa', '60.0');
    expect(fs.writeJson).toHaveBeenCalledWith(expect.stringContaining('out/x.json'), scanOutput, { spaces: 2 });
    logSpy.mockRestore();
  });

  it('errors as JSON when no org is configured', async () => {
    loadConfig.mockResolvedValue({ _projectRoot: '/p' });
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().parseAsync(['node', 'sfdt', 'flow', 'scan', '--json']);
    const out = writeSpy.mock.calls.map((c) => c[0]).join('');
    expect(JSON.parse(out)).toMatchObject({ status: 1, message: expect.stringMatching(/No org/) });
    writeSpy.mockRestore();
  });

  it('reports a scan failure to stderr and sets the exit code in pretty mode', async () => {
    runFlowScan.mockRejectedValue(new Error('list failed'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'flow', 'scan']);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('list failed'));
    expect(process.exitCode).toBe(1);
    errSpy.mockRestore();
  });
});

describe('flow conflicts', () => {
  it('emits JSON in --json mode', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().parseAsync(['node', 'sfdt', 'flow', 'conflicts', '--json']);
    expect(runFlowConflicts).toHaveBeenCalledWith('dev');
    const out = writeSpy.mock.calls.map((c) => c[0]).join('');
    expect(JSON.parse(out)).toMatchObject({ status: 0, result: { totalGroups: 1 } });
    writeSpy.mockRestore();
  });

  it('writes a report and prints conflict groups in pretty mode', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'flow', 'conflicts']);
    expect(fs.writeJson).toHaveBeenCalledWith('/p/logs/flow-conflicts-latest.json', conflictsOutput, { spaces: 2 });
    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('Account');
    expect(out).toContain('Flow A');
    logSpy.mockRestore();
  });

  it('prints the "no conflicts" line when there are none', async () => {
    runFlowConflicts.mockResolvedValue({ totalGroups: 0, totalFlowsInConflicts: 0, groups: [] });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'flow', 'conflicts']);
    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('No record-triggered conflicts');
    logSpy.mockRestore();
  });

  it('reports a conflicts failure as JSON', async () => {
    runFlowConflicts.mockRejectedValue(new Error('boom'));
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await createProgram().parseAsync(['node', 'sfdt', 'flow', 'conflicts', '--json']);
    const out = writeSpy.mock.calls.map((c) => c[0]).join('');
    expect(JSON.parse(out)).toMatchObject({ status: 1, message: 'boom' });
    writeSpy.mockRestore();
  });

  it('errors to stderr and sets the exit code when no org is configured (pretty mode)', async () => {
    loadConfig.mockResolvedValue({ _projectRoot: '/p' });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await createProgram().parseAsync(['node', 'sfdt', 'flow', 'conflicts']);
    expect(runFlowConflicts).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('No org'));
    expect(process.exitCode).toBe(1);
    errSpy.mockRestore();
  });
});
