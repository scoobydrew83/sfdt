/**
 * Tests for flow-deploy-runner — mocks execa so the runner doesn't shell
 * out to the real `sf` CLI. Each test asserts the spawned argv plus the
 * structured return shape.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const execaCalls = [];
let execaImpl = async () => ({ exitCode: 0, stdout: '{}', stderr: '' });

vi.mock('execa', () => ({
  execa: vi.fn(async (cmd, args, opts) => {
    execaCalls.push({ cmd, args, opts });
    return execaImpl(cmd, args, opts);
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

import { runFlowDeploy } from '../../src/lib/flow-deploy-runner.js';

beforeEach(() => {
  execaCalls.length = 0;
  execaImpl = async () => ({
    exitCode: 0,
    stdout: JSON.stringify({
      status: 0,
      result: {
        id: '0Af000000000001',
        status: 'Succeeded',
        numberComponentsTotal: 1,
        numberComponentErrors: 0,
        numberTestsCompleted: 0,
        details: { componentFailures: [] },
      },
    }),
    stderr: '',
  });
});

describe('runFlowDeploy', () => {
  it('validates required flowApiName', async () => {
    const r = await runFlowDeploy({});
    expect(r.ok).toBe(false);
    expect(r.code).toBe('REQUEST_INVALID');
  });

  it('rejects developer names that aren\'t valid Salesforce identifiers', async () => {
    const r = await runFlowDeploy({ flowApiName: 'Has Space' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('REQUEST_INVALID');
  });

  it('spawns sf project deploy start with the right argv', async () => {
    const r = await runFlowDeploy({ flowApiName: 'EB_Report_Record_Upload_File' });
    expect(r.ok).toBe(true);
    expect(execaCalls).toHaveLength(1);
    const { cmd, args } = execaCalls[0];
    expect(cmd).toBe('sf');
    expect(args).toContain('project');
    expect(args).toContain('deploy');
    expect(args).toContain('start');
    expect(args).toContain('--metadata');
    expect(args).toContain('Flow:EB_Report_Record_Upload_File');
    expect(args).toContain('--target-org');
    expect(args).toContain('dev');
    expect(args).toContain('--json');
  });

  it('passes --dry-run when validateOnly is true', async () => {
    await runFlowDeploy({ flowApiName: 'My_Flow', validateOnly: true });
    expect(execaCalls[0].args).toContain('--dry-run');
  });

  it('omits --dry-run by default', async () => {
    await runFlowDeploy({ flowApiName: 'My_Flow' });
    expect(execaCalls[0].args).not.toContain('--dry-run');
  });

  it('honours an explicit targetOrg', async () => {
    await runFlowDeploy({ flowApiName: 'My_Flow', targetOrg: 'prod-alias' });
    const targetIdx = execaCalls[0].args.indexOf('--target-org');
    expect(execaCalls[0].args[targetIdx + 1]).toBe('prod-alias');
  });

  it('returns a structured success report on a successful deploy', async () => {
    const r = await runFlowDeploy({ flowApiName: 'My_Flow' });
    expect(r.ok).toBe(true);
    expect(r.data.status).toBe('Succeeded');
    expect(r.data.deployId).toBe('0Af000000000001');
    expect(r.data.numberComponentsTotal).toBe(1);
    expect(r.data.componentFailures).toEqual([]);
    expect(r.data.summary).toMatch(/deployed to dev/);
  });

  it('surfaces componentFailures when sf reports a Failed deploy', async () => {
    execaImpl = async () => ({
      exitCode: 1,
      stdout: JSON.stringify({
        status: 1,
        result: {
          id: '0Af000000000002',
          status: 'Failed',
          numberComponentsTotal: 1,
          numberComponentErrors: 1,
          details: {
            componentFailures: [
              {
                fullName: 'Flow.My_Flow',
                problem: 'Variable does not exist',
                problemType: 'Error',
              },
            ],
          },
        },
      }),
      stderr: '',
    });
    const r = await runFlowDeploy({ flowApiName: 'My_Flow' });
    expect(r.ok).toBe(true); // bridge returns ok:true with structured data
    expect(r.data.status).toBe('Failed');
    expect(r.data.componentFailures).toHaveLength(1);
    expect(r.data.componentFailures[0].problem).toMatch(/Variable does not exist/);
    expect(r.data.summary).toMatch(/Deploy failed/);
  });

  it('returns INTERNAL_ERROR when sf CLI returns non-JSON output', async () => {
    execaImpl = async () => ({ exitCode: 0, stdout: 'not-json', stderr: '' });
    const r = await runFlowDeploy({ flowApiName: 'My_Flow' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('INTERNAL_ERROR');
    expect(r.error).toMatch(/non-JSON/);
  });
});
