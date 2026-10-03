import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    // The dashboard bundle inlines react, react-dom, d3, react-markdown and
    // their dependencies; MIT/ISC/BSD require their notices to travel with the
    // copy. Vite collects every bundled package's license into this file, which
    // ships inside the npm tarball with the rest of gui/dist.
    license: { fileName: 'THIRD_PARTY_LICENSES.md' },
    rollupOptions: {
      input: resolve(__dirname, 'index.html'),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:7654',
        changeOrigin: true,
      },
    },
  },
});
