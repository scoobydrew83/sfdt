import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = path.join(REPO, 'bin/sfdt.js');

/**
 * End-to-end reproduction of the verified `plugins[]` RCE.
 *
 * The unit tests prove the sanitizer's logic; this proves the wiring — that a
 * hostile `.sfdt/config.json` in a cloned repo cannot execute code through the
 * real `bin/sfdt.js` startup path, which loads plugins *before* command parsing
 * and therefore fires on every subcommand including `--version`.
 */
describe('plugins[] RCE is not reachable from a cloned repo (H1, e2e)', () => {
  let dir;
  let marker;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sfdt-trust-'));
    marker = path.join(dir, 'PWNED');

    // A repo a victim might clone: package.json, an .sfdt config naming a
    // plugin, and that plugin vendored into the repo's own node_modules.
    await fs.writeJson(path.join(dir, 'package.json'), { name: 'victim', version: '1.0.0' });
    // loadConfig walks up looking for sfdx-project.json AND .sfdt/ together —
    // without both it throws and loadPlugins swallows it, which would make this
    // suite pass for the wrong reason.
    await fs.writeJson(path.join(dir, 'sfdx-project.json'), {
      packageDirectories: [{ path: 'force-app', default: true }],
      sourceApiVersion: '62.0',
    });
    await fs.ensureDir(path.join(dir, 'force-app/main/default'));
    await fs.ensureDir(path.join(dir, '.sfdt'));
    await fs.writeJson(path.join(dir, '.sfdt/config.json'), {
      defaultOrg: 'dev',
      features: {},
      plugins: ['innocent-looking-dep'],
    });

    const pkgDir = path.join(dir, 'node_modules/innocent-looking-dep');
    await fs.ensureDir(pkgDir);
    await fs.writeJson(path.join(pkgDir, 'package.json'), {
      name: 'innocent-looking-dep',
      version: '1.0.0',
      type: 'module',
      main: 'index.js',
    });
    // Payload at module top level — runs on import, before register() is called.
    await fs.writeFile(
      path.join(pkgDir, 'index.js'),
      `import fs from 'node:fs';\n` +
        `fs.writeFileSync(${JSON.stringify(marker)}, 'executed');\n` +
        `export function register() {}\n`,
    );
  }, 60_000);

  afterAll(async () => {
    if (dir) await fs.remove(dir);
  });

  it('does not execute the plugin on a bare `--version`', async () => {
    await fs.remove(marker);
    const { stdout } = await run('node', [BIN, '--version'], {
      cwd: dir,
      env: { ...process.env, SFDT_ALLOW_UNSAFE_CONFIG: '' },
      timeout: 60_000,
    });
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect(await fs.pathExists(marker)).toBe(false);
  }, 60_000);

  it('still refuses when the config tries to grant itself trust', async () => {
    await fs.remove(marker);
    await fs.writeJson(path.join(dir, '.sfdt/config.json'), {
      defaultOrg: 'dev',
      features: {},
      plugins: ['innocent-looking-dep'],
      // An attacker who controls plugins[] controls this too — it must not work.
      allowUnsafeConfig: true,
      pluginOptions: { autoDiscover: true },
      trusted: true,
    });
    await run('node', [BIN, '--version'], {
      cwd: dir,
      env: { ...process.env, SFDT_ALLOW_UNSAFE_CONFIG: '' },
      timeout: 60_000,
    });
    expect(await fs.pathExists(marker)).toBe(false);

    await fs.writeJson(path.join(dir, '.sfdt/config.json'), {
      defaultOrg: 'dev',
      features: {},
      plugins: ['innocent-looking-dep'],
    });
  }, 60_000);

  it('tells the user what it refused and how to allow it', async () => {
    const { stdout, stderr } = await run('node', [BIN, '--version'], {
      cwd: dir,
      env: { ...process.env, SFDT_ALLOW_UNSAFE_CONFIG: '' },
      timeout: 60_000,
    });
    const out = `${stdout}${stderr}`;
    expect(out).toContain('plugins');
    expect(out).toContain('SFDT_ALLOW_UNSAFE_CONFIG');
  }, 60_000);

  it('does not execute an auto-discovered plugin or a .sfdt/plugins file', async () => {
    // `pluginOptions.autoDiscover` reaches the same import() by two other
    // routes: node_modules/sfdt-plugin-* and .sfdt/plugins/*.js. Both were
    // verified to execute before this was guarded.
    const autoMarker = path.join(dir, 'PWNED_AUTO');
    const localMarker = path.join(dir, 'PWNED_LOCAL');
    await fs.remove(autoMarker);
    await fs.remove(localMarker);

    const autoPkg = path.join(dir, 'node_modules/sfdt-plugin-evil');
    await fs.ensureDir(autoPkg);
    await fs.writeJson(path.join(autoPkg, 'package.json'), {
      name: 'sfdt-plugin-evil', version: '1.0.0', type: 'module', main: 'index.js',
    });
    await fs.writeFile(
      path.join(autoPkg, 'index.js'),
      `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(autoMarker)}, 'x');\nexport function register() {}\n`,
    );
    await fs.ensureDir(path.join(dir, '.sfdt/plugins'));
    await fs.writeFile(
      path.join(dir, '.sfdt/plugins/local-evil.js'),
      `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(localMarker)}, 'x');\nexport function register() {}\n`,
    );
    await fs.writeJson(path.join(dir, '.sfdt/config.json'), {
      defaultOrg: 'dev',
      features: {},
      pluginOptions: { autoDiscover: true },
    });

    await run('node', [BIN, '--version'], {
      cwd: dir, env: { ...process.env, SFDT_ALLOW_UNSAFE_CONFIG: '' }, timeout: 60_000,
    });
    expect(await fs.pathExists(autoMarker)).toBe(false);
    expect(await fs.pathExists(localMarker)).toBe(false);

    // ...and both DO run under the opt-in, proving the repro is real.
    await run('node', [BIN, '--version'], {
      cwd: dir, env: { ...process.env, SFDT_ALLOW_UNSAFE_CONFIG: '1' }, timeout: 60_000,
    });
    expect(await fs.pathExists(autoMarker)).toBe(true);
    expect(await fs.pathExists(localMarker)).toBe(true);

    await fs.remove(path.join(dir, '.sfdt/plugins'));
    await fs.remove(autoPkg);
    await fs.writeJson(path.join(dir, '.sfdt/config.json'), {
      defaultOrg: 'dev', features: {}, plugins: ['innocent-looking-dep'],
    });
  }, 90_000);

  it('DOES load the plugin when the operator opts in via the environment', async () => {
    // The escape hatch must actually work, or we have broken every legitimate
    // plugin user rather than secured them.
    await fs.remove(marker);
    await run('node', [BIN, '--version'], {
      cwd: dir,
      env: { ...process.env, SFDT_ALLOW_UNSAFE_CONFIG: '1' },
      timeout: 60_000,
    });
    expect(await fs.pathExists(marker)).toBe(true);
  }, 60_000);
});
