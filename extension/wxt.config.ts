import { defineConfig } from 'wxt';
export default defineConfig({
  srcDir: '.',
  outDir: '.output',
  manifest: {
    name: 'SFDT SF Helper',
    description:
      'A comprehensive toolkit for Salesforce Flow Builder — search, analyse, generate, and manage Flows with ease.',
    permissions: ['storage', 'clipboardWrite', 'cookies', 'scripting'],
    host_permissions: [
      'https://*.salesforce.com/*',
      'https://*.salesforce-setup.com/*',
      'https://*.my.salesforce.com/*',
      'https://*.lightning.force.com/*',
      'http://localhost/*',
      'http://127.0.0.1/*',
    ],
  },
});
