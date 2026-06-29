import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../../src/lib/config.js', () => ({ loadConfig: vi.fn() }));
vi.mock('../../src/lib/org-inventory.js', () => ({ fetchOrgInventory: vi.fn() }));
vi.mock('../../src/lib/parallel-retrieve.js', () => ({ parallelRetrieve: vi.fn() }));
vi.mock('../../src/commands/deploy.js', () => ({ runSmartDeploy: vi.fn() }));
vi.mock('execa', () => ({ execa: vi.fn() }));
vi.mock('ora', () => ({ default: () => ({ start: () => ({ succeed: vi.fn(), fail: vi.fn(), text: '' }) }) }));
vi.mock('../../src/lib/output.js', () => ({
  print: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn(), header: vi.fn(), step: vi.fn() },
}));

import { loadConfig } from '../../src/lib/config.js';
import { fetchOrgInventory } from '../../src/lib/org-inventory.js';
import { parallelRetrieve } from '../../src/lib/parallel-retrieve.js';
import { runSmartDeploy } from '../../src/commands/deploy.js';
import { execa } from 'execa';
import { registerRetrofitCommand } from '../../src/commands/retrofit.js';

function run(args) {
  const program = new Command();
  program.exitOverride();
  registerRetrofitCommand(program);
  return program.parseAsync(['node', 'sfdt', 'retrofit', ...args]);
}

beforeEach(() => {
  vi.resetAllMocks();
  process.exitCode = undefined;
  loadConfig.mockResolvedValue({ _projectRoot: '/p', defaultOrg: 'dev' });
  fetchOrgInventory.mockResolvedValue(new Map([['CustomField', new Set(['Account.X__c'])]]));
  parallelRetrieve.mockResolvedValue({ retrieved: 1, total: 1, errors: [] });
});

describe('retrofit', () => {
  it('requires --target unless --no-deploy', async () => {
    await run(['--source', 'prod', '--json']);
    expect(process.exitCode).toBeGreaterThan(0);
  });

  it('retrieve-only with --no-commit does not commit or deploy', async () => {
    execa.mockResolvedValue({ stdout: ' M force-app/x' }); // git status
    await run(['--source', 'prod', '--no-deploy', '--no-commit', '--json']);
    // only git status was called; no git commit, no deploy
    expect(runSmartDeploy).not.toHaveBeenCalled();
    const calledCommit = execa.mock.calls.some((c) => c[1]?.[0] === 'commit');
    expect(calledCommit).toBe(false);
  });

  it('reports nothing to retrofit when the tree is clean', async () => {
    execa.mockResolvedValue({ stdout: '' }); // git status clean
    await run(['--source', 'prod', '--target', 'uat', '--json']);
    expect(runSmartDeploy).not.toHaveBeenCalled();
  });

  it('aborts before retrieving when the source tree is already dirty (auto-commit mode)', async () => {
    // Pre-retrieve guard sees uncommitted work in the source path → must abort
    // before touching the org, so pre-existing WIP is never bundled into the commit.
    execa.mockImplementation((bin, args) => {
      if (args[0] === 'status') return Promise.resolve({ stdout: ' M force-app/wip' });
      return Promise.resolve({ stdout: '' });
    });
    await run(['--source', 'prod', '--target', 'uat', '--json']);
    expect(process.exitCode).toBeGreaterThan(0);
    expect(parallelRetrieve).not.toHaveBeenCalled();
    expect(runSmartDeploy).not.toHaveBeenCalled();
  });

  it('commits and validate-deploys to the target by default', async () => {
    execa.mockImplementation((bin, args) => {
      // Pre-retrieve clean-tree guard is path-scoped (`status --porcelain -- <dir>`);
      // it must see a clean tree. The post-retrieve scan (no `--`) sees the change.
      if (args[0] === 'status' && args.includes('--')) return Promise.resolve({ stdout: '' });
      if (args[0] === 'status') return Promise.resolve({ stdout: ' M force-app/x' });
      return Promise.resolve({ stdout: '' }); // add, commit
    });
    await run(['--source', 'prod', '--target', 'uat', '--json']);
    expect(runSmartDeploy).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ smart: true, org: 'uat', deltaBase: 'HEAD~1', dryRun: true }),
    );
  });

  it('does a real deploy with --execute', async () => {
    execa.mockImplementation((bin, args) => {
      if (args[0] === 'status' && args.includes('--')) return Promise.resolve({ stdout: '' });
      if (args[0] === 'status') return Promise.resolve({ stdout: ' M force-app/x' });
      return Promise.resolve({ stdout: '' });
    });
    await run(['--source', 'prod', '--target', 'uat', '--execute', '--json']);
    expect(runSmartDeploy).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ dryRun: false }),
    );
  });
});
