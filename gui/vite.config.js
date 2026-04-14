import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { resolve } from 'path';

export default defineConfig({
  plugins: [
    react(),
    viteStaticCopy({
      targets: [
        {
          src: resolve(
            __dirname,
            'node_modules/@salesforce-ux/design-system/assets/icons',
          ),
          dest: 'assets',
        },
      ],
    }),
  ],
  optimizeDeps: {
    include: [
      '@salesforce/design-system-react/components/icon-settings',
      '@salesforce/design-system-react/components/utilities/utility-icon/svg',
      '@salesforce/design-system-react/components/icon',
      '@salesforce/design-system-react/components/button',
      '@salesforce/design-system-react/components/button-group',
      '@salesforce/design-system-react/components/badge',
      '@salesforce/design-system-react/components/card',
      '@salesforce/design-system-react/components/data-table',
      '@salesforce/design-system-react/components/data-table/column',
      '@salesforce/design-system-react/components/data-table/cell',
      '@salesforce/design-system-react/components/spinner',
      '@salesforce/design-system-react/components/page-header',
      '@salesforce/design-system-react/components/page-header/record-home',
      '@salesforce/design-system-react/components/alert',
      '@salesforce/design-system-react/components/alert/container',
      '@salesforce/design-system-react/components/utilities/utility-icon',
    ],
    esbuildOptions: {
      target: 'es2020',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
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
