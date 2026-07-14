import { describe, it, expect, vi } from 'vitest';
import { createCli } from '../src/cli.js';

describe('createCli', () => {
  it('creates a Commander program with correct name', () => {
    const program = createCli();
    expect(program.name()).toBe('sfdt');
  });

  it('has a version set', () => {
    const program = createCli();
    expect(program.version()).toBeDefined();
    expect(program.version()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('registers exactly the expected commands', () => {
    const program = createCli();
    const commandNames = program.commands.map((cmd) => cmd.name());

    // Exact-set (not toContain) so both drift directions fail: a new command file
    // left unwired in src/cli.js, or a command silently dropped. `help` is
    // Commander's built-in (addHelpCommand) and is materialized lazily, so it
    // does not appear in program.commands here — it's intentionally not listed.
    const expected = [
      'init',
      'deploy',
      'release',
      'test',
      'agent-test',
      'pull',
      'quality',
      'preflight',
      'rollback',
      'smoke',
      'review',
      'notify',
      'drift',
      'changelog',
      'manifest',
      'explain',
      'pr-description',
      'ui',
      'compare',
      'completion',
      'update',
      'config',
      'ai',
      'scan',
      'dependencies',
      'coverage',
      'audit',
      'monitor',
      'docs',
      'data',
      'scratch',
      'flow',
      'extension',
      'feature-flags',
      'doctor',
      'mcp',
      'plugin',
      'skills',
      'ci',
      'pr',
      'retrofit',
      'history',
      'versions',
      'version',
    ];

    expect([...commandNames].sort()).toEqual([...expected].sort());
  });

  it('does not register duplicate commands', () => {
    const program = createCli();
    const commandNames = program.commands.map((cmd) => cmd.name());
    const unique = new Set(commandNames);
    expect(unique.size).toBe(commandNames.length);
  });

  it('version command prints sfdt vX.Y.Z', async () => {
    const program = createCli();
    program.exitOverride();

    const lines = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => lines.push(args.join(' ')));

    await program.parseAsync(['node', 'sfdt', 'version']);

    spy.mockRestore();
    expect(lines.some((l) => /sfdt v\d+\.\d+\.\d+/.test(l))).toBe(true);
  });
});
