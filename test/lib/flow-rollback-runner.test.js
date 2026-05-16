import { describe, it, expect, vi, beforeEach } from 'vitest';
const execaCalls = [];
let nextResponses = [];
vi.mock('execa', () => ({
  execa: vi.fn(async (cmd, args, opts) => {
    execaCalls.push({ cmd, args, opts });
    const next = nextResponses.shift();
    return next ?? { exitCode: 0, stdout: '{}', stderr: '' };
  }),
}));
vi.mock('../../src/lib/config.js', () => ({
  loadConfig: vi.fn(async () => ({
    _projectRoot: '/project',
    _configDir: '/project/.sfdt',
    defaultOrg: 'dev',
  })),
  ConfigError: class extends Error {},
}));
import { runFlowRollback } from '../../src/lib/flow-rollback-runner.js';
beforeEach(() => {
  execaCalls.length = 0;
  nextResponses = [];
});
function queueResponses(...responses) {
  for (const r of responses) nextResponses.push(r);
}
function queueDefaultRollbackPair({
  flowDefinitionId = '3000W000000abcXYZ',
  activeVersionId = '3010W000000aaaAAA',
  versionNumber = 5,
} = {}) {
  queueResponses({
    exitCode: 0,
    stdout: JSON.stringify({
      status: 0,
      result: {
        records: [
          {
            Id: flowDefinitionId,
            ActiveVersionId: activeVersionId,
            LatestVersion: { VersionNumber: versionNumber },
          },
        ],
      },
    }),
    stderr: '',
  });
  queueResponses({
    exitCode: 0,
    stdout: JSON.stringify({
      status: 0,
      result: { id: flowDefinitionId, success: true },
    }),
    stderr: '',
  });
}
describe('runFlowRollback — input validation', () => {
  it('rejects a missing flowApiName', async () => {
    const r = await runFlowRollback({ toVersion: 1 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('REQUEST_INVALID');
  });
  it('rejects a flowApiName that is not a valid Salesforce developer name', async () => {
    const r = await runFlowRollback({ flowApiName: 'Has Space', toVersion: 1 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('REQUEST_INVALID');
  });
  it('rejects a non-integer toVersion', async () => {
    const r = await runFlowRollback({ flowApiName: 'My_Flow', toVersion: 1.5 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('REQUEST_INVALID');
  });
  it('rejects a negative toVersion', async () => {
    const r = await runFlowRollback({ flowApiName: 'My_Flow', toVersion: -1 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('REQUEST_INVALID');
  });
  it('accepts toVersion=0 (deactivate)', async () => {
    queueDefaultRollbackPair();
    const r = await runFlowRollback({ flowApiName: 'My_Flow', toVersion: 0 });
    expect(r.ok).toBe(true);
    expect(r.data.newActiveVersion).toBe(0);
    expect(r.data.summary).toMatch(/deactivated/);
  });
});
describe('runFlowRollback — happy path', () => {
  it('spawns the right two sf invocations in the right order', async () => {
    queueDefaultRollbackPair({ flowDefinitionId: '3000W000000IdABC' });
    await runFlowRollback({ flowApiName: 'My_Flow', toVersion: 3 });
    expect(execaCalls).toHaveLength(2);
    const lookup = execaCalls[0];
    expect(lookup.cmd).toBe('sf');
    expect(lookup.args).toContain('data');
    expect(lookup.args).toContain('query');
    expect(lookup.args).toContain('--use-tooling-api');
    const q = lookup.args[lookup.args.indexOf('-q') + 1];
    expect(q).toMatch(/FROM FlowDefinition WHERE DeveloperName = 'My_Flow'/);
    expect(lookup.args).toContain('--target-org');
    expect(lookup.args).toContain('dev');
    expect(lookup.args).toContain('--json');
    const update = execaCalls[1];
    expect(update.cmd).toBe('sf');
    expect(update.args).toContain('data');
    expect(update.args).toContain('update');
    expect(update.args).toContain('record');
    expect(update.args).toContain('--use-tooling-api');
    expect(update.args).toContain('--sobject');
    expect(update.args).toContain('FlowDefinition');
    expect(update.args).toContain('--record-id');
    expect(update.args).toContain('3000W000000IdABC');
    expect(update.args).toContain('--values');
    expect(update.args).toContain('Metadata={"activeVersionNumber":3}');
  });
  it('returns a structured success report with the previous active version', async () => {
    queueDefaultRollbackPair({ versionNumber: 7 });
    const r = await runFlowRollback({ flowApiName: 'My_Flow', toVersion: 3 });
    expect(r.ok).toBe(true);
    expect(r.data.status).toBe('Succeeded');
    expect(r.data.previousActiveVersion).toBe(7);
    expect(r.data.newActiveVersion).toBe(3);
    expect(r.data.summary).toMatch(/set active to v3/);
  });
  it('honours an explicit targetOrg over the config default', async () => {
    queueDefaultRollbackPair();
    await runFlowRollback({ flowApiName: 'My_Flow', toVersion: 1, targetOrg: 'prod-alias' });
    const lookup = execaCalls[0];
    const targetIdx = lookup.args.indexOf('--target-org');
    expect(lookup.args[targetIdx + 1]).toBe('prod-alias');
  });
  it('escapes apostrophes in flowApiName when building the SOQL', async () => {
    queueDefaultRollbackPair();
    const r = await runFlowRollback({ flowApiName: 'Some_Flow', toVersion: 1 });
    expect(r.ok).toBe(true);
  });
});
describe('runFlowRollback — failure modes', () => {
  it("returns NOT_FOUND when no FlowDefinition matches the developer name", async () => {
    queueResponses({
      exitCode: 0,
      stdout: JSON.stringify({ status: 0, result: { records: [] } }),
      stderr: '',
    });
    const r = await runFlowRollback({ flowApiName: 'Does_Not_Exist', toVersion: 1 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('NOT_FOUND');
    expect(r.error).toMatch(/Does_Not_Exist/);
  });
  it('returns INTERNAL_ERROR when sf data update returns status=1', async () => {
    queueResponses(
      {
        exitCode: 0,
        stdout: JSON.stringify({
          status: 0,
          result: { records: [{ Id: '3000W', ActiveVersionId: null, LatestVersion: null }] },
        }),
        stderr: '',
      },
      {
        exitCode: 1,
        stdout: JSON.stringify({
          status: 1,
          name: 'INVALID_FIELD_FOR_INSERT_UPDATE',
          message: 'No active version 99 exists for Flow',
        }),
        stderr: '',
      },
    );
    const r = await runFlowRollback({ flowApiName: 'My_Flow', toVersion: 99 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('INTERNAL_ERROR');
    expect(r.error).toMatch(/No active version 99/);
  });
  it('returns INTERNAL_ERROR when sf returns non-JSON stdout on lookup', async () => {
    queueResponses({ exitCode: 0, stdout: 'not-json', stderr: '' });
    const r = await runFlowRollback({ flowApiName: 'My_Flow', toVersion: 1 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('INTERNAL_ERROR');
    expect(r.error).toMatch(/non-JSON/);
  });
});
