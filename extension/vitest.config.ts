import { defineConfig } from 'vitest/config';
import path from 'path';
export default defineConfig({
  test: {
    include: ['test*.test.ts'],
    environment: 'happy-dom',
    environmentOptions: {
      happyDOM: {
        url: 'https://x.lightning.force.com/',
      },
    },
    setupFiles: ['./test/setup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
      '~': path.resolve(__dirname),
    },
  },
});
