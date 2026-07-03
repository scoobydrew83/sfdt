import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../../src/lib/config.js', () => ({
  loadConfig: vi.fn(),
}));

vi.mock('../../src/lib/script-runner.js', () => ({
  runScript: vi.fn(),
}));

vi.mock('../../src/lib/ai.js', () => ({
  isAiAvailable: vi.fn(),
  runAiPrompt: vi.fn(),
}));

vi.mock('../../src/lib/output.js', () => ({
  print: {
    header: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    step: vi.fn(),
  },
}));

import { loadConfig } from '../../src/lib/config.js';
import { runScript } from '../../src/lib/script-runner.js';
import { isAiAvailable, runAiPrompt } from '../../src/lib/ai.js';
import { print } from '../../src/lib/output.js';
import { registerQualityCommand } from '../../src/commands/quality.js';

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerQualityCommand(program);
  return program;
}

beforeEach(() => {
  vi.resetAllMocks();
  process.exitCode = undefined;
  loadConfig.mockResolvedValue({
    _projectRoot: '/project',
    defaultOrg: 'dev',
    features: { ai: true },
  });
});

describe('quality command', () => {
  it('runs code-analyzer by default', async () => {
    runScript.mockResolvedValue({ exitCode: 0, stdout: 'ok' });

    await createProgram().parseAsync(['node', 'sfdt', 'quality']);

    expect(runScript).toHaveBeenCalledTimes(1);
    expect(runScript).toHaveBeenCalledWith(
      'quality/code-analyzer.sh',
      expect.any(Object),
      expect.objectContaining({ interactive: false }),
    );
  });

  it('runs only test-analyzer with --tests', async () => {
    runScript.mockResolvedValue({ exitCode: 0, stdout: 'ok' });

    await createProgram().parseAsync(['node', 'sfdt', 'quality', '--tests']);

    expect(runScript).toHaveBeenCalledTimes(1);
    expect(runScript).toHaveBeenCalledWith(
      'quality/test-analyzer.sh',
      expect.any(Object),
      expect.any(Object),
    );
  });

  it('runs both analyzers with --all', async () => {
    runScript.mockResolvedValue({ exitCode: 0, stdout: 'ok' });

    await createProgram().parseAsync(['node', 'sfdt', 'quality', '--all']);

    expect(runScript).toHaveBeenCalledTimes(2);
    expect(runScript).toHaveBeenCalledWith(
      'quality/code-analyzer.sh',
      expect.any(Object),
      expect.any(Object),
    );
    expect(runScript).toHaveBeenCalledWith(
      'quality/test-analyzer.sh',
      expect.any(Object),
      expect.any(Object),
    );
  });

  it('generates AI fix plan with --fix-plan', async () => {
    runScript.mockResolvedValue({ exitCode: 0, stdout: 'issues found' });
    isAiAvailable.mockResolvedValue(true);
    runAiPrompt.mockResolvedValue({ stdout: 'fix plan', exitCode: 0 });

    await createProgram().parseAsync(['node', 'sfdt', 'quality', '--fix-plan']);

    expect(runAiPrompt).toHaveBeenCalledWith(
      expect.stringContaining('Quality Report'),
      expect.objectContaining({ aiEnabled: true }),
    );
  });

  it('warns when AI unavailable for --fix-plan', async () => {
    runScript.mockResolvedValue({ exitCode: 0, stdout: '' });
    isAiAvailable.mockResolvedValue(false);

    await createProgram().parseAsync(['node', 'sfdt', 'quality', '--fix-plan']);

    expect(print.warning).toHaveBeenCalledWith(expect.stringContaining('not available'));
  });

  it('handles analyzer errors gracefully', async () => {
    const err = new Error('analyzer crashed');
    err.stdout = 'partial output';
    runScript.mockRejectedValue(err);

    await createProgram().parseAsync(['node', 'sfdt', 'quality']);

    expect(print.warning).toHaveBeenCalledWith(expect.stringContaining('found issues'));
  });

  it('warns when the analyzer reports the scan as skipped (scanner not installed)', async () => {
    const stubLine = JSON.stringify({
      status: 'skipped',
      reason: 'sf code-analyzer not installed',
      result: [],
      _sfdt_unavailable: 'sf scanner plugin not installed. Run: sf plugins install @salesforce/sfdx-scanner',
    });
    runScript.mockResolvedValue({ exitCode: 0, stdout: `some log output\n${stubLine}` });

    await createProgram().parseAsync(['node', 'sfdt', 'quality']);

    expect(print.warning).toHaveBeenCalledWith(
      expect.stringContaining('sf code-analyzer not installed'),
    );
    expect(print.warning).toHaveBeenCalledWith(
      expect.stringContaining('sf plugins install @salesforce/sfdx-scanner'),
    );
    // Skipped is not a failure — exit code must stay 0
    expect(process.exitCode).toBeUndefined();
    expect(print.error).not.toHaveBeenCalled();
  });

  it('warns via legacy _sfdt_unavailable marker without status field', async () => {
    const stubLine = JSON.stringify({
      status: 0,
      result: [],
      _sfdt_unavailable: 'sf scanner plugin not installed. Run: sf plugins install @salesforce/sfdx-scanner',
    });
    runScript.mockResolvedValue({ exitCode: 0, stdout: stubLine });

    await createProgram().parseAsync(['node', 'sfdt', 'quality']);

    expect(print.warning).toHaveBeenCalledWith(expect.stringContaining('SKIPPED'));
    expect(process.exitCode).toBeUndefined();
  });

  it('does not print the skipped warning for a real scan result', async () => {
    const scanLine = JSON.stringify({ status: 0, result: [{ fileName: 'A.cls', violations: [] }] });
    runScript.mockResolvedValue({ exitCode: 0, stdout: `log\n${scanLine}` });

    await createProgram().parseAsync(['node', 'sfdt', 'quality']);

    expect(print.warning).not.toHaveBeenCalled();
    expect(print.success).toHaveBeenCalledWith(expect.stringContaining('completed.'));
  });

  it('still warns about skipped scan when the analyzer exits non-zero', async () => {
    const stubLine = JSON.stringify({
      status: 'skipped',
      reason: 'sf code-analyzer not installed',
      result: [],
      _sfdt_unavailable: 'sf scanner plugin not installed. Run: sf plugins install @salesforce/sfdx-scanner',
    });
    const err = new Error('config issues found');
    err.stdout = `partial output\n${stubLine}`;
    runScript.mockRejectedValue(err);

    await createProgram().parseAsync(['node', 'sfdt', 'quality']);

    expect(print.warning).toHaveBeenCalledWith(
      expect.stringContaining('sf code-analyzer not installed'),
    );
    expect(print.warning).toHaveBeenCalledWith(expect.stringContaining('found issues'));
  });

  it('--generate-stubs calls generate-test-stubs.sh', async () => {
    runScript.mockResolvedValue({ exitCode: 0, stdout: '' });

    await createProgram().parseAsync(['node', 'sfdt', 'quality', '--generate-stubs']);

    const stubCall = runScript.mock.calls.find((call) => call[0] === 'quality/generate-test-stubs.sh');
    expect(stubCall).toBeDefined();
    expect(stubCall[2].env).not.toMatchObject({ SFDT_DRY_RUN: 'true' });
  });

  it('--generate-stubs --dry-run passes SFDT_DRY_RUN: true', async () => {
    runScript.mockResolvedValue({ exitCode: 0, stdout: '' });

    await createProgram().parseAsync(['node', 'sfdt', 'quality', '--generate-stubs', '--dry-run']);

    const stubCall = runScript.mock.calls.find((call) => call[0] === 'quality/generate-test-stubs.sh');
    expect(stubCall).toBeDefined();
    expect(stubCall[2].env).toMatchObject({ SFDT_DRY_RUN: 'true' });
  });
});
