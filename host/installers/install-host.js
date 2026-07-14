/**
 * Programmatic installer for the Chrome Native Messaging host manifest.
 *
 * Chrome looks for native messaging hosts at OS-specific per-user paths:
 *
 *   macOS    ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.sfdt.host.json
 *   Linux    ~/.config/google-chrome/NativeMessagingHosts/com.sfdt.host.json
 *   Windows  HKCU\Software\Google\Chrome\NativeMessagingHosts\com.sfdt.host
 *              (registry value points at a JSON file anywhere on disk)
 *
 * This module reads the platform-specific template from
 * `host/manifests/`, substitutes __SFDT_HOST_PATH__ and __SFDT_EXTENSION_ID__,
 * and writes the result to the right OS location. On Windows it additionally
 * sets the registry entry that points Chrome at the JSON.
 *
 * Browsers besides Chrome (Edge, Brave, Vivaldi, Opera, Chromium) read the
 * same manifest from a sibling directory. Pass `--browser` (or omit for
 * 'chrome', or pass 'all' to install everywhere) — `manifestDirsForBrowser`
 * encapsulates the per-browser paths.
 */

import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';
import fs from 'fs-extra';
import { execa } from 'execa';
import { writeHostConfig } from '../src/host-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST_NAME = 'com.sfdt.host';

// Per-browser per-platform manifest directory. The path Chrome reads is
// platform/browser-specific; the manifest filename is always
// `<host name>.json`. Edge/Brave/Vivaldi reuse Chrome's protocol with their
// own dirs. Firefox uses a different protocol and is not supported here yet.
const BROWSER_DIRS = {
  darwin: {
    chrome: '~/Library/Application Support/Google/Chrome/NativeMessagingHosts',
    edge: '~/Library/Application Support/Microsoft Edge/NativeMessagingHosts',
    brave: '~/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts',
    chromium: '~/Library/Application Support/Chromium/NativeMessagingHosts',
    vivaldi: '~/Library/Application Support/Vivaldi/NativeMessagingHosts',
  },
  linux: {
    chrome: '~/.config/google-chrome/NativeMessagingHosts',
    edge: '~/.config/microsoft-edge/NativeMessagingHosts',
    brave: '~/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts',
    chromium: '~/.config/chromium/NativeMessagingHosts',
    vivaldi: '~/.config/vivaldi/NativeMessagingHosts',
  },
  win32: {
    // On Windows the manifest can live anywhere; the registry entry is what
    // matters. We store it under the user's APPDATA dir, alongside other
    // sfdt-managed files, then point HKCU at it. Per browser, the registry
    // key differs: chrome -> Software\Google\Chrome, edge -> Software\Microsoft\Edge, etc.
    chrome: { manifestDir: '%APPDATA%\\sfdt\\NativeMessagingHosts', registryKey: 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts' },
    edge: { manifestDir: '%APPDATA%\\sfdt\\NativeMessagingHosts', registryKey: 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts' },
    brave: { manifestDir: '%APPDATA%\\sfdt\\NativeMessagingHosts', registryKey: 'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts' },
    chromium: { manifestDir: '%APPDATA%\\sfdt\\NativeMessagingHosts', registryKey: 'HKCU\\Software\\Chromium\\NativeMessagingHosts' },
    vivaldi: { manifestDir: '%APPDATA%\\sfdt\\NativeMessagingHosts', registryKey: 'HKCU\\Software\\Vivaldi\\NativeMessagingHosts' },
  },
};

const SUPPORTED_BROWSERS = ['chrome', 'edge', 'brave', 'chromium', 'vivaldi'];

function expandHome(p) {
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  if (p.includes('%APPDATA%')) return p.replace('%APPDATA%', process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'));
  return p;
}

function platformKey() {
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'win32') return 'win32';
  return 'linux';
}

function templatePathFor(platform) {
  if (platform === 'darwin') return path.join(__dirname, '..', 'manifests', 'com.sfdt.host.darwin.json');
  if (platform === 'win32') return path.join(__dirname, '..', 'manifests', 'com.sfdt.host.windows.json');
  return path.join(__dirname, '..', 'manifests', 'com.sfdt.host.linux.json');
}

/**
 * Resolve the absolute path to the sfdt-host launcher.
 *
 * The host workspace declares `"bin": { "sfdt-host": "./src/index.js" }`, so
 * the path Chrome should invoke is the launcher script itself, with the
 * shebang already set. For non-global installs we resolve relative to this
 * file; for `npm i -g @sfdt/cli` we resolve to the prefix's bin dir.
 */
export async function resolveHostLauncherPath() {
  // 1. Try the locally bundled host (most reliable — works in dev and
  //    when sfdt is installed globally with @sfdt/host as a workspace dep).
  const local = path.resolve(__dirname, '..', 'src', 'index.js');
  if (await fs.pathExists(local)) return local;

  // 2. Fall back to `which sfdt-host`.
  try {
    const result = await execa(process.platform === 'win32' ? 'where' : 'which', ['sfdt-host'], { reject: false });
    if (result.exitCode === 0) return result.stdout.trim().split(/\r?\n/)[0];
  } catch {
    // ignore
  }

  throw new Error(
    'Could not locate sfdt-host launcher. Reinstall sfdt with `npm install -g @sfdt/cli` and try again.',
  );
}

/**
 * Get the manifest directory (or {manifestDir, registryKey} on Windows) for
 * a given platform + browser pair. Returns undefined if the browser is not
 * supported on the platform.
 */
export function manifestDirsForBrowser(platform, browser) {
  const map = BROWSER_DIRS[platform];
  if (!map) return undefined;
  return map[browser];
}

/**
 * Generate the manifest content (JSON object, not string) given the launcher
 * path and the extension ID. Used by the install function and by tests.
 */
export function buildManifest(templateString, { hostPath, extensionId }) {
  // hostPath needs JSON-escaping. On Windows it contains backslashes
  // (C:\Users\…) which are not valid JSON escape sequences and would crash
  // JSON.parse. JSON.stringify produces a complete JSON string literal —
  // surrounding quotes plus all required escapes — so we substitute the
  // quoted placeholder. extensionId is validated against /^[a-p]{32}$/
  // before we get here so a bare substring replace is safe.
  const out = templateString
    .replace('"__SFDT_HOST_PATH__"', JSON.stringify(hostPath))
    .replace('__SFDT_EXTENSION_ID__', extensionId);
  return JSON.parse(out);
}

/**
 * Install the manifest for one (platform, browser). Returns a structured
 * result object — never throws for non-fatal issues (e.g. browser dir
 * doesn't exist yet); callers can decide whether that counts as failure.
 */
async function installOne({ platform, browser, hostPath, extensionId, templateString }) {
  const dirs = manifestDirsForBrowser(platform, browser);
  if (!dirs) {
    return { browser, ok: false, error: `${browser} not supported on ${platform}` };
  }

  const manifest = buildManifest(templateString, { hostPath, extensionId });
  const manifestJson = JSON.stringify(manifest, null, 2) + '\n';

  if (platform === 'win32') {
    const manifestDir = expandHome(dirs.manifestDir);
    const manifestPath = path.join(manifestDir, `${HOST_NAME}.json`);
    await fs.ensureDir(manifestDir);
    await fs.writeFile(manifestPath, manifestJson, 'utf-8');
    // Set the HKCU registry entry that points Chrome (or whichever browser)
    // at our manifest file. `reg add` is shipped with every supported
    // Windows version and is the documented way to do this.
    const keyPath = `${dirs.registryKey}\\${HOST_NAME}`;
    await execa('reg', ['add', keyPath, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f']);
    return { browser, ok: true, manifestPath, registryKey: keyPath };
  }

  const manifestDir = expandHome(dirs);
  const manifestPath = path.join(manifestDir, `${HOST_NAME}.json`);
  await fs.ensureDir(manifestDir);
  await fs.writeFile(manifestPath, manifestJson, 'utf-8');
  if (platform !== 'win32') await fs.chmod(manifestPath, 0o644);
  return { browser, ok: true, manifestPath };
}

/**
 * Public entry point. Installs the manifest into one or all supported
 * browsers on the current platform.
 *
 * @param {object} opts
 * @param {string} opts.extensionId — Chrome extension ID (32-char id from
 *   chrome://extensions, or the public Web Store id once published).
 * @param {string} [opts.hostPath]  — Absolute path to the sfdt-host
 *   launcher. Defaults to resolveHostLauncherPath().
 * @param {string} [opts.browser='chrome'] — 'chrome' | 'edge' | 'brave' |
 *   'chromium' | 'vivaldi' | 'all'.
 * @param {string} [opts.platform=process.platform] — Override for tests.
 * @param {string} [opts.projectRoot] — Salesforce project root to record in the
 *   host config file, so the host's read-only kinds can find `logs/` and
 *   `.sfdt/config.json`. Optional; the manifest still installs without it.
 * @returns {Promise<{ok:true, hostPath:string, results:Array, projectRoot?:string}|{ok:false, error:string}>}
 */
export async function installNativeHost(opts) {
  const extensionId = opts.extensionId;
  if (!extensionId || typeof extensionId !== 'string') {
    return { ok: false, error: 'extensionId is required' };
  }
  // Chrome extension IDs are exactly 32 lowercase letters a–p (base-16 with
  // a-p alphabet). Reject anything else early — a manifest with a malformed
  // origin is silently ignored by Chrome, which is the worst possible
  // failure mode.
  if (!/^[a-p]{32}$/.test(extensionId)) {
    return {
      ok: false,
      error: `Invalid extension ID "${extensionId}". Expected 32 lowercase letters a–p (find it at chrome://extensions with Developer Mode on).`,
    };
  }

  const platform = opts.platform ?? platformKey();
  const browser = opts.browser ?? 'chrome';
  const browsers = browser === 'all' ? SUPPORTED_BROWSERS : [browser];

  const templatePath = templatePathFor(platform);
  const templateString = await fs.readFile(templatePath, 'utf-8');

  const hostPath = opts.hostPath ?? (await resolveHostLauncherPath());

  const results = [];
  for (const b of browsers) {
    try {
      results.push(await installOne({ platform, browser: b, hostPath, extensionId, templateString }));
    } catch (err) {
      results.push({ browser: b, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const anyOk = results.some((r) => r.ok);
  if (!anyOk) {
    return { ok: false, error: 'No browser manifest could be installed', results };
  }

  // Record the project context so the host's read-only kinds can find logs/
  // and .sfdt/config.json. The resolved logDir is persisted (not re-derived at
  // runtime) so a custom config.logDir survives the host being launched by the
  // browser, outside any project. Non-fatal: the manifest install already
  // succeeded.
  let hostConfigFile = null;
  if (opts.projectRoot) {
    // Normalize projectRoot to absolute — it's persisted verbatim and used as
    // the base for relative configDir/logDir, so a relative input would poison
    // both the stored root and the derived paths.
    const root = path.resolve(opts.projectRoot);
    const abs = (p, fallback) => {
      const v = p ?? fallback;
      return path.isAbsolute(v) ? v : path.join(root, v);
    };
    try {
      ({ file: hostConfigFile } = await writeHostConfig({
        schemaVersion: 1,
        projectRoot: root,
        configDir: abs(opts.configDir, '.sfdt'),
        logDir: abs(opts.logDir, 'logs'),
        cliVersion: opts.cliVersion ?? null,
        installedAt: new Date().toISOString(),
      }));
    } catch {
      // Best-effort — the host falls back to SFDT_PROJECT_ROOT / errors clearly.
    }
  }
  return { ok: true, hostPath, platform, results, projectRoot: opts.projectRoot ?? null, hostConfigFile };
}

/**
 * Uninstall the manifest for one or all supported browsers on the current
 * platform. Returns a list of removed entries.
 */
export async function uninstallNativeHost(opts = {}) {
  const platform = opts.platform ?? platformKey();
  const browser = opts.browser ?? 'all';
  const browsers = browser === 'all' ? SUPPORTED_BROWSERS : [browser];

  const results = [];
  for (const b of browsers) {
    const dirs = manifestDirsForBrowser(platform, b);
    if (!dirs) {
      results.push({ browser: b, removed: false, reason: 'not supported' });
      continue;
    }

    if (platform === 'win32') {
      const manifestDir = expandHome(dirs.manifestDir);
      const manifestPath = path.join(manifestDir, `${HOST_NAME}.json`);
      const existed = await fs.pathExists(manifestPath);
      if (existed) await fs.remove(manifestPath);
      const keyPath = `${dirs.registryKey}\\${HOST_NAME}`;
      const reg = await execa('reg', ['delete', keyPath, '/f'], { reject: false });
      results.push({ browser: b, removed: existed || reg.exitCode === 0, manifestPath, registryKey: keyPath });
      continue;
    }

    const manifestDir = expandHome(dirs);
    const manifestPath = path.join(manifestDir, `${HOST_NAME}.json`);
    const existed = await fs.pathExists(manifestPath);
    if (existed) await fs.remove(manifestPath);
    results.push({ browser: b, removed: existed, manifestPath });
  }
  return { ok: true, platform, results };
}

/**
 * Report what is currently installed. Useful for `sfdt extension status`.
 */
export async function nativeHostStatus(opts = {}) {
  const platform = opts.platform ?? platformKey();
  const out = { platform, browsers: [] };
  for (const b of SUPPORTED_BROWSERS) {
    const dirs = manifestDirsForBrowser(platform, b);
    if (!dirs) {
      out.browsers.push({ browser: b, installed: false, supported: false });
      continue;
    }
    const manifestPath =
      platform === 'win32'
        ? path.join(expandHome(dirs.manifestDir), `${HOST_NAME}.json`)
        : path.join(expandHome(dirs), `${HOST_NAME}.json`);
    const exists = await fs.pathExists(manifestPath);
    let manifest;
    if (exists) {
      try {
        manifest = await fs.readJson(manifestPath);
      } catch {
        manifest = null;
      }
    }
    out.browsers.push({
      browser: b,
      installed: exists,
      supported: true,
      manifestPath,
      hostPath: manifest?.path,
      allowedOrigins: manifest?.allowed_origins,
    });
  }
  return out;
}
