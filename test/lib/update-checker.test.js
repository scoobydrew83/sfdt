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
