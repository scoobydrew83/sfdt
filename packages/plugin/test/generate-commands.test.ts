import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Import the CLI from local source (the monorepo root @sfdt/cli is not
// symlinked into node_modules); matches what the codegen script does.
import { createCli } from '../../../src/cli.js';
import {
  planCommands,
  className,
  renderCommand,
  generateCommands,
} from '../scripts/generate-commands.mjs';

const plan = planCommands(createCli());
const byChain = (chain: string[]) => plan.find((p) => p.chain.join(' ') === chain.join(' '));

describe('planCommands', () => {
  it('emits a leaf command (deploy) that forwards its name', () => {
    const deploy = byChain(['deploy']);
    expect(deploy).toBeDefined();
    expect(renderCommand(deploy!)).toContain('forward(["deploy"].concat(this.argv))');
  });

  it('emits nested subcommands (scratch create) under the right path', () => {
    const create = byChain(['scratch', 'create']);
    expect(create).toBeDefined();
    expect(create!.className).toBe('SfdtScratchCreate');
    expect(renderCommand(create!)).toContain('forward(["scratch","create"].concat(this.argv))');
  });

  it('emits a container with a default subcommand (audit) so the bare topic runs', () => {
    // `audit all` is the default subcommand, so `sf sfdt audit` must be runnable.
    expect(byChain(['audit'])).toBeDefined();
    expect(byChain(['audit', 'all'])).toBeDefined();
  });

  it('skips help/version and produces no empty chains', () => {
    expect(plan.every((p) => p.chain.length > 0)).toBe(true);
    expect(plan.some((p) => p.chain.includes('help'))).toBe(false);
  });

  it('produces unique class names and file paths (guards the runnable-detection heuristic)', () => {
    const classes = plan.map((p) => p.className);
    const paths = plan.map((p) => p.chain.join('/'));
    expect(new Set(classes).size).toBe(classes.length);
    expect(new Set(paths).size).toBe(paths.length);
    // Sanity floor: the CLI has 30+ commands; a regression that silently drops
    // most commands (e.g. a changed commander private field) trips this.
    expect(plan.length).toBeGreaterThanOrEqual(30);
  });

  it('camelCases hyphenated command names', () => {
    expect(className(['feature-flags', 'enable'])).toBe('SfdtFeatureFlagsEnable');
  });
});

describe('generateCommands (disk I/O)', () => {
  let outDir: string;

  afterEach(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  // Minimal Commander-shaped fakes — just the fields planCommands/flagHelp read.
  const leaf = (name: string, opts: Array<{ flags: string; description?: string }> = []) => ({
    name: () => name,
    commands: [] as unknown[],
    options: opts,
    description: () => `do ${name}`,
    _actionHandler: () => {},
  });

  it('writes one command file per planned command, nesting subcommands into dirs', () => {
    outDir = mkdtempSync(path.join(os.tmpdir(), 'gencmd-'));
    const create = leaf('create', [{ flags: '-f, --flag', description: 'a flag' }]);
    const program = {
      commands: [
        // A topic with no own action/default + one subcommand → only the leaf emits.
        { name: () => 'demo', commands: [create], options: [], description: () => 'Demo topic' },
        { name: () => 'help', commands: [], options: [], description: () => 'help' }, // skipped
      ],
    };

    const plan = generateCommands(outDir, program);

    expect(plan).toHaveLength(1);
    expect(plan[0].chain).toEqual(['demo', 'create']);

    const file = path.join(outDir, 'demo', 'create.ts');
    expect(existsSync(file)).toBe(true);
    const src = readFileSync(file, 'utf8');
    expect(src).toContain('export default class SfdtDemoCreate extends Command');
    expect(src).toContain('forward(["demo","create"].concat(this.argv))');
    // flagHelp rendered the subcommand's flags into the description.
    expect(src).toContain('a flag');
  });

  it('clears the output dir on each run (rmSync before regenerate)', () => {
    outDir = mkdtempSync(path.join(os.tmpdir(), 'gencmd-'));
    const program = { commands: [leaf('alpha')] };
    generateCommands(outDir, program);
    expect(existsSync(path.join(outDir, 'alpha.ts'))).toBe(true);

    // Second run with a different command must not leave the stale file behind.
    generateCommands(outDir, { commands: [leaf('beta')] });
    expect(existsSync(path.join(outDir, 'alpha.ts'))).toBe(false);
    expect(existsSync(path.join(outDir, 'beta.ts'))).toBe(true);
  });
});
