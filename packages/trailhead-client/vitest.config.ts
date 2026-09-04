import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Every non-live test runs with the real fetch swapped out for a thrower
    // (test/setup-no-network.ts). "Fixture tests" is enforced, not assumed.
    setupFiles: ['./test/setup-no-network.ts'],
  },
});
