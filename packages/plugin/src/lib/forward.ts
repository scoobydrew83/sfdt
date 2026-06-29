import { createRequire } from 'node:module';
import { execa } from 'execa';

const require = createRequire(import.meta.url);

/**
 * Resolve the bundled `@sfdt/cli` binary.
 *
 * In an installed plugin (`sf plugins install @sfdt/plugin`), `@sfdt/cli` is a
 * pinned runtime dependency laid down alongside the plugin, so the deep import
 * resolves inside sf's plugin directory (`@sfdt/cli` has no `exports` map, so
 * deep imports are permitted).
 *
 * `SFDT_CLI_ENTRYPOINT` overrides the resolved path — used by tests and for
 * pointing the plugin at a local CLI checkout during development (the monorepo
 * does not symlink the root `@sfdt/cli` package into `node_modules`).
 */
function entrypoint(): string {
  return process.env.SFDT_CLI_ENTRYPOINT || require.resolve('@sfdt/cli/bin/sfdt.js');
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
