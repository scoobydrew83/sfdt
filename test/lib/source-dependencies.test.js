import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';

vi.mock('../../src/lib/org-query.js', () => ({ query: vi.fn() }));
import { query } from '../../src/lib/org-query.js';
import { enumerateSourceFiles, gapsForComponent, runGapReport } from '../../src/lib/source-dependencies.js';

let root;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'sfdt-srcdep-'));
  const base = path.join(root, 'force-app/main/default');
  await fs.outputFile(path.join(base, 'classes/AccountSvc.cls'),
    "public class AccountSvc { void go(){ Type.forName('BillingHandler'); } }");
  await fs.outputFile(path.join(base, 'lwc/foo/foo.js'),
    "import m from '@salesforce/apex/AccountSvc.getAll';");
  vi.clearAllMocks();
});
afterEach(async () => { await fs.remove(root); });

const cfg = () => ({ _projectRoot: root, defaultSourcePath: 'force-app/main/default', packageDirectories: [{ name: 'force-app', path: 'force-app/main/default' }] });

describe('enumerateSourceFiles', () => {
  it('finds apex and lwc js files under the package dir', async () => {
    const files = await enumerateSourceFiles(cfg());
    expect(files.apex.some((f) => f.endsWith('AccountSvc.cls'))).toBe(true);
    expect(files.lwcJs.some((f) => f.endsWith('foo.js'))).toBe(true);
  });
});

describe('gapsForComponent', () => {
  it('returns inferred refs parsed from an Apex class body', async () => {
    const { refs } = await gapsForComponent(cfg(), { name: 'AccountSvc', type: 'ApexClass' });
    expect(refs.map((r) => r.toName)).toContain('BillingHandler');
  });
  it('returns empty refs (no throw) when the component has no local source', async () => {
    const { refs } = await gapsForComponent(cfg(), { name: 'Nope', type: 'ApexClass' });
    expect(refs).toEqual([]);
  });
});

describe('runGapReport diff', () => {
  it('marks refs missing/confirmed against Tooling when org is given', async () => {
    // resolve -> id, then referencesQuery -> one confirmed ref (a different class)
    vi.mocked(query)
      .mockResolvedValueOnce([{ Id: '01pXXXXXXXXXXXX' }]) // resolveQueryFor
      .mockResolvedValueOnce([{ RefMetadataComponentName: 'SomethingElse', RefMetadataComponentType: 'ApexClass' }]); // referencesQuery
    const rep = await runGapReport(cfg(), { name: 'AccountSvc', type: 'ApexClass', org: 'dev' });
    const billing = rep.gaps.find((g) => g.ref.toName === 'BillingHandler');
    expect(billing.status).toBe('missing');
  });
  it('uses status "inferred" when no org is given', async () => {
    const rep = await runGapReport(cfg(), { name: 'AccountSvc', type: 'ApexClass' });
    expect(rep.gaps.every((g) => g.status === 'inferred')).toBe(true);
    expect(query).not.toHaveBeenCalled();
  });
  it('degrades to "inferred" (never throws) when the org query fails', async () => {
    vi.mocked(query).mockRejectedValue(new Error('org down'));
    const rep = await runGapReport(cfg(), { name: 'AccountSvc', type: 'ApexClass', org: 'dev' });
    expect(rep.gaps.every((g) => g.status === 'inferred')).toBe(true);
  });
});
