import { describe, it, expect, vi, afterEach } from 'vitest';

// We use vi.stubGlobal to replace the global fetch without touching real network.

describe('fetchLatestVersion', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the version string on a successful fetch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ version: '1.2.3' }),
      }),
    );

    const { fetchLatestVersion } = await import('../../src/lib/update-checker.js');
    const version = await fetchLatestVersion();
    expect(version).toBe('1.2.3');
  });

  it('throws when the registry responds with a non-ok status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({}),
      }),
    );

    const { fetchLatestVersion } = await import('../../src/lib/update-checker.js');
    await expect(fetchLatestVersion()).rejects.toThrow('npm registry responded with 404');
  });

  it('propagates the error when fetch is aborted', async () => {
    const abortError = new DOMException('The operation was aborted.', 'AbortError');

    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(abortError),
    );

    const { fetchLatestVersion } = await import('../../src/lib/update-checker.js');
    await expect(fetchLatestVersion()).rejects.toThrow(/aborted/i);
  });
});

describe('isUpdateAvailable', () => {
  it('is true when the latest version is strictly newer', async () => {
    const { isUpdateAvailable } = await import('../../src/lib/update-checker.js');
    expect(isUpdateAvailable('0.10.0', '0.9.1')).toBe(true);
    expect(isUpdateAvailable('1.0.0', '0.10.0')).toBe(true);
  });

  it('is false when versions are equal', async () => {
    const { isUpdateAvailable } = await import('../../src/lib/update-checker.js');
    expect(isUpdateAvailable('0.10.0', '0.10.0')).toBe(false);
  });

  it('is false when the installed version is ahead of the latest (no downgrade prompt)', async () => {
    const { isUpdateAvailable } = await import('../../src/lib/update-checker.js');
    expect(isUpdateAvailable('0.9.1', '0.10.0')).toBe(false);
    expect(isUpdateAvailable('0.9.1', '0.10.0-beta.1')).toBe(false);
  });

  it('is false when either version is missing', async () => {
    const { isUpdateAvailable } = await import('../../src/lib/update-checker.js');
    expect(isUpdateAvailable(null, '0.9.1')).toBe(false);
    expect(isUpdateAvailable('0.9.1', null)).toBe(false);
  });

  it('falls back to inequality for non-semver version strings', async () => {
    const { isUpdateAvailable } = await import('../../src/lib/update-checker.js');
    expect(isUpdateAvailable('nightly-2', 'nightly-1')).toBe(true);
    expect(isUpdateAvailable('nightly-1', 'nightly-1')).toBe(false);
  });
});
