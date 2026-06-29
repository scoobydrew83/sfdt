import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../../src/lib/config.js', () => ({ loadConfig: vi.fn() }));
vi.mock('../../src/lib/org-query.js', () => ({ query: vi.fn() }));
vi.mock('../../src/lib/exit-codes.js', () => ({ resolveExitCode: vi.fn(() => 1) }));

import { loadConfig } from '../../src/lib/config.js';
import { query } from '../../src/lib/org-query.js';
import { resolveExitCode } from '../../src/lib/exit-codes.js';
import { registerCoverageCommand } from '../../src/commands/coverage.js';

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerCoverageCommand(program);
  return program;
}

const mockConfig = { _projectRoot: '/project', defaultOrg: 'dev-org' };

beforeEach(() => {
  vi.resetAllMocks();
  process.exitCode = undefined;
  loadConfig.mockResolvedValue(mockConfig);
  resolveExitCode.mockReturnValue(1);
});

// query() is called: 1) org-wide, 2) per-class aggregate.
function wireCoverage({ orgRows, classRows = [] }) {
  query.mockResolvedValueOnce(orgRows).mockResolvedValueOnce(classRows);
}

describe('coverage command', () => {
  it('queries org-wide and per-class coverage via Tooling API', async () => {
    wireCoverage({ orgRows: [{ PercentCovered: 88 }] });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await createProgram().parseAsync(['node', 'sfdt', 'coverage']);

    expect(query.mock.calls[0][1]).toContain('ApexOrgWideCoverage');
    expect(query.mock.calls[0][2]).toEqual({ tooling: true });
    expect(query.mock.calls[1][1]).toContain('ApexCodeCoverageAggregate');
  });

  it('uses --org override', async () => {
    wireCoverage({ orgRows: [{ PercentCovered: 88 }] });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await createProgram().parseAsync(['node', 'sfdt', 'coverage', '--org', 'staging']);

    expect(query.mock.calls[0][0]).toBe('staging');
  });

  it('emits org-wide + shaped per-class coverage in --json mode', async () => {
    wireCoverage({
      orgRows: [{ PercentCovered: 82 }],
      classRows: [
        { ApexClassOrTrigger: { Name: 'GoodClass' }, NumLinesCovered: 95, NumLinesUncovered: 5 },
        { ApexClassOrTrigger: { Name: 'BadClass' }, NumLinesCovered: 10, NumLinesUncovered: 90 },
      ],
    });
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await createProgram().parseAsync(['node', 'sfdt', 'coverage', '--json']);

    const out = JSON.parse(writeSpy.mock.calls.map((c) => c[0]).join(''));
    expect(out.status).toBe(0);
    expect(out.result.orgWide).toBe(82);
    expect(out.result.belowThreshold).toBe(false);
    // shapeClassCoverage sorts worst-first.
    expect(out.result.classes[0].name).toBe('BadClass');
    expect(out.result.classes[0].pct).toBeCloseTo(0.1);
    writeSpy.mockRestore();
  });

  it('exits non-zero with a warning when org-wide is below the default threshold', async () => {
    wireCoverage({ orgRows: [{ PercentCovered: 60 }] });
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await createProgram().parseAsync(['node', 'sfdt', 'coverage', '--json']);

    expect(process.exitCode).toBe(1);
    const out = JSON.parse(writeSpy.mock.calls.map((c) => c[0]).join(''));
    expect(out.result.belowThreshold).toBe(true);
    expect(out.warnings[0]).toContain('below the 75% threshold');
    writeSpy.mockRestore();
  });

  it('respects a custom --threshold', async () => {
    wireCoverage({ orgRows: [{ PercentCovered: 80 }] });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await createProgram().parseAsync(['node', 'sfdt', 'coverage', '--threshold', '90']);

    expect(process.exitCode).toBe(1); // 80 < 90
  });

  it('does not fail when org-wide coverage is unknown (no rows)', async () => {
    wireCoverage({ orgRows: [] });
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await createProgram().parseAsync(['node', 'sfdt', 'coverage', '--json']);

    const out = JSON.parse(writeSpy.mock.calls.map((c) => c[0]).join(''));
    expect(out.result.orgWide).toBeNull();
    expect(out.result.belowThreshold).toBe(false);
    expect(process.exitCode).toBeUndefined();
    writeSpy.mockRestore();
  });

  it('emits an error envelope in --json mode when a query throws', async () => {
    const err = new Error('sf CLI not found');
    query.mockRejectedValueOnce(err);
    resolveExitCode.mockReturnValue(3);
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await createProgram().parseAsync(['node', 'sfdt', 'coverage', '--json']);

    expect(process.exitCode).toBe(3);
    const out = JSON.parse(writeSpy.mock.calls.map((c) => c[0]).join(''));
    expect(out).toMatchObject({ status: 3, message: 'sf CLI not found' });
    writeSpy.mockRestore();
  });
});
