import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerCompletionCommand } from '../../src/commands/completion.js';

vi.mock('../../src/lib/output.js', () => ({
  print: {
    error: vi.fn(),
    info: vi.fn(),
    step: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    header: vi.fn(),
  },
}));

import { print } from '../../src/lib/output.js';

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerCompletionCommand(program);
  return program;
}

describe('completion command', () => {
  let stdoutWrite;
  let captured;

  beforeEach(() => {
    vi.resetAllMocks();
    process.exitCode = undefined;
    captured = '';
    stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      captured += chunk;
      return true;
    });
  });

  afterEach(() => {
    stdoutWrite.mockRestore();
  });

  it('generates bash completion script', async () => {
    await createProgram().parseAsync(['node', 'sfdt', 'completion', 'bash']);

    expect(captured).toContain('_sfdt_completions');
    expect(captured).toContain('complete -F _sfdt_completions sfdt');
    expect(captured).toContain('deploy');
    expect(captured).toContain('--dry-run');
  });

  it('generates zsh completion script', async () => {
    await createProgram().parseAsync(['node', 'sfdt', 'completion', 'zsh']);

    expect(captured).toContain('#compdef sfdt');
    expect(captured).toContain('_sfdt_commands');
    expect(captured).toContain('_sfdt');
  });

  it('generates fish completion script', async () => {
    await createProgram().parseAsync(['node', 'sfdt', 'completion', 'fish']);

    expect(captured).toContain('sfdt fish completion');
    expect(captured).toContain('complete -c sfdt');
    expect(captured).toContain('__fish_use_subcommand');
  });

  it('bash script includes all major commands', async () => {
    await createProgram().parseAsync(['node', 'sfdt', 'completion', 'bash']);

    const commands = ['init', 'deploy', 'release', 'test', 'pull', 'preflight', 'rollback', 'smoke', 'ui'];
    for (const cmd of commands) {
      expect(captured).toContain(cmd);
    }
  });

  it('zsh script includes command descriptions', async () => {
    await createProgram().parseAsync(['node', 'sfdt', 'completion', 'zsh']);

    expect(captured).toContain('Deploy to a Salesforce org');
    expect(captured).toContain('Run Apex tests');
  });

  it('fish script includes per-command flags', async () => {
    await createProgram().parseAsync(['node', 'sfdt', 'completion', 'fish']);

    // Fish uses `-l <flag>` syntax (long option without --)
    expect(captured).toContain('-l dry-run');
    expect(captured).toContain('-l managed');
    expect(captured).toContain('__fish_seen_subcommand_from deploy');
  });

  it('prints error and sets exitCode 1 when no shell specified', async () => {
    await createProgram().parseAsync(['node', 'sfdt', 'completion']);

    expect(print.error).toHaveBeenCalledWith(expect.stringContaining('bash|zsh|fish'));
    expect(process.exitCode).toBe(1);
  });

  it('prints error for unknown shell', async () => {
    await createProgram().parseAsync(['node', 'sfdt', 'completion', 'powershell']);

    expect(print.error).toHaveBeenCalledWith(expect.stringContaining('bash|zsh|fish'));
    expect(process.exitCode).toBe(1);
  });

  it('is case-insensitive for shell argument', async () => {
    await createProgram().parseAsync(['node', 'sfdt', 'completion', 'BASH']);

    expect(captured).toContain('_sfdt_completions');
  });
});
