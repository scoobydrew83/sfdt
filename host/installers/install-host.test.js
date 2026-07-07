/**
 * Unit tests for the native messaging host installer. Everything that would
 * touch the real filesystem or the Windows registry is mocked so the tests
 * are safe to run on a developer machine.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory filesystem keyed by path. Mock fs-extra so we can observe what
// the installer writes without actually creating manifests anywhere real.
const fsState = new Map();

vi.mock('fs-extra', () => {
  const ensureDir = vi.fn(async (p) => {
    fsState.set(`__dir:${p}`, true);
  });
  const writeFile = vi.fn(async (p, content) => {
    fsState.set(p, content);
  });
  const readFile = vi.fn(async (p) => {
    if (fsState.has(p)) return fsState.get(p);
    // Fall back to the real fs for the manifest templates that ship with the
    // host workspace — we want to verify they parse cleanly through the
    // template substitution.
    const real = await import('node:fs/promises');
    return real.readFile(p, 'utf-8');
  });
  const readJson = vi.fn(async (p) => {
    const content = fsState.get(p);
    return content ? JSON.parse(content) : null;
  });
  const pathExists = vi.fn(async (p) => fsState.has(p));
  const chmod = vi.fn(async () => {});
  const remove = vi.fn(async (p) => {
    fsState.delete(p);
  });
  const writeJson = vi.fn(async (p, obj) => {
    fsState.set(p, JSON.stringify(obj));
  });
  return {
    default: { ensureDir, writeFile, readFile, readJson, pathExists, chmod, remove, writeJson },
    ensureDir,
    writeFile,
    readFile,
    readJson,
    pathExists,
    chmod,
    remove,
    writeJson,
  };
});

const execaCalls = [];
let execaImpl = async () => ({ exitCode: 0, stdout: '/usr/local/bin/sfdt-host', stderr: '' });

vi.mock('execa', () => ({
  execa: vi.fn(async (cmd, args, opts) => {
    execaCalls.push({ cmd, args, opts });
    return execaImpl(cmd, args, opts);
  }),
}));

import {
  buildManifest,
  installNativeHost,
  uninstallNativeHost,
  nativeHostStatus,
  manifestDirsForBrowser,
} from './install-host.js';

const VALID_EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop'; // 32 lowercase a–p
const HOST_PATH = '/Users/dev/sfdt/host/src/index.js';

beforeEach(() => {
  fsState.clear();
  execaCalls.length = 0;
});

describe('buildManifest', () => {
  it('substitutes both placeholders into the template', () => {
    const tpl = '{"name":"com.sfdt.host","path":"__SFDT_HOST_PATH__","allowed_origins":["chrome-extension://__SFDT_EXTENSION_ID__/"]}';
    const m = buildManifest(tpl, { hostPath: '/x', extensionId: VALID_EXTENSION_ID });
    expect(m.path).toBe('/x');
    expect(m.allowed_origins).toEqual([`chrome-extension://${VALID_EXTENSION_ID}/`]);
  });

  it('JSON-escapes backslashes in Windows paths so JSON.parse succeeds', () => {
    const tpl = '{"name":"com.sfdt.host","path":"__SFDT_HOST_PATH__","allowed_origins":["chrome-extension://__SFDT_EXTENSION_ID__/"]}';
    const winPath = 'C:\\Users\\me\\AppData\\Roaming\\npm\\sfdt-host.cmd';
    const m = buildManifest(tpl, { hostPath: winPath, extensionId: VALID_EXTENSION_ID });
    expect(m.path).toBe(winPath);
  });

  it('handles paths containing embedded double quotes safely', () => {
    const tpl = '{"name":"com.sfdt.host","path":"__SFDT_HOST_PATH__","allowed_origins":["chrome-extension://__SFDT_EXTENSION_ID__/"]}';
    const quirky = '/tmp/has "quotes" inside';
    const m = buildManifest(tpl, { hostPath: quirky, extensionId: VALID_EXTENSION_ID });
    expect(m.path).toBe(quirky);
  });
});

describe('manifestDirsForBrowser', () => {
  it('returns a manifest directory for chrome on darwin', () => {
    expect(manifestDirsForBrowser('darwin', 'chrome')).toMatch(/NativeMessagingHosts$/);
  });
  it('returns a {manifestDir, registryKey} object on win32', () => {
    const d = manifestDirsForBrowser('win32', 'chrome');
    expect(d).toHaveProperty('manifestDir');
    expect(d).toHaveProperty('registryKey');
    expect(d.registryKey).toMatch(/Google\\Chrome/);
  });
  it('returns undefined for an unknown browser', () => {
    expect(manifestDirsForBrowser('darwin', 'safari')).toBeUndefined();
  });
});

describe('installNativeHost — validation', () => {
  it('rejects a missing extensionId', async () => {
    const r = await installNativeHost({ hostPath: HOST_PATH });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/extensionId is required/);
  });

  it('rejects a malformed extensionId', async () => {
    const r = await installNativeHost({ extensionId: 'not-a-real-id', hostPath: HOST_PATH });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Invalid extension ID/);
  });

  it('rejects an extensionId with capital letters', async () => {
    // Chrome IDs are lowercase a–p only. Catching this early prevents a
    // silent failure where the manifest is "installed" but Chrome never
    // considers it valid.
    const r = await installNativeHost({ extensionId: 'A'.repeat(32), hostPath: HOST_PATH });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Invalid extension ID/);
  });
});

describe('installNativeHost — darwin', () => {
  it('writes the manifest to ~/Library/Application Support/Google/Chrome/...', async () => {
    const r = await installNativeHost({
      extensionId: VALID_EXTENSION_ID,
      hostPath: HOST_PATH,
      platform: 'darwin',
      browser: 'chrome',
    });
    expect(r.ok).toBe(true);
    const installed = r.results[0];
    expect(installed.ok).toBe(true);
    expect(installed.manifestPath).toMatch(/Google\/Chrome\/NativeMessagingHosts\/com\.sfdt\.host\.json$/);

    const written = fsState.get(installed.manifestPath);
    expect(written).toBeTruthy();
    const parsed = JSON.parse(written);
    expect(parsed.name).toBe('com.sfdt.host');
    expect(parsed.path).toBe(HOST_PATH);
    expect(parsed.allowed_origins).toEqual([`chrome-extension://${VALID_EXTENSION_ID}/`]);
  });

  it('records the project root in the host config when projectRoot is passed', async () => {
    const r = await installNativeHost({
      extensionId: VALID_EXTENSION_ID,
      hostPath: HOST_PATH,
      platform: 'darwin',
      browser: 'chrome',
      projectRoot: '/work/my-sf-project',
    });
    expect(r.ok).toBe(true);
    expect(r.projectRoot).toBe('/work/my-sf-project');
    expect(r.hostConfigFile).toMatch(/sfdt-host\.json$/);
    const written = fsState.get(r.hostConfigFile);
    expect(JSON.parse(written)).toMatchObject({ projectRoot: '/work/my-sf-project' });
  });

  it('installs without a host config when no projectRoot is given', async () => {
    const r = await installNativeHost({
      extensionId: VALID_EXTENSION_ID,
      hostPath: HOST_PATH,
      platform: 'darwin',
      browser: 'chrome',
    });
    expect(r.ok).toBe(true);
    expect(r.projectRoot).toBeNull();
    expect(r.hostConfigFile).toBeNull();
  });

  it('installs to every browser when --browser=all is passed', async () => {
    const r = await installNativeHost({
      extensionId: VALID_EXTENSION_ID,
      hostPath: HOST_PATH,
      platform: 'darwin',
      browser: 'all',
    });
    expect(r.ok).toBe(true);
    // chrome, edge, brave, chromium, vivaldi
    expect(r.results).toHaveLength(5);
    expect(r.results.every((res) => res.ok)).toBe(true);
    // Each browser writes to its own directory.
    const paths = r.results.map((res) => res.manifestPath);
    expect(new Set(paths).size).toBe(5);
  });
});

describe('installNativeHost — linux', () => {
  it('writes the manifest to ~/.config/google-chrome/NativeMessagingHosts/', async () => {
    const r = await installNativeHost({
      extensionId: VALID_EXTENSION_ID,
      hostPath: HOST_PATH,
      platform: 'linux',
      browser: 'chrome',
    });
    expect(r.ok).toBe(true);
    const installed = r.results[0];
    expect(installed.manifestPath).toMatch(/\.config\/google-chrome\/NativeMessagingHosts\/com\.sfdt\.host\.json$/);
  });
});

describe('installNativeHost — win32', () => {
  it('writes a registry entry via `reg add` pointing to the manifest', async () => {
    const r = await installNativeHost({
      extensionId: VALID_EXTENSION_ID,
      hostPath: HOST_PATH,
      platform: 'win32',
      browser: 'chrome',
    });
    expect(r.ok).toBe(true);
    const installed = r.results[0];
    expect(installed.ok).toBe(true);
    expect(installed.registryKey).toMatch(/HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com\.sfdt\.host$/);

    // The installer should have spawned `reg add <key> /ve /t REG_SZ /d <manifestPath> /f`.
    const regAdd = execaCalls.find((c) => c.cmd === 'reg' && c.args.includes('add'));
    expect(regAdd).toBeTruthy();
    expect(regAdd.args).toContain('/ve');
    expect(regAdd.args).toContain('/t');
    expect(regAdd.args).toContain('REG_SZ');
    expect(regAdd.args).toContain('/f');
    expect(regAdd.args[regAdd.args.length - 2]).toBe(installed.manifestPath);
  });
});

describe('uninstallNativeHost', () => {
  it('removes a previously installed darwin manifest', async () => {
    await installNativeHost({
      extensionId: VALID_EXTENSION_ID,
      hostPath: HOST_PATH,
      platform: 'darwin',
      browser: 'chrome',
    });
    const r = await uninstallNativeHost({ platform: 'darwin', browser: 'chrome' });
    expect(r.ok).toBe(true);
    expect(r.results[0].removed).toBe(true);
    // After uninstall, the file is gone.
    expect(fsState.has(r.results[0].manifestPath)).toBe(false);
  });

  it('reports removed:false when nothing was installed', async () => {
    const r = await uninstallNativeHost({ platform: 'darwin', browser: 'chrome' });
    expect(r.ok).toBe(true);
    expect(r.results[0].removed).toBe(false);
  });

  it('reports "not supported" for browsers on an unknown platform', async () => {
    // BROWSER_DIRS has no entry for e.g. freebsd, so manifestDirsForBrowser
    // returns undefined for every browser and uninstall skips them.
    const r = await uninstallNativeHost({ platform: 'freebsd', browser: 'all' });
    expect(r.ok).toBe(true);
    expect(r.results.every((res) => res.removed === false && res.reason === 'not supported')).toBe(true);
  });

  it('on windows, calls `reg delete` for the host key', async () => {
    await uninstallNativeHost({ platform: 'win32', browser: 'chrome' });
    const regDelete = execaCalls.find((c) => c.cmd === 'reg' && c.args.includes('delete'));
    expect(regDelete).toBeTruthy();
    expect(regDelete.args[1]).toMatch(/HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com\.sfdt\.host$/);
    expect(regDelete.args).toContain('/f');
  });
});

describe('nativeHostStatus', () => {
  it('reports installed for browsers that have a manifest, not for others', async () => {
    await installNativeHost({
      extensionId: VALID_EXTENSION_ID,
      hostPath: HOST_PATH,
      platform: 'darwin',
      browser: 'chrome',
    });
    const status = await nativeHostStatus({ platform: 'darwin' });
    const chrome = status.browsers.find((b) => b.browser === 'chrome');
    const edge = status.browsers.find((b) => b.browser === 'edge');
    expect(chrome.installed).toBe(true);
    expect(chrome.hostPath).toBe(HOST_PATH);
    expect(chrome.allowedOrigins).toEqual([`chrome-extension://${VALID_EXTENSION_ID}/`]);
    expect(edge.installed).toBe(false);
  });

  it('marks every browser unsupported on an unknown platform', async () => {
    const status = await nativeHostStatus({ platform: 'freebsd' });
    expect(status.browsers.every((b) => b.supported === false && b.installed === false)).toBe(true);
  });

  it('treats a corrupt manifest as installed-but-unreadable (null host metadata)', async () => {
    // Install to get the real manifest path, then overwrite it with invalid
    // JSON so readJson throws and the catch falls back to manifest=null —
    // installed:true but no hostPath/origins.
    const install = await installNativeHost({
      extensionId: VALID_EXTENSION_ID,
      hostPath: HOST_PATH,
      platform: 'darwin',
      browser: 'chrome',
    });
    fsState.set(install.results[0].manifestPath, '{ not valid json');
    const status = await nativeHostStatus({ platform: 'darwin' });
    const chrome = status.browsers.find((b) => b.browser === 'chrome');
    expect(chrome.installed).toBe(true);
    expect(chrome.hostPath).toBeUndefined();
    expect(chrome.allowedOrigins).toBeUndefined();
  });
});
