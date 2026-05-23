/**
 * Regression guard for the host/installers/install-host.js import path used
 * by src/commands/extension.js and src/commands/doctor.js.
 *
 * Both commands import via a workspace-relative path:
 *
 *   import { ... } from '../../host/installers/install-host.js';
 *
 * If the file were ever renamed, moved, or accidentally excluded from the
 * published tarball's `files` array, every `sfdt extension *` and
 * `sfdt doctor --extension` invocation would throw ERR_MODULE_NOT_FOUND on
 * a fresh global install — and no existing unit test catches this because
 * they all `vi.mock('.../install-host.js')`.
 *
 * This test deliberately does NOT mock. It imports the module the same way
 * the production commands do and asserts the public surface is intact.
 */

import { describe, it, expect } from 'vitest';

describe('host/installers/install-host.js resolves from src/commands/', () => {
  it('exports installNativeHost, uninstallNativeHost, and nativeHostStatus', async () => {
    // Use the same relative-from-src/commands path the production code uses
    // (resolved against this test file's location).
    const mod = await import('../../host/installers/install-host.js');
    expect(typeof mod.installNativeHost).toBe('function');
    expect(typeof mod.uninstallNativeHost).toBe('function');
    expect(typeof mod.nativeHostStatus).toBe('function');
  });

  it('is included in @sfdt/cli published files', async () => {
    const { default: rootPkg } = await import('../../package.json', {
      with: { type: 'json' },
    });
    expect(rootPkg.files).toEqual(
      expect.arrayContaining(['host/installers/', 'host/src/', 'host/package.json']),
    );
  });
});
