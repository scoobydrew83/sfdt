import { describe, it, expect } from 'vitest';
// Import the CLI from local source (the monorepo root @sfdt/cli is not
// symlinked into node_modules); matches what the codegen script does.
import { createCli } from '../../../src/cli.js';
import { planCommands, className, renderCommand } from '../scripts/generate-commands.mjs';

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
