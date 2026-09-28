import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';

const require = createRequire(import.meta.url);

/**
 * The monorepo's own CLI, when the plugin is running from a checkout.
 *
 * From `dist/lib/forward.js` (or `src/lib/forward.ts` under test) four levels
 * up is the repository root. That is only the CLI when its package.json says
 * `@sfdt/cli` — in an installed plugin the same path is sf's plugin directory,
 * so this returns null and the installed dependency is used.
 *
 * Without this, a checkout forwarded to the registry `@sfdt/cli` npm nests
 * under packages/plugin (the root package can't be a workspace dependency),
 * while the plugin's commands are generated from the working tree — so every
 * command newer than that published version failed as unknown.
 */
export function monorepoEntrypoint(root: URL = new URL('../../../../', import.meta.url)): string | null {
  try {
    const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as { name?: string };
    if (pkg.name !== '@sfdt/cli') return null;
    const bin = fileURLToPath(new URL('bin/sfdt.js', root));
    return existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the `sfdt` CLI to forward to, in order:
 *
 *  1. `SFDT_CLI_ENTRYPOINT` — explicit override (tests, a CLI checkout elsewhere).
 *  2. The monorepo CLI, when running from this repository (see above).
 *  3. The `@sfdt/cli` runtime dependency laid down beside an installed plugin
 *     (`sf plugins install @sfdt/plugin`). `@sfdt/cli` has no `exports` map, so
 *     the deep import is permitted.
 *
 * @param root - where to probe for the monorepo; injectable for tests.
 */
export function entrypoint(root?: URL): string {
  return (
    process.env.SFDT_CLI_ENTRYPOINT ||
    monorepoEntrypoint(root) ||
    require.resolve('@sfdt/cli/bin/sfdt.js')
  );
}

/**
 * Forward a command to the bundled `sfdt` CLI, streaming its stdio straight
 * through so output (including `--json` envelopes) reaches the user verbatim,
 * then exit with the CLI's own exit code. This mirrors the invocation pattern
 * used by `src/lib/mcp-server.js` in the CLI repo.
 *
 * @param args - The sfdt argv (command path + flags), e.g. ['scratch','create'].
 */
export async function forward(args: string[]): Promise<never> {
  const result = await execa('node', [entrypoint(), ...args], {
    stdio: 'inherit',
    env: { ...process.env, SFDT_NON_INTERACTIVE: 'true' },
    reject: false,
  });
  process.exit(result.exitCode ?? 0);
}
