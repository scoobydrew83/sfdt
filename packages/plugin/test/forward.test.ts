import { describe, it, expect, vi, beforeEach } from 'vitest';

const execaMock = vi.fn();
vi.mock('execa', () => ({ execa: (...args: unknown[]) => execaMock(...args) }));

// Point the forwarder at a fake bin so it doesn't need @sfdt/cli resolvable in
// the monorepo (the root package isn't symlinked into node_modules).
const FAKE_BIN = '/fake/node_modules/@sfdt/cli/bin/sfdt.js';

describe('forward', () => {
  beforeEach(() => {
    execaMock.mockReset();
    process.env.SFDT_CLI_ENTRYPOINT = FAKE_BIN;
  });

  it('spawns node with the bundled sfdt bin, sets non-interactive env, and propagates the exit code', async () => {
    execaMock.mockResolvedValue({ exitCode: 3 });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('__exit__');
    }) as never);

    const { forward } = await import('../src/lib/forward');
    await expect(forward(['drift', '--json'])).rejects.toThrow('__exit__');

    const [cmd, args, opts] = execaMock.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(cmd).toBe('node');
    expect(args[0]).toBe(FAKE_BIN);
    expect(args.slice(1)).toEqual(['drift', '--json']);
    expect(opts.stdio).toBe('inherit');
    expect(opts.reject).toBe(false);
    expect((opts.env as Record<string, string>).SFDT_NON_INTERACTIVE).toBe('true');
    expect(exitSpy).toHaveBeenCalledWith(3);

    exitSpy.mockRestore();
  });

  it('defaults to exit code 0 when execa returns a nullish exitCode', async () => {
    execaMock.mockResolvedValue({ exitCode: undefined });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('__exit__');
    }) as never);

    const { forward } = await import('../src/lib/forward');
    await expect(forward(['version'])).rejects.toThrow('__exit__');
    expect(exitSpy).toHaveBeenCalledWith(0);

    exitSpy.mockRestore();
  });

  it('falls back to require.resolve(@sfdt/cli) when SFDT_CLI_ENTRYPOINT is unset', async () => {
    // With no override, entrypoint() takes the right-hand branch of the `||` and
    // resolves the bundled @sfdt/cli bin (a runtime dep present in node_modules).
    delete process.env.SFDT_CLI_ENTRYPOINT;
    execaMock.mockResolvedValue({ exitCode: 0 });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('__exit__');
    }) as never);

    const { forward } = await import('../src/lib/forward');
    await expect(forward(['version'])).rejects.toThrow('__exit__');

    const [, args] = execaMock.mock.calls[0] as [string, string[]];
    expect(args[0]).toMatch(/@sfdt[/\\]cli[/\\]bin[/\\]sfdt\.js$/);
    expect(exitSpy).toHaveBeenCalledWith(0);

    exitSpy.mockRestore();
  });
});
