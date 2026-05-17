# Native messaging host installers

The Chrome Native Messaging protocol requires a per-user manifest JSON file
in a platform-specific directory. Install the manifest from
`host/manifests/com.sfdt.host.<platform>.json` to:

| Platform | Manifest path (per-user) |
|---|---|
| macOS    | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.sfdt.host.json` |
| Linux    | `~/.config/google-chrome/NativeMessagingHosts/com.sfdt.host.json` |
| Windows  | `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.sfdt.host` (registry; the value points at the manifest file) |

Before copying, replace the two placeholders:

- `__SFDT_HOST_PATH__` — absolute path to the host launcher. On macOS / Linux
  this is the `sfdt-host` shim from `node_modules/.bin/sfdt-host` (which
  Node creates from the `bin` entry in `host/package.json`). On Windows it
  should point at a `.bat` wrapper that invokes `node host/src/index.js`.
- `__SFDT_EXTENSION_ID__` — the Chrome extension's ID. Find it under
  `chrome://extensions` with Developer Mode enabled, or use the public Web
  Store ID after publishing.

A scripted installer that does this substitution end-to-end lands in Phase 7
alongside the public Web Store release. For Phase 2/3 development the manual
copy + replace flow above is sufficient — the host is exercised directly via
`node host/src/index.js --smoke=<json>` for tests and won't be wired into a
real Chrome extension until Phase 3.
