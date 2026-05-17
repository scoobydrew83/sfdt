import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: '.',
  outDir: '.output',
  manifest: {
    name: 'SFDT SF Helper',
    description:
      'Productivity toolkit for Salesforce admins and developers — Flow analysis, Setup shortcuts, and sfdt CLI bridge integration.',
    permissions: ['storage', 'clipboardWrite', 'cookies', 'scripting'],
    host_permissions: [
      'https://*.salesforce.com/*',
      'https://*.salesforce-setup.com/*',
      'https://*.my.salesforce.com/*',
      'https://*.lightning.force.com/*',
      // Required for the kill-switch / deploy / quality bridge calls.
      // Chrome blocks fetches from a https:// content script to http://127.0.0.1
      // unless the host is explicitly permitted at install time.
      'http://localhost/*',
      'http://127.0.0.1/*',
    ],
  },
});
