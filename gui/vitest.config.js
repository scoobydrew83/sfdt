import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    // `jsdom` is ALSO declared in the ROOT package.json devDependencies, and must
    // stay there. vitest hoists to the workspace root, and its jsdom environment
    // loader resolves `jsdom` relative to its own location — so a copy nested in
    // gui/node_modules is invisible to it (ERR_MODULE_NOT_FOUND, every test file
    // failing to start). npm only hoists jsdom while its transitive pins are
    // compatible with the root tree; declaring it at root forces the hoist
    // regardless. Bump both together.
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.js'],
  },
});
