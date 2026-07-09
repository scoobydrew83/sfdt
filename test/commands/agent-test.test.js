import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../../src/lib/config.js', () => ({ loadConfig: vi.fn() }));
vi.mock('execa', () => ({ execa: vi.fn() }));
vi.mock('../../src/lib/github-pr.js', () => ({ postPrComment: vi.fn() }));
vi.mock('../../src/lib/notifier.js', () => ({ dispatch: vi.fn(), notificationsConfigured: vi.fn() }));
vi.mock('../../src/lib/output.js', () => ({
  print: { header: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

import { loadConfig } from '../../src/lib/config.js';
import { execa } from 'execa';
import { postPrComment } from '../../src/lib/github-pr.js';
import { dispatch, notificationsConfigured } from '../../src/lib/notifier.js';
import { print } from '../../src/lib/output.js';
import { registerAgentTestCommand } from '../../src/commands/agent-test.js';

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerAgentTestCommand(program);
  return program;
}

beforeEach(() => {
  vi.resetAllMocks();
  process.exitCode = undefined;
  loadConfig.mockResolvedValue({ _projectRoot: '/project', defaultOrg: 'dev', projectName: 'Proj', features: {} });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('agent-test command', () => {
  it('runs `sf agent test run` and passes on exit 0', async () => {
    execa.mockResolvedValue({ all: 'PASS: 5/5', exitCode: 0 });

    await createProgram().parseAsync(['node', 'sfdt', 'agent-test', '--spec', 'MyTest', '--org', 'qa']);

    expect(execa).toHaveBeenCalledWith(
      'sf',
      ['agent', 'test', 'run', '--api-name', 'MyTest', '--target-org', 'qa', '--wait', '30', '--json'],
      { all: true },
    );
    expect(print.success).toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it('falls back to config.defaultOrg when --org is omitted', async () => {
    execa.mockResolvedValue({ all: 'ok', exitCode: 0 });
    await createProgram().parseAsync(['node', 'sfdt', 'agent-test', '--spec', 'MyTest']);
    expect(execa).toHaveBeenCalledWith('sf', expect.arrayContaining(['--target-org', 'dev']), { all: true });
  });

  it('sets a non-zero exit code when the agent test fails', async () => {
    execa.mockRejectedValue(Object.assign(new Error('eval failed'), { exitCode: 1, all: 'FAIL: 2/5' }));

    await createProgram().parseAsync(['node', 'sfdt', 'agent-test', '--spec', 'MyTest']);

    expect(print.error).toHaveBeenCalledWith('Agent tests failed.');
    expect(process.exitCode).toBe(1);
  });

  it('dispatches agent-test-success on pass with --notify', async () => {
    execa.mockResolvedValue({ all: 'ok', exitCode: 0 });
    notificationsConfigured.mockReturnValue(true);
    dispatch.mockResolvedValue([{ channel: 'slack', ok: true }]);

    await createProgram().parseAsync(['node', 'sfdt', 'agent-test', '--spec', 'MyTest', '--notify']);

    expect(dispatch).toHaveBeenCalledWith('agent-test-success', expect.objectContaining({ org: 'dev' }), expect.any(Object));
  });

  it('dispatches agent-test-failure on failure with --notify', async () => {
    execa.mockRejectedValue(Object.assign(new Error('x'), { exitCode: 1 }));
    notificationsConfigured.mockReturnValue(true);
    dispatch.mockResolvedValue([{ channel: 'teams', ok: true }]);

    await createProgram().parseAsync(['node', 'sfdt', 'agent-test', '--spec', 'MyTest', '--notify']);

    expect(dispatch).toHaveBeenCalledWith('agent-test-failure', expect.any(Object), expect.any(Object));
  });

  it('skips dispatch when --notify but no channels configured', async () => {
    execa.mockResolvedValue({ all: 'ok', exitCode: 0 });
    notificationsConfigured.mockReturnValue(false);

    await createProgram().parseAsync(['node', 'sfdt', 'agent-test', '--spec', 'MyTest', '--notify']);

    expect(dispatch).not.toHaveBeenCalled();
    expect(print.info).toHaveBeenCalledWith(expect.stringContaining('no notification channels'));
  });

  it('--threshold passes despite a non-zero exit when the pass rate clears the bar', async () => {
    // 4/5 pass = 80%; sf exits non-zero because one test failed, but 80 >= 80.
    const result = {
      result: {
        testCases: [
          { testResults: [{ result: 'PASS' }] },
          { testResults: [{ result: 'PASS' }] },
          { testResults: [{ result: 'PASS' }] },
          { testResults: [{ result: 'PASS' }] },
          { testResults: [{ result: 'FAIL' }] },
        ],
      },
    };
    execa.mockRejectedValue(Object.assign(new Error('one failed'), { exitCode: 1, stdout: JSON.stringify(result), all: 'x' }));

    await createProgram().parseAsync(['node', 'sfdt', 'agent-test', '--spec', 'MyTest', '--threshold', '80']);

    expect(print.success).toHaveBeenCalledWith(expect.stringContaining('80.0% (4/5)'));
    expect(process.exitCode).toBeUndefined();
  });

  it('--threshold fails and sets a non-zero exit when the pass rate is below the bar', async () => {
    const result = {
      result: { testCases: [{ testResults: [{ result: 'PASS' }] }, { testResults: [{ result: 'FAIL' }] }] },
    };
    execa.mockRejectedValue(Object.assign(new Error('failed'), { exitCode: 1, stdout: JSON.stringify(result), all: 'x' }));

    await createProgram().parseAsync(['node', 'sfdt', 'agent-test', '--spec', 'MyTest', '--threshold', '80']);

    expect(print.error).toHaveBeenCalledWith(expect.stringContaining('50.0% (1/2)'));
    expect(process.exitCode).toBe(1);
  });

  it('--threshold dispatches agent-test-success when the rate clears the bar', async () => {
    const result = { result: { testCases: [{ testResults: [{ result: 'PASS' }] }] } };
    execa.mockResolvedValue({ stdout: JSON.stringify(result), all: 'x', exitCode: 0 });
    notificationsConfigured.mockReturnValue(true);
    dispatch.mockResolvedValue([{ channel: 'slack', ok: true }]);

    await createProgram().parseAsync(['node', 'sfdt', 'agent-test', '--spec', 'MyTest', '--threshold', '100', '--notify']);

    expect(dispatch).toHaveBeenCalledWith('agent-test-success', expect.any(Object), expect.any(Object));
  });

  it('posts a pass/fail summary to the PR with --pr-comment', async () => {
    execa.mockResolvedValue({ all: 'ok', exitCode: 0 });
    postPrComment.mockResolvedValue({ ok: true });

    await createProgram().parseAsync(['node', 'sfdt', 'agent-test', '--spec', 'MyTest', '--pr-comment']);

    expect(postPrComment).toHaveBeenCalledWith(
      expect.stringContaining('✅ passed'),
      expect.objectContaining({ cwd: '/project' }),
    );
  });

  it('warns (does not throw) when the PR comment cannot be posted', async () => {
    execa.mockRejectedValue(Object.assign(new Error('x'), { exitCode: 1, all: 'fail' }));
    postPrComment.mockResolvedValue({ ok: false, error: 'no PR' });

    await createProgram().parseAsync(['node', 'sfdt', 'agent-test', '--spec', 'MyTest', '--pr-comment']);

    expect(postPrComment).toHaveBeenCalledWith(expect.stringContaining('❌ failed'), expect.any(Object));
    expect(print.warning).toHaveBeenCalledWith(expect.stringContaining('Could not post PR comment'));
    expect(process.exitCode).toBe(1);
  });
});
