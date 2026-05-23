// Root vitest config — runs every workspace in one invocation via
// `test.projects`. Each workspace's own vitest.config.{js,ts} stays the
// source of truth for environment/setup/aliases; here we only declare
// which configs to load. With this in place `npm test` at the repo root
// runs CLI + extension + flow-core + host + gui together, and
// `npm run test:coverage` produces a unified report.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        extends: false,
        test: {
          name: 'cli',
          include: ['test/**/*.test.js'],
          setupFiles: ['./test/setup-supertest-origin.js'],
        },
      },
      './extension/vitest.config.ts',
      './packages/flow-core/vitest.config.ts',
      './host/vitest.config.js',
      './gui/vitest.config.js',
    ],
  },
});
