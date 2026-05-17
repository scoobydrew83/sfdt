import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'happy-dom',
    environmentOptions: {
      happyDOM: {
        // Salesforce origin so history.replaceState() in tests is same-origin.
        url: 'https://x.lightning.force.com/',
      },
    },
    setupFiles: ['./test/setup.ts'],
  },
  resolve: {
    alias: {
      // WXT path aliases — match what the build pipeline uses so the same
      // module imports resolve identically in tests.
      '@': path.resolve(__dirname),
      '~': path.resolve(__dirname),
    },
  },
});
