import { defineConfig } from 'wxt';

// WXT auto-generates manifest.json from this config plus the entrypoints/
// directory. The host_permissions, content_scripts matches, and runtime
// permissions all mirror the v2.0.2 extension at
// /Users/dkennedy/dev/2.0.2_0 copy/manifest.json.

export default defineConfig({
  srcDir: '.',
  outDir: '.output',
  manifest: {
    name: 'SF Flow Utility Toolkit',
    description:
      'A comprehensive toolkit for Salesforce Flow Builder — search, analyse, generate, and manage Flows with ease.',
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
