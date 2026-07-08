import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../../src/lib/config.js', () => ({ loadConfig: vi.fn() }));
vi.mock('../../src/lib/org-query.js', () => ({ query: vi.fn() }));
vi.mock('../../src/lib/exit-codes.js', () => ({ resolveExitCode: vi.fn(() => 1) }));
vi.mock('../../src/lib/source-dependencies.js', () => ({ runGapReport: vi.fn() }));

import { loadConfig } from '../../src/lib/config.js';
import { query } from '../../src/lib/org-query.js';
import { resolveExitCode } from '../../src/lib/exit-codes.js';
import { runGapReport } from '../../src/lib/source-dependencies.js';
import { registerDependenciesCommand } from '../../src/commands/dependencies.js';

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerDependenciesCommand(program);
  return program;
}

const mockConfig = { _projectRoot: '/project', defaultOrg: 'dev-org' };

beforeEach(() => {
  vi.resetAllMocks();
  process.exitCode = undefined;
  loadConfig.mockResolvedValue(mockConfig);
  resolveExitCode.mockReturnValue(1);
});

// query() is called: 1) resolve Id, 2) references, 3) referenced-by.
function wireQueries({ idRows, refRows = [], refByRows = [] }) {
  query
    .mockResolvedValueOnce(idRows) // resolve
    .mockResolvedValueOnce(refRows) // references
    .mockResolvedValueOnce(refByRows); // referenced-by
}

describe('dependencies command', () => {
  it('resolves the Id with a Tooling query for the default ApexClass type', async () => {
    wireQueries({ idRows: [{ Id: '01p000000000001' }] });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await createProgram().parseAsync(['node', 'sfdt', 'dependencies', 'MyClass']);

    const [org, soql, opts] = query.mock.calls[0];
    expect(org).toBe('dev-org');
    expect(soql).toContain('FROM ApexClass');
    expect(soql).toContain("Name='MyClass'");
    expect(opts).toEqual({ tooling: true });
  });

  it('uses --org override and --type', async () => {
    wireQueries({ idRows: [{ Id: '301000000000001' }] });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await createProgram().parseAsync(['node', 'sfdt', 'dependencies', 'My_Flow', '--type', 'Flow', '--org', 'staging']);

    expect(query.mock.calls[0][0]).toBe('staging');
    expect(query.mock.calls[0][1]).toContain('FROM FlowDefinition');
  });

  it('emits grouped references and referenced-by in --json mode', async () => {
    wireQueries({
      idRows: [{ Id: '01p000000000001' }],
      refRows: [
        { RefMetadataComponentName: 'AccountHelper', RefMetadataComponentType: 'ApexClass' },
        { RefMetadataComponentName: 'Account', RefMetadataComponentType: 'CustomObject' },
      ],
      refByRows: [{ MetadataComponentName: 'MyTrigger', MetadataComponentType: 'ApexTrigger' }],
    });
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await createProgram().parseAsync(['node', 'sfdt', 'dependencies', 'MyClass', '--json']);

    const out = JSON.parse(writeSpy.mock.calls.map((c) => c[0]).join(''));
    expect(out).toMatchObject({
      status: 0,
      result: {
        org: 'dev-org',
        type: 'ApexClass',
        name: 'MyClass',
        found: true,
        references: [
          { type: 'ApexClass', names: ['AccountHelper'] },
          { type: 'CustomObject', names: ['Account'] },
        ],
        referencedBy: [{ type: 'ApexTrigger', names: ['MyTrigger'] }],
      },
    });
    writeSpy.mockRestore();
  });

  it('handles name-not-found gracefully (no error, found:false)', async () => {
    query.mockResolvedValueOnce([]); // resolve returns nothing
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await createProgram().parseAsync(['node', 'sfdt', 'dependencies', 'Ghost', '--json']);

    // No follow-up reference queries when the component is missing.
    expect(query).toHaveBeenCalledTimes(1);
    const out = JSON.parse(writeSpy.mock.calls.map((c) => c[0]).join(''));
    expect(out.result.found).toBe(false);
    expect(out.warnings[0]).toContain('No ApexClass named "Ghost"');
    expect(process.exitCode).toBeUndefined();
    writeSpy.mockRestore();
  });

  it('handles an empty dependency set gracefully', async () => {
    wireQueries({ idRows: [{ Id: '01p000000000001' }] });
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await createProgram().parseAsync(['node', 'sfdt', 'dependencies', 'Lonely', '--json']);

    const out = JSON.parse(writeSpy.mock.calls.map((c) => c[0]).join(''));
    expect(out.result).toMatchObject({ found: true, references: [], referencedBy: [] });
    writeSpy.mockRestore();
  });

  it('emits an error envelope in --json mode when a query throws', async () => {
    const err = new Error('sf CLI not found');
    query.mockRejectedValueOnce(err);
    resolveExitCode.mockReturnValue(3);
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await createProgram().parseAsync(['node', 'sfdt', 'dependencies', 'MyClass', '--json']);

    expect(process.exitCode).toBe(3);
    const out = JSON.parse(writeSpy.mock.calls.map((c) => c[0]).join(''));
    expect(out).toMatchObject({ status: 3, message: 'sf CLI not found' });
    writeSpy.mockRestore();
  });

  it('sets process.exitCode (non-json) for an unsupported type', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await createProgram().parseAsync(['node', 'sfdt', 'dependencies', 'X', '--type', 'Bogus']);

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Dependencies failed'));
    errorSpy.mockRestore();
  });
});

describe('sfdt dependencies --gaps', () => {
  it('runs the gap report offline (no org required) and emits JSON', async () => {
    loadConfig.mockResolvedValue({ _projectRoot: '/x', defaultOrg: null });
    runGapReport.mockResolvedValue({
      from: { name: 'AccountSvc', type: 'ApexClass' },
      gaps: [{
        from: {},
        ref: { toName: 'BillingHandler', toType: 'ApexClass', kind: 'apex-dynamic', evidence: "Type.forName('BillingHandler')", line: 1 },
        status: 'inferred',
      }],
    });
    // --json emits via process.stdout.write (see emitJson in output.js), not console.log —
    // spy on stdout, matching the --json assertions above in this file.
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await createProgram().parseAsync(['node', 'sfdt', 'dependencies', 'AccountSvc', '--type', 'ApexClass', '--gaps', '--json']);

    expect(runGapReport).toHaveBeenCalledWith(expect.anything(), { name: 'AccountSvc', type: 'ApexClass', org: undefined });
    expect(writeSpy.mock.calls.map((c) => c[0]).join('')).toContain('BillingHandler');
    writeSpy.mockRestore();
  });
});
