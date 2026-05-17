import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['installers/**/*.test.js', 'src/**/*.test.js', 'test/**/*.test.js'],
  },
});
