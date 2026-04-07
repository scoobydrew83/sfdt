import { describe, it, expect } from 'vitest';
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
});
