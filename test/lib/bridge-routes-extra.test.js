/**
 * Additional /api/bridge/exchange dispatch tests covering branches the
 * primary bridge-routes.test.js leaves uncovered:
 *
 *  - deploy / rollback success + error dispatch (flow-*-runner wiring)
 *  - the exchange-level 500 catch when a handler throws
 *  - telemetry.snapshot write failure (outputJson rejects)
 *  - telemetry.snapshot / org-health with no resolved projectRoot
 *  - org-health when a snapshot read throws (readSnapshot swallows → null)
 *
 * Same mocking strategy as bridge-routes.test.js: fs-extra is mocked so the
 * bearer token loads from a known value, and the flow runners are mocked so
 * no `sf` subprocess spawns.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

const FIXED_TOKEN = 'test-bridge-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TOKEN_PATH_SUFFIX = '/.sfdt/bridge-token';
const isTokenPath = (p) => typeof p === 'string' && p.endsWith(TOKEN_PATH_SUFFIX);

const { outputJsonSpy, readJsonSpy, pathExistsSpy } = vi.hoisted(() => ({
  outputJsonSpy: vi.fn().mockResolvedValue(undefined),
  readJsonSpy: vi.fn().mockResolvedValue({}),
  pathExistsSpy: vi.fn(async (p) => isTokenPath(p)),
}));

vi.mock('fs-extra', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(false),
    pathExists: pathExistsSpy,
    readJson: readJsonSpy,
    readdir: vi.fn().mockResolvedValue([]),
    readFile: vi.fn(async (p) => (isTokenPath(p) ? `${FIXED_TOKEN}\n` : '')),
    outputJson: outputJsonSpy,
    stat: vi.fn().mockResolvedValue({ mtime: new Date(), size: 0 }),
    remove: vi.fn().mockResolvedValue(undefined),
    ensureDir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    writeJson: vi.fn().mockResolvedValue(undefined),
    chmod: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('execa', () => ({
  execa: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
}));

vi.mock('../../src/lib/log-writer.js', () => ({
  writeLog: vi.fn(),
  parseSfdtLogLines: vi.fn().mockReturnValue({ checks: [], components: [] }),
  readLatestLog: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/lib/update-checker.js', async (importActual) => ({
  ...(await importActual()),
  fetchLatestVersion: vi.fn().mockResolvedValue('1.0.0'),
}));

vi.mock('../../src/lib/flow-deploy-runner.js', () => ({
  runFlowDeploy: vi.fn(),
}));
vi.mock('../../src/lib/flow-rollback-runner.js', () => ({
  runFlowRollback: vi.fn(),
}));

const { fetchInventorySpy, diffInventoriesSpy } = vi.hoisted(() => ({
  fetchInventorySpy: vi.fn(),
  diffInventoriesSpy: vi.fn(),
}));
vi.mock('../../src/lib/org-inventory.js', () => ({ fetchInventory: fetchInventorySpy }));
vi.mock('../../src/lib/org-diff.js', () => ({ diffInventories: diffInventoriesSpy }));

const { runScriptSpy } = vi.hoisted(() => ({ runScriptSpy: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/lib/script-runner.js', () => ({ runScript: runScriptSpy }));

const { isAiAvailableSpy, runAiPromptSpy } = vi.hoisted(() => ({
  isAiAvailableSpy: vi.fn(),
  runAiPromptSpy: vi.fn(),
}));
vi.mock('../../src/lib/ai.js', async (importActual) => ({
  ...(await importActual()),
  isAiAvailable: isAiAvailableSpy,
  aiUnavailableMessage: () => 'AI provider not installed',
  runAiPrompt: runAiPromptSpy,
}));

import request from 'supertest';
import { createGuiApp } from '../../src/lib/gui-server/index.js';
import { clearBridgeTokenCache } from '../../src/lib/bridge/token.js';
import { runFlowDeploy } from '../../src/lib/flow-deploy-runner.js';
import { runFlowRollback } from '../../src/lib/flow-rollback-runner.js';

const VERSION = '0.99.9';
const PORT = 7654;
const ROOTED_CONFIG = {
  _projectRoot: '/project',
  _configDir: '/project/.sfdt',
  projectName: 'Test',
  defaultOrg: 'dev',
  features: {},
};
// No _projectRoot and no _configDir → resolveProjectRoot returns null.
const ROOTLESS_CONFIG = { projectName: 'Test', defaultOrg: 'dev', features: {} };

const post = (app, body) =>
  request(app)
    .post('/api/bridge/exchange')
    .set('Authorization', `Bearer ${FIXED_TOKEN}`)
    .send(body);

let app;
let rootlessApp;
beforeAll(() => {
  app = createGuiApp(ROOTED_CONFIG, VERSION, PORT);
  rootlessApp = createGuiApp(ROOTLESS_CONFIG, VERSION, PORT);
});
afterAll(async () => {
  await app.cleanup?.();
  await rootlessApp.cleanup?.();
});
beforeEach(() => {
  clearBridgeTokenCache();
  vi.clearAllMocks();
  pathExistsSpy.mockImplementation(async (p) => isTokenPath(p));
  readJsonSpy.mockResolvedValue({});
  outputJsonSpy.mockResolvedValue(undefined);
  fetchInventorySpy.mockResolvedValue(new Map());
  diffInventoriesSpy.mockReturnValue([]);
});

describe('POST /api/bridge/exchange — deploy dispatch', () => {
  it('returns the runner data on a successful deploy', async () => {
    vi.mocked(runFlowDeploy).mockResolvedValue({ ok: true, data: { jobId: '0Af123' } });
    const res = await post(app, { requestId: 'd1', kind: 'deploy', flowApiName: 'My_Flow' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toEqual({ jobId: '0Af123' });
    expect(runFlowDeploy).toHaveBeenCalledWith(expect.objectContaining({ flowApiName: 'My_Flow' }));
  });

  it('maps a runner failure to an error response with its code', async () => {
    vi.mocked(runFlowDeploy).mockResolvedValue({ ok: false, error: 'deploy failed', code: 'DEPLOY_FAILED' });
    const res = await post(app, { requestId: 'd2', kind: 'deploy', flowApiName: 'My_Flow' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBe('DEPLOY_FAILED');
    expect(res.body.error).toBe('deploy failed');
  });

  it('returns 500 with INTERNAL_ERROR when the runner throws (exchange catch)', async () => {
    vi.mocked(runFlowDeploy).mockRejectedValue(new Error('sf crashed'));
    const res = await post(app, { requestId: 'd3', kind: 'deploy', flowApiName: 'My_Flow' });
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(res.body.error).toMatch(/sf crashed/);
  });
});

describe('POST /api/bridge/exchange — rollback dispatch', () => {
  it('returns the runner data on a successful rollback', async () => {
    vi.mocked(runFlowRollback).mockResolvedValue({ ok: true, data: { activeVersion: 0 } });
    const res = await post(app, { requestId: 'rb1', kind: 'rollback', flowApiName: 'My_Flow', toVersion: 0 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toEqual({ activeVersion: 0 });
    expect(runFlowRollback).toHaveBeenCalledWith(expect.objectContaining({ flowApiName: 'My_Flow', toVersion: 0 }));
  });

  it('maps a runner failure to an error response (default code)', async () => {
    vi.mocked(runFlowRollback).mockResolvedValue({ ok: false, error: 'no such version' });
    const res = await post(app, { requestId: 'rb2', kind: 'rollback', flowApiName: 'My_Flow', toVersion: 3 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBe('INTERNAL_ERROR');
  });
});

describe('POST /api/bridge/exchange — scan / compare / drift dispatch', () => {
  it('scan returns the live metadata inventory', async () => {
    fetchInventorySpy.mockResolvedValue(new Map([['ApexClass', new Set(['A', 'B'])]]));
    const res = await post(app, { requestId: 's1', kind: 'scan', scanType: 'all' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.totalTypes).toBe(1);
    expect(res.body.data.totalMembers).toBe(2);
    expect(res.body.data.inventory.ApexClass).toEqual(['A', 'B']);
  });

  it('scan errors when no default org is configured', async () => {
    const noOrgApp = createGuiApp({ ...ROOTED_CONFIG, defaultOrg: undefined }, VERSION, PORT);
    const res = await post(noOrgApp, { requestId: 's2', kind: 'scan', scanType: 'all' });
    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBe('REQUEST_INVALID');
    await noOrgApp.cleanup?.();
  });

  it('compare diffs the two inventories', async () => {
    diffInventoriesSpy.mockReturnValue([
      { type: 'ApexClass', member: 'A', status: 'source-only' },
      { type: 'ApexClass', member: 'B', status: 'both' },
    ]);
    const res = await post(app, { requestId: 'c1', kind: 'compare', left: 'local', right: 'dev' });
    expect(res.status).toBe(200);
    expect(res.body.data.sourceOnly).toBe(1);
    expect(res.body.data.both).toBe(1);
    expect(res.body.data.items).toHaveLength(2);
  });

  it('compare returns INTERNAL_ERROR when inventory fetch throws', async () => {
    fetchInventorySpy.mockRejectedValue(new Error('not authed'));
    const res = await post(app, { requestId: 'c2', kind: 'compare', left: 'local', right: 'dev' });
    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(res.body.error).toMatch(/not authed/);
  });

  it('drift returns the latest snapshot, component-filtered', async () => {
    pathExistsSpy.mockImplementation(async (p) => isTokenPath(p) || String(p).endsWith('drift-latest.json'));
    readJsonSpy.mockImplementation(async (p) =>
      String(p).endsWith('drift-latest.json')
        ? {
            org: 'dev',
            driftStatus: 'WARN',
            components: [
              { type: 'ApexClass', name: 'Foo' },
              { type: 'Flow', name: 'Bar' },
            ],
          }
        : {},
    );
    const res = await post(app, { requestId: 'dr1', kind: 'drift', component: 'foo' });
    expect(res.status).toBe(200);
    expect(res.body.data.available).toBe(true);
    expect(res.body.data.driftStatus).toBe('WARN');
    expect(res.body.data.components).toHaveLength(1);
    expect(res.body.data.components[0].name).toBe('Foo');
  });

  it('drift with refresh:true runs the drift script before reading the snapshot', async () => {
    runScriptSpy.mockResolvedValue(undefined);
    pathExistsSpy.mockImplementation(async (p) => isTokenPath(p) || String(p).endsWith('drift-latest.json'));
    readJsonSpy.mockImplementation(async (p) =>
      String(p).endsWith('drift-latest.json') ? { org: 'dev', driftStatus: 'PASS', components: [] } : {},
    );
    const res = await post(app, { requestId: 'dr3', kind: 'drift', component: 'Account', refresh: true });
    expect(runScriptSpy).toHaveBeenCalledWith('ops/drift.sh', expect.anything(), expect.objectContaining({ cwd: expect.any(String) }));
    expect(res.status).toBe(200);
    expect(res.body.data.available).toBe(true);
    expect(res.body.data.driftStatus).toBe('PASS');
  });

  it('drift without refresh does NOT run the script', async () => {
    pathExistsSpy.mockImplementation(async (p) => isTokenPath(p) || String(p).endsWith('drift-latest.json'));
    readJsonSpy.mockImplementation(async (p) =>
      String(p).endsWith('drift-latest.json') ? { org: 'dev', driftStatus: 'PASS', components: [] } : {},
    );
    await post(app, { requestId: 'dr4', kind: 'drift', component: 'Account' });
    expect(runScriptSpy).not.toHaveBeenCalled();
  });

  it('drift reports unavailable when there is no snapshot', async () => {
    pathExistsSpy.mockImplementation(async (p) => isTokenPath(p)); // drift file absent
    const res = await post(app, { requestId: 'dr2', kind: 'drift', component: 'AnyComponent' });
    expect(res.status).toBe(200);
    expect(res.body.data.available).toBe(false);
    expect(res.body.data.hint).toMatch(/sfdt drift/);
  });
});

describe('POST /api/bridge/exchange — ai dispatch', () => {
  const AI_CONFIG = { ...ROOTED_CONFIG, features: { ai: true }, ai: { provider: 'claude' } };

  it('runs the prompt through the configured provider when AI is enabled', async () => {
    isAiAvailableSpy.mockResolvedValue(true);
    runAiPromptSpy.mockResolvedValue('the answer');
    const aiApp = createGuiApp(AI_CONFIG, VERSION, PORT);
    const res = await post(aiApp, { requestId: 'ai1', kind: 'ai', prompt: 'why?' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.response).toBe('the answer');
    expect(res.body.data.provider).toBe('claude');
    expect(runAiPromptSpy).toHaveBeenCalledWith('why?', expect.objectContaining({ aiEnabled: true, interactive: false }));
    await aiApp.cleanup?.();
  });

  it('folds provided context into the prompt', async () => {
    isAiAvailableSpy.mockResolvedValue(true);
    runAiPromptSpy.mockResolvedValue('ok');
    const aiApp = createGuiApp(AI_CONFIG, VERSION, PORT);
    await post(aiApp, { requestId: 'ai2', kind: 'ai', prompt: 'explain', context: { flow: 'My_Flow' } });
    expect(runAiPromptSpy.mock.calls[0][0]).toMatch(/explain[\s\S]*My_Flow/);
    await aiApp.cleanup?.();
  });

  it('reports REQUEST_INVALID when the provider is unavailable', async () => {
    isAiAvailableSpy.mockResolvedValue(false);
    const aiApp = createGuiApp(AI_CONFIG, VERSION, PORT);
    const res = await post(aiApp, { requestId: 'ai3', kind: 'ai', prompt: 'why?' });
    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBe('REQUEST_INVALID');
    expect(res.body.error).toMatch(/not installed/);
    await aiApp.cleanup?.();
  });

  it('maps a provider throw to INTERNAL_ERROR', async () => {
    isAiAvailableSpy.mockResolvedValue(true);
    runAiPromptSpy.mockRejectedValue(new Error('claude crashed'));
    const aiApp = createGuiApp(AI_CONFIG, VERSION, PORT);
    const res = await post(aiApp, { requestId: 'ai4', kind: 'ai', prompt: 'why?' });
    expect(res.status).toBe(200); // handler catches and returns an error response
    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(res.body.error).toMatch(/claude crashed/);
    await aiApp.cleanup?.();
  });
});

describe('POST /api/bridge/exchange — telemetry.snapshot edge cases', () => {
  it('returns INTERNAL_ERROR when outputJson throws', async () => {
    outputJsonSpy.mockRejectedValue(new Error('ENOSPC'));
    const res = await post(app, {
      requestId: 't1',
      kind: 'telemetry.snapshot',
      monthKey: '2026-06',
      counters: {},
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(res.body.error).toMatch(/Could not write telemetry snapshot/);
  });

  it('returns INTERNAL_ERROR when no project root is resolved', async () => {
    const res = await post(rootlessApp, {
      requestId: 't2',
      kind: 'telemetry.snapshot',
      monthKey: '2026-06',
      counters: {},
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(res.body.error).toMatch(/no project root/i);
  });
});

describe('POST /api/bridge/exchange — org-health edge cases', () => {
  it('returns INTERNAL_ERROR when no project root is resolved', async () => {
    const res = await post(rootlessApp, { requestId: 'oh1', kind: 'org-health' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(res.body.error).toMatch(/no project root/i);
  });

  it('returns null snapshots when a snapshot read throws (readSnapshot swallows)', async () => {
    // Snapshot files appear to exist, but readJson rejects → each readSnapshot
    // hits its catch and returns null.
    pathExistsSpy.mockImplementation(
      async (p) => isTokenPath(p) || /(audit|monitor)-latest\.json$/.test(p),
    );
    readJsonSpy.mockRejectedValue(new Error('corrupt snapshot'));
    const res = await post(app, { requestId: 'oh2', kind: 'org-health' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toEqual({ audit: null, monitor: null });
  });
});
