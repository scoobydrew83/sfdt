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

  it('registers all expected commands', () => {
    const program = createCli();
    const commandNames = program.commands.map((cmd) => cmd.name());

    const expected = [
      'init',
      'deploy',
      'release',
      'test',
      'pull',
      'quality',
      'preflight',
      'rollback',
      'smoke',
      'review',
      'notify',
      'drift',
      'completion',
      'version',
    ];

    for (const name of expected) {
      expect(commandNames).toContain(name);
    }
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
