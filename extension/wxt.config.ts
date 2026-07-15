import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: '.',
  outDir: '.output',
  manifest: {
    name: 'SFDT SF Helper',
    description:
      'Productivity tools for Salesforce admins & developers — Flow, Setup, Object Manager, record pages, SOQL/REST/SOAP & AI.',
    permissions: ['storage', 'clipboardWrite', 'cookies'],
    // The toolbar button opens the thin action popup (entrypoints/popup/).
    action: {
      default_title: 'SFDT SF Helper',
      default_popup: 'popup.html',
    },
    // Declared keyboard shortcuts. They're registered by the browser (not our
    // content script), so they work on a Salesforce tab before the content
    // script has settled, and are remappable at chrome://extensions/shortcuts.
    // `open-palette` opens the ⚡ side menu until the command palette ships
    // (P2-2); `toggle-inspector` is declared now and connects to the LWC
    // inspector when it lands (P6-1).
    commands: {
      'open-workspace': {
        suggested_key: { default: 'Ctrl+Shift+E', mac: 'Command+Shift+E' },
        description: 'Open the SFDT Workspace tab',
      },
      'open-palette': {
        suggested_key: { default: 'Ctrl+Shift+K', mac: 'Command+Shift+K' },
        description: 'Open the SFDT quick menu',
      },
      'toggle-inspector': {
        description: 'Toggle the SFDT inspector',
      },
    },
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
    icons: {
      16: 'icon/16.png',
      32: 'icon/32.png',
      48: 'icon/48.png',
      128: 'icon/128.png',
    },
  },
});
