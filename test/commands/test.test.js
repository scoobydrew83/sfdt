import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../../src/lib/config.js', () => ({
  loadConfig: vi.fn(),
}));

vi.mock('../../src/lib/script-runner.js', () => ({
  runScript: vi.fn(),
}));

vi.mock('execa', () => ({ execa: vi.fn() }));

vi.mock('../../src/lib/ai.js', () => ({
  isAiAvailable: vi.fn(),
  runAiPrompt: vi.fn(),
  providerSupportsAgenticTools: vi.fn(() => true),
}));

vi.mock('../../src/lib/ai-context.js', () => ({
  gatherLatestTestResults: vi.fn(),
  frameProvidedContext: vi.fn(() => '\n[context]'),
}));

vi.mock('inquirer', () => ({
  default: { prompt: vi.fn() },
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
import { execa } from 'execa';
import { runScript } from '../../src/lib/script-runner.js';
import { isAiAvailable, runAiPrompt, providerSupportsAgenticTools } from '../../src/lib/ai.js';
import { gatherLatestTestResults } from '../../src/lib/ai-context.js';
import inquirer from 'inquirer';
import { print } from '../../src/lib/output.js';
import { registerTestCommand } from '../../src/commands/test.js';

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerTestCommand(program);
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
  providerSupportsAgenticTools.mockReturnValue(true);
});

describe('test command', () => {
  it('runs enhanced-test-runner.sh by default', async () => {
    runScript.mockResolvedValue({ exitCode: 0 });

    await createProgram().parseAsync(['node', 'sfdt', 'test']);

    expect(runScript).toHaveBeenCalledWith(
      'core/enhanced-test-runner.sh',
      expect.any(Object),
      expect.objectContaining({ cwd: '/project' }),
    );
    expect(print.success).toHaveBeenCalled();
  });

  it('runs run-tests.sh with --legacy flag', async () => {
    runScript.mockResolvedValue({ exitCode: 0 });

    await createProgram().parseAsync(['node', 'sfdt', 'test', '--legacy']);

    expect(runScript).toHaveBeenCalledWith(
      'core/run-tests.sh',
      expect.any(Object),
      expect.any(Object),
    );
  });

  it('runs only the given classes with --class-names (overrides SFDT_TEST_CLASSES)', async () => {
    runScript.mockResolvedValue({ exitCode: 0 });

    await createProgram().parseAsync(['node', 'sfdt', 'test', '--class-names', ' A_Test, B_Test ,C_Test']);

    expect(runScript).toHaveBeenCalledWith(
      'core/enhanced-test-runner.sh',
      expect.any(Object),
      expect.objectContaining({ env: { SFDT_TEST_CLASSES: 'A_Test,B_Test,C_Test' } }),
    );
  });

  it('does not set SFDT_TEST_CLASSES when --class-names is omitted', async () => {
    runScript.mockResolvedValue({ exitCode: 0 });

    await createProgram().parseAsync(['node', 'sfdt', 'test']);

    expect(runScript).toHaveBeenCalledWith(
      'core/enhanced-test-runner.sh',
      expect.any(Object),
      expect.objectContaining({ env: {} }),
    );
  });

  it('runs test-analyzer with --analyze flag', async () => {
    runScript.mockResolvedValue({ exitCode: 0 });

    await createProgram().parseAsync(['node', 'sfdt', 'test', '--analyze']);

    expect(runScript).toHaveBeenCalledTimes(2);
    expect(runScript).toHaveBeenCalledWith(
      'quality/test-analyzer.sh',
      expect.any(Object),
      expect.any(Object),
    );
  });

  it('offers AI analysis on test failure when AI enabled', async () => {
    runScript.mockRejectedValueOnce(new Error('tests failed'));
    isAiAvailable.mockResolvedValue(true);
    inquirer.prompt.mockResolvedValue({ analyzeFailure: true });
    runAiPrompt.mockResolvedValue({ stdout: 'analysis', exitCode: 0 });

    await createProgram().parseAsync(['node', 'sfdt', 'test']);

    expect(inquirer.prompt).toHaveBeenCalled();
    expect(runAiPrompt).toHaveBeenCalledWith(
      expect.stringContaining('Apex test failures'),
      expect.any(Object),
    );
    expect(process.exitCode).toBe(1);
  });

  it('skips AI analysis when user declines', async () => {
    runScript.mockRejectedValueOnce(new Error('tests failed'));
    isAiAvailable.mockResolvedValue(true);
    inquirer.prompt.mockResolvedValue({ analyzeFailure: false });

    await createProgram().parseAsync(['node', 'sfdt', 'test']);

    expect(runAiPrompt).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('skips AI prompt when AI is disabled', async () => {
    loadConfig.mockResolvedValue({
      _projectRoot: '/project',
      defaultOrg: 'dev',
      features: { ai: false },
    });
    runScript.mockRejectedValueOnce(new Error('tests failed'));

    await createProgram().parseAsync(['node', 'sfdt', 'test']);

    expect(inquirer.prompt).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('warns but continues when the analyzer fails with --analyze', async () => {
    runScript.mockResolvedValueOnce({ exitCode: 0 }); // main run passes
    runScript.mockRejectedValueOnce(new Error('analyzer blew up')); // analyzer fails

    await createProgram().parseAsync(['node', 'sfdt', 'test', '--analyze']);

    expect(print.warning).toHaveBeenCalledWith(expect.stringContaining('analyzer blew up'));
    expect(process.exitCode).toBeUndefined();
  });

  it('skips AI analysis entirely in --dry-run even if the dry-run "fails"', async () => {
    runScript.mockRejectedValueOnce(new Error('tests failed'));
    isAiAvailable.mockResolvedValue(true);

    await createProgram().parseAsync(['node', 'sfdt', 'test', '--dry-run']);

    expect(inquirer.prompt).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it('sets the error exit code when the top-level loadConfig throws', async () => {
    loadConfig.mockRejectedValue(new Error('no config'));

    await createProgram().parseAsync(['node', 'sfdt', 'test']);

    expect(print.error).toHaveBeenCalledWith(expect.stringContaining('no config'));
    expect(process.exitCode).toBe(1);
  });

  describe('--logic (unified Apex + Flow tests)', () => {
    it('runs `sf logic run test` and never touches the shell test runner', async () => {
      execa.mockResolvedValue({ exitCode: 0 });

      await createProgram().parseAsync([
        'node', 'sfdt', 'test', '--logic', '--org', 'qa', '--test-level', 'RunSpecifiedTests',
        '--tests', 'FooTest,FlowTesting.MyFlow', '--code-coverage',
      ]);

      expect(runScript).not.toHaveBeenCalled();
      expect(execa).toHaveBeenCalledWith(
        'sf',
        [
          'logic', 'run', 'test', '--target-org', 'qa', '--wait', '30',
          '--test-level', 'RunSpecifiedTests', '--tests', 'FooTest,FlowTesting.MyFlow', '--code-coverage',
        ],
        // Always stream + capture (execa multi-destination stdio): the capture
        // feeds the zero-test guard and, on failure, the AI analysis.
        { stdout: ['inherit', 'pipe'], stderr: ['inherit', 'pipe'], all: true },
      );
      expect(print.success).toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    });

    it('fails a "passing" run that executed zero tests', async () => {
      execa.mockResolvedValue({ exitCode: 0, all: 'Test Summary\nTests Ran        0' });

      await createProgram().parseAsync(['node', 'sfdt', 'test', '--logic', '--tests', 'NopeTest']);

      expect(print.error).toHaveBeenCalledWith(expect.stringContaining('Zero tests were run'));
      expect(print.error).toHaveBeenCalledWith(expect.stringContaining('NopeTest'));
      expect(print.success).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });

    it('allows a zero-test run with --allow-zero-tests', async () => {
      execa.mockResolvedValue({ exitCode: 0, all: 'Tests Ran        0' });

      await createProgram().parseAsync(['node', 'sfdt', 'test', '--logic', '--allow-zero-tests']);

      expect(print.success).toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    });

    it('falls back to config.defaultOrg when --org is omitted', async () => {
      execa.mockResolvedValue({ exitCode: 0 });

      await createProgram().parseAsync(['node', 'sfdt', 'test', '--logic']);

      expect(execa).toHaveBeenCalledWith('sf', expect.arrayContaining(['--target-org', 'dev']), expect.any(Object));
    });

    it('prints the command and does not run it in --dry-run', async () => {
      await createProgram().parseAsync(['node', 'sfdt', 'test', '--logic', '--dry-run']);

      expect(execa).not.toHaveBeenCalled();
      expect(print.info).toHaveBeenCalledWith(expect.stringContaining('sf logic run test'));
    });

    it('sets the error exit code when logic tests fail', async () => {
      execa.mockRejectedValue(Object.assign(new Error('failing tests'), { exitCode: 1 }));

      await createProgram().parseAsync(['node', 'sfdt', 'test', '--logic']);

      expect(print.error).toHaveBeenCalledWith(expect.stringContaining('Logic tests failed'));
      expect(process.exitCode).toBe(1);
    });

    it('errors clearly on an invalid --test-level (no execa call)', async () => {
      await createProgram().parseAsync(['node', 'sfdt', 'test', '--logic', '--test-level', 'Bogus']);

      expect(execa).not.toHaveBeenCalled();
      expect(print.error).toHaveBeenCalledWith(expect.stringContaining('Invalid --test-level'));
      expect(process.exitCode).toBe(1);
    });

    it('captures output and offers AI analysis on failure, injecting the captured run output', async () => {
      // AI enabled (default config) → capture mode; agentic provider by default.
      execa.mockRejectedValue(Object.assign(new Error('failed'), { exitCode: 1, all: 'LOGIC RUN OUTPUT: 1 failure' }));
      isAiAvailable.mockResolvedValue(true);
      inquirer.prompt.mockResolvedValue({ analyzeFailure: true });
      runAiPrompt.mockResolvedValue({ stdout: '', exitCode: 0 });

      await createProgram().parseAsync(['node', 'sfdt', 'test', '--logic']);

      // stream + capture mode — the capture feeds the AI analysis
      expect(execa).toHaveBeenCalledWith(
        'sf',
        expect.any(Array),
        expect.objectContaining({ all: true }),
      );
      // the captured run output is injected as context for every provider
      expect(gatherLatestTestResults).not.toHaveBeenCalled();
      expect(runAiPrompt).toHaveBeenCalledWith(
        expect.stringContaining('[context]'),
        expect.any(Object),
      );
      expect(process.exitCode).toBe(1);
    });

    it('still captures output but skips AI when features.ai is off', async () => {
      loadConfig.mockResolvedValue({ _projectRoot: '/project', defaultOrg: 'dev', features: { ai: false } });
      execa.mockRejectedValue(Object.assign(new Error('failed'), { exitCode: 1 }));

      await createProgram().parseAsync(['node', 'sfdt', 'test', '--logic']);

      // capture is unconditional now (zero-test guard needs the output);
      // 'inherit' in the stdio arrays keeps the live streaming behavior.
      expect(execa).toHaveBeenCalledWith(
        'sf',
        expect.any(Array),
        expect.objectContaining({ stdout: ['inherit', 'pipe'], all: true }),
      );
      expect(inquirer.prompt).not.toHaveBeenCalled();
      expect(runAiPrompt).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });
  });

  describe('http AI provider (non-agentic)', () => {
    beforeEach(() => {
      providerSupportsAgenticTools.mockReturnValue(false);
      runScript.mockRejectedValueOnce(new Error('tests failed'));
      isAiAvailable.mockResolvedValue(true);
      inquirer.prompt.mockResolvedValue({ analyzeFailure: true });
    });

    it('injects gathered test results into the prompt and prints the analysis', async () => {
      gatherLatestTestResults.mockResolvedValue('RESULTS BLOB');
      runAiPrompt.mockResolvedValue({ stdout: 'the analysis', exitCode: 0 });
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await createProgram().parseAsync(['node', 'sfdt', 'test']);

      expect(gatherLatestTestResults).toHaveBeenCalled();
      expect(runAiPrompt).toHaveBeenCalledWith(
        expect.stringContaining('[context]'),
        expect.objectContaining({ interactive: false }),
      );
      expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('the analysis');
      logSpy.mockRestore();
    });

    it('warns when there are no test-result files to inject', async () => {
      gatherLatestTestResults.mockResolvedValue(null);
      runAiPrompt.mockResolvedValue({ stdout: '', exitCode: 0 });

      await createProgram().parseAsync(['node', 'sfdt', 'test']);

      expect(print.warning).toHaveBeenCalledWith(expect.stringContaining('no test-result files'));
    });

    it('surfaces an AI error on a non-zero exit code', async () => {
      gatherLatestTestResults.mockResolvedValue('RESULTS');
      runAiPrompt.mockResolvedValue({ stdout: '', stderr: 'model down', exitCode: 1 });

      await createProgram().parseAsync(['node', 'sfdt', 'test']);

      expect(print.error).toHaveBeenCalledWith('model down');
    });
  });
});
