import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';
import fs from 'fs-extra';
import { execa } from 'execa';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST_NAME = 'com.sfdt.host';
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
export async function resolveHostLauncherPath() {
  const local = path.resolve(__dirname, '..', 'src', 'index.js');
  if (await fs.pathExists(local)) return local;
  try {
    const result = await execa(process.platform === 'win32' ? 'where' : 'which', ['sfdt-host'], { reject: false });
    if (result.exitCode === 0) return result.stdout.trim().split(/\r?\n/)[0];
  } catch {
  }
  throw new Error(
    'Could not locate sfdt-host launcher. Reinstall sfdt with `npm install -g @sfdt/cli` and try again.',
  );
}
export function manifestDirsForBrowser(platform, browser) {
  const map = BROWSER_DIRS[platform];
  if (!map) return undefined;
  return map[browser];
}
export function buildManifest(templateString, { hostPath, extensionId }) {
  let out = templateString;
  out = out.replace('__SFDT_HOST_PATH__', hostPath);
  out = out.replace('__SFDT_EXTENSION_ID__', extensionId);
  return JSON.parse(out);
}
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
export async function installNativeHost(opts) {
  const extensionId = opts.extensionId;
  if (!extensionId || typeof extensionId !== 'string') {
    return { ok: false, error: 'extensionId is required' };
  }
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
  return { ok: true, hostPath, platform, results };
}
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
