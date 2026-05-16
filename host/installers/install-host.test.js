import { describe, it, expect, vi, beforeEach } from 'vitest';
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
  return {
    default: { ensureDir, writeFile, readFile, readJson, pathExists, chmod, remove },
    ensureDir,
    writeFile,
    readFile,
    readJson,
    pathExists,
    chmod,
    remove,
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
const VALID_EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
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
  it('installs to every browser when --browser=all is passed', async () => {
    const r = await installNativeHost({
      extensionId: VALID_EXTENSION_ID,
      hostPath: HOST_PATH,
      platform: 'darwin',
      browser: 'all',
    });
    expect(r.ok).toBe(true);
    expect(r.results).toHaveLength(5);
    expect(r.results.every((res) => res.ok)).toBe(true);
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
    expect(fsState.has(r.results[0].manifestPath)).toBe(false);
  });
  it('reports removed:false when nothing was installed', async () => {
    const r = await uninstallNativeHost({ platform: 'darwin', browser: 'chrome' });
    expect(r.ok).toBe(true);
    expect(r.results[0].removed).toBe(false);
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
});
