// Code-generates one oclif command file per Commander command/subcommand by
// introspecting the CLI's `createCli()` program. The Commander definitions are
// the SINGLE SOURCE OF TRUTH — never hand-edit src/commands/sfdt/**.
//
// Each generated command is `strict = false` and forwards its raw argv to the
// bundled `sfdt` binary, so unknown flags, positional args, and variadic args
// ride through untouched and `--json` is passed to the CLI (not intercepted by
// oclif). Run via `npm run gen` (part of `npm run build`).
//
// ponytail: introspects commander internals (_actionHandler / _defaultCommandName).
// If those private fields churn across commander majors, fall back to
// "leaf = no subcommands". Pinned (commander ^13) + self-checked in tests.

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKIP = new Set(['help', 'version']);

/** PascalCase a command chain into a unique class name, e.g. ['feature-flags','enable'] → SfdtFeatureFlagsEnable. */
export function className(chain) {
  const parts = chain.join('-').split('-').filter(Boolean);
  return 'Sfdt' + parts.map((p) => p[0].toUpperCase() + p.slice(1)).join('');
}

/** Render a command's flags into a help block appended to the description. */
function flagHelp(cmd) {
  const opts = cmd.options ?? [];
  if (!opts.length) return '';
  const lines = opts.map((o) => `  ${o.flags}${o.description ? '  ' + o.description : ''}`);
  return '\n\nFlags:\n' + lines.join('\n');
}

/** A command is emitted (runnable) if it has its own action, a default subcommand, or is a leaf. */
function isRunnable(cmd, subs) {
  return (
    typeof cmd._actionHandler === 'function' ||
    Boolean(cmd._defaultCommandName) ||
    subs.length === 0
  );
}

/**
 * Walk the Commander program and return a flat plan of the command files to
 * generate. Pure — no disk I/O — so tests can assert the routing directly.
 *
 * @returns {Array<{ chain: string[], className: string, description: string, importPath: string }>}
 */
export function planCommands(program) {
  const plan = [];
  function walk(cmd, chain) {
    const subs = (cmd.commands ?? []).filter((c) => !SKIP.has(c.name()));
    if (chain.length && isRunnable(cmd, subs)) {
      plan.push({
        chain,
        className: className(chain),
        description: (cmd.description() || `sfdt ${chain.join(' ')}`) + flagHelp(cmd),
        importPath: '../'.repeat(chain.length + 1) + 'lib/forward.js',
      });
    }
    for (const sub of subs) walk(sub, [...chain, sub.name()]);
  }
  for (const cmd of (program.commands ?? []).filter((c) => !SKIP.has(c.name()))) {
    walk(cmd, [cmd.name()]);
  }
  return plan;
}

/** Render a single command descriptor into oclif command-file source. */
export function renderCommand({ chain, className: cls, description, importPath }) {
  return `// AUTO-GENERATED from @sfdt/cli createCli(). Do not edit by hand.
// Regenerate with: npm run gen
import { Command } from '@oclif/core';
import { forward } from '${importPath}';

export default class ${cls} extends Command {
  static description = ${JSON.stringify(description)};
  static strict = false;

  async run(): Promise<void> {
    await forward(${JSON.stringify(chain)}.concat(this.argv));
  }
}
`;
}

/** Generate all command files under `outDir` (clears it first). Returns the plan. */
export function generateCommands(outDir, program) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const plan = planCommands(program);
  for (const entry of plan) {
    const file = path.join(outDir, ...entry.chain) + '.ts';
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, renderCommand(entry));
  }
  return plan;
}

// Run as a script: `npm run gen`. Imports the CLI from local source via a
// relative path (build-time/dev-only — the monorepo root `@sfdt/cli` package is
// not symlinked into node_modules, so a bare `@sfdt/cli` import would not
// resolve here; this script never ships in the installed plugin).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const { createCli } = await import(
    path.resolve(__dirname, '..', '..', '..', 'src', 'cli.js')
  );
  const OUT = path.resolve(__dirname, '..', 'src', 'commands', 'sfdt');
  const plan = generateCommands(OUT, createCli());
  process.stdout.write(
    `generate-commands: wrote ${plan.length} command file(s) to ${path.relative(process.cwd(), OUT)}\n`,
  );
}
