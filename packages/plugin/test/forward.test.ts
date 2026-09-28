import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

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

  it('uses the monorepo CLI when running from a checkout and no override is set', async () => {
    // Four levels up from src/lib/forward.ts is the repo root, whose package is
    // @sfdt/cli — the working tree the plugin's commands were generated from.
    delete process.env.SFDT_CLI_ENTRYPOINT;
    execaMock.mockResolvedValue({ exitCode: 0 });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('__exit__');
    }) as never);

    const { forward } = await import('../src/lib/forward');
    await expect(forward(['version'])).rejects.toThrow('__exit__');

    const [, args] = execaMock.mock.calls[0] as [string, string[]];
    expect(args[0]).toBe(path.join(REPO_ROOT, 'bin', 'sfdt.js'));
    expect(args[0]).not.toMatch(/node_modules/);
    exitSpy.mockRestore();
  });

  it('falls back to require.resolve(@sfdt/cli) outside the monorepo (installed plugin)', async () => {
    delete process.env.SFDT_CLI_ENTRYPOINT;
    const { entrypoint, monorepoEntrypoint } = await import('../src/lib/forward');
    const notTheCli = pathToFileURL(path.join(REPO_ROOT, 'packages', 'plugin') + path.sep);
    expect(monorepoEntrypoint(notTheCli)).toBeNull();
    expect(monorepoEntrypoint(new URL('file:///nonexistent-sfdt-root/'))).toBeNull();
    expect(entrypoint(notTheCli)).toMatch(/@sfdt[/\\]cli[/\\]bin[/\\]sfdt\.js$/);
  });

  it('SFDT_CLI_ENTRYPOINT wins over the monorepo CLI', async () => {
    const { entrypoint } = await import('../src/lib/forward');
    expect(entrypoint()).toBe(FAKE_BIN);
  });
});
