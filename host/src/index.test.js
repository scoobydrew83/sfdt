import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';

// ── Mocks ────────────────────────────────────────────────────────────────────
// In-memory filesystem keyed by basename; execa records calls and returns a
// scripted result. flow-core's runFlowQuality is stubbed (its scoring is tested
// in flow-core); the bridge-contract subpath loads for real from dist/.
// Hoisted so the vi.mock factories (which run before top-level code) can see them.
const { files, execaCalls, state } = vi.hoisted(() => ({
  files: new Map(),
  execaCalls: [],
  state: { execaImpl: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
}));

vi.mock('fs-extra', async () => {
  const p = await import('path');
  return {
    default: {
      pathExists: vi.fn(async (f) => files.has(p.basename(f))),
      readJson: vi.fn(async (f) => {
        if (!files.has(p.basename(f))) throw new Error(`ENOENT ${f}`);
        return files.get(p.basename(f));
      }),
      ensureDir: vi.fn(async () => {}),
      writeJson: vi.fn(async () => {}),
    },
  };
});

vi.mock('execa', () => ({
  execa: vi.fn(async (cmd, args, opts) => {
    execaCalls.push({ cmd, args, opts });
    return state.execaImpl(cmd, args, opts);
  }),
}));

vi.mock('@sfdt/flow-core', () => ({
  runFlowQuality: vi.fn(() => ({
    summary: { overallScore: 90, rating: 'Excellent', severityCounts: { high: 0 }, categoryCounts: {} },
    issueFamilies: [{}, {}],
  })),
}));

import { handleMessage } from './index.js';

const req = (kind, extra = {}) => ({ requestId: 'r1', kind, ...extra });

beforeEach(() => {
  files.clear();
  execaCalls.length = 0;
  state.execaImpl = async () => ({ exitCode: 0, stdout: '', stderr: '' });
  process.env.SFDT_PROJECT_ROOT = '/project';
});
afterEach(() => {
  delete process.env.SFDT_PROJECT_ROOT;
});

describe('native host — read-only kinds', () => {
  it('quality runs flow-core in-process (no project/spawn)', async () => {
    const res = await handleMessage(req('quality', { flowXml: '{"label":"F"}' }));
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ overallScore: 90, rating: 'Excellent', issueFamilyCount: 2 });
    expect(execaCalls).toHaveLength(0);
  });

  it('quality rejects an unparseable flowXml payload', async () => {
    const res = await handleMessage(req('quality', { flowXml: 'not json' }));
    expect(res.ok).toBe(false);
    expect(res.code).toBe('REQUEST_INVALID');
  });

  it('scan spawns `sfdt scan --json` and reshapes to the bridge contract', async () => {
    state.execaImpl = async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        status: 0,
        result: { org: 'dev', inventory: { ApexClass: ['A', 'B'] }, summary: { totalTypes: 1, totalMembers: 2 } },
        warnings: [],
      }),
      stderr: '',
    });
    const res = await handleMessage(req('scan', { scanType: 'all' }));
    expect(execaCalls[0]).toMatchObject({ cmd: 'sfdt', args: ['scan', '--json'] });
    expect(execaCalls[0].opts).toMatchObject({ cwd: '/project' });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({
      org: 'dev',
      scanType: 'all',
      totalTypes: 1,
      totalMembers: 2,
      inventory: { ApexClass: ['A', 'B'] },
    });
  });

  it('compare spawns the CLI then reshapes logs/compare-latest.json', async () => {
    files.set('compare-latest.json', {
      source: 'dev',
      target: 'qa',
      items: [{ status: 'source-only' }, { status: 'both' }, { status: 'source-only' }],
    });
    const res = await handleMessage(req('compare', { left: 'dev', right: 'qa' }));
    expect(execaCalls[0]).toMatchObject({ cmd: 'sfdt', args: ['compare', '--source', 'dev', '--target', 'qa'] });
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ left: 'dev', right: 'qa', sourceOnly: 2, targetOnly: 0, both: 1 });
    expect(res.data.items).toHaveLength(3);
  });

  it('drift reads the snapshot and filters by component', async () => {
    files.set('drift-latest.json', {
      org: 'dev',
      driftStatus: 'DRIFT',
      timestamp: 't',
      components: [
        { type: 'ApexClass', name: 'Foo' },
        { type: 'Flow', name: 'Bar' },
      ],
    });
    const res = await handleMessage(req('drift', { component: 'apexclass.foo' }));
    expect(res.ok).toBe(true);
    expect(res.data.available).toBe(true);
    expect(res.data.component).toBe('apexclass.foo');
    expect(res.data.components).toEqual([{ type: 'ApexClass', name: 'Foo' }]);
    expect(execaCalls).toHaveLength(0); // no refresh → no spawn
  });

  it('drift with refresh spawns `sfdt drift` before reading the snapshot', async () => {
    files.set('drift-latest.json', { org: 'dev', driftStatus: 'CLEAN', components: [] });
    await handleMessage(req('drift', { component: 'x', refresh: true }));
    expect(execaCalls[0]).toMatchObject({ cmd: 'sfdt', args: ['drift'] });
  });

  it('drift reports unavailable when no snapshot exists', async () => {
    const res = await handleMessage(req('drift', { component: 'x' }));
    expect(res.ok).toBe(true);
    expect(res.data.available).toBe(false);
  });

  it('org-health wraps the audit/monitor snapshots', async () => {
    files.set('audit-latest.json', { timestamp: '2026-01-01', checks: [] });
    // monitor-latest.json intentionally absent → null
    const res = await handleMessage(req('org-health'));
    expect(res.ok).toBe(true);
    expect(res.data.audit).toEqual({ timestamp: '2026-01-01', data: { timestamp: '2026-01-01', checks: [] } });
    expect(res.data.monitor).toBeNull();
  });

  it('returns NOT_FOUND for project-scoped kinds when no project is configured', async () => {
    delete process.env.SFDT_PROJECT_ROOT; // and no host config file present
    const res = await handleMessage(req('scan', { scanType: 'all' }));
    expect(res.ok).toBe(false);
    expect(res.code).toBe('NOT_FOUND');
  });

  it('keeps mutating kinds bridge-only (NOT_IMPLEMENTED)', async () => {
    const valid = {
      deploy: { flowApiName: 'MyFlow' },
      rollback: { flowApiName: 'MyFlow', toVersion: 1 },
      ai: { prompt: 'summarise this flow' },
    };
    for (const [kind, extra] of Object.entries(valid)) {
      const res = await handleMessage(req(kind, extra));
      expect(res.ok, kind).toBe(false);
      expect(res.code, kind).toBe('NOT_IMPLEMENTED');
    }
  });
});
