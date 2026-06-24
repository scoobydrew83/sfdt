import { build, context } from 'esbuild';

/**
 * Bundles the extension entry point into a single CommonJS file VS Code can
 * load. The `vscode` module is provided by the host at runtime and must stay
 * external. Run with `--watch` for incremental rebuilds during development.
 */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  minify: process.argv.includes('--minify'),
};

if (process.argv.includes('--watch')) {
  const ctx = await context(options);
  await ctx.watch();
  console.error('esbuild watching…');
} else {
  await build(options);
  console.error('esbuild build complete');
}
