import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

// Mock fs-extra
vi.mock('fs-extra', () => {
  return {
    default: {
      ensureDir: vi.fn(),
      writeFile: vi.fn(),
      pathExists: vi.fn(),
      readFile: vi.fn(),
      readdir: vi.fn(),
      stat: vi.fn(),
      remove: vi.fn(),
    },
  };
});

import fs from 'fs-extra';
import { parkIfNeeded, getParkedResult, cleanupParkedResults } from '../../src/lib/mcp-parking.js';

beforeEach(() => {
  vi.resetAllMocks();
});

describe('MCP Parking', () => {
  const config = {
    _configDir: '/fake/project/.sfdt',
    _projectRoot: '/fake/project',
    mcp: {
      parking: {
        enabled: true,
        thresholdBytes: 100,
        ttlSeconds: 60,
      },
    },
  };

  describe('parkIfNeeded', () => {
    it('returns original payload if parking is disabled', async () => {
      const disabledConfig = {
        ...config,
        mcp: { parking: { enabled: false } },
      };
      const payload = { data: 'some small or large data' };
      const result = await parkIfNeeded(payload, disabledConfig);
      expect(result).toBe(payload);
    });

    it('returns original payload if size is below threshold', async () => {
      const payload = { msg: 'short' }; // JSON is ~16 bytes
      const result = await parkIfNeeded(payload, config);
      expect(result).toBe(payload);
    });

    it('parks payload, writes to file, and returns envelope if above threshold', async () => {
      // Large object that exceeds 100 bytes
      const payload = {
        data: 'a'.repeat(200),
      };
      fs.ensureDir.mockResolvedValue(undefined);
      fs.writeFile.mockResolvedValue(undefined);

      const result = await parkIfNeeded(payload, config);

      expect(fs.ensureDir).toHaveBeenCalledWith('/fake/project/.sfdt/cache/parked');
      expect(fs.writeFile).toHaveBeenCalled();
      expect(result._parked).toBe(true);
      expect(result.ref).toMatch(/^parked:\/\/[a-f0-9-]{36}$/);
      expect(result.byteSize).toBeGreaterThan(100);
      expect(result.preview).toContain('a'.repeat(200));
      expect(result.expiresAt).toBeDefined();
    });

    it('handles string payload above threshold', async () => {
      const payload = 'b'.repeat(200);
      fs.ensureDir.mockResolvedValue(undefined);
      fs.writeFile.mockResolvedValue(undefined);

      const result = await parkIfNeeded(payload, config);

      expect(result._parked).toBe(true);
      expect(result.ref).toMatch(/^parked:\/\/[a-f0-9-]{36}$/);
      expect(result.preview).toBe('b'.repeat(200));
    });

    it('truncates preview if too long', async () => {
      const payload = { data: 'c'.repeat(2000) };
      fs.ensureDir.mockResolvedValue(undefined);
      fs.writeFile.mockResolvedValue(undefined);

      const result = await parkIfNeeded(payload, config);

      expect(result.preview.length).toBeLessThanOrEqual(1030);
      expect(result.preview).toContain('... (truncated preview)');
    });
  });

  describe('getParkedResult', () => {
    it('throws error if ref is invalid format', async () => {
      await expect(getParkedResult('not-parked://uuid', config)).rejects.toThrow(
        'Invalid parked result reference format',
      );
    });

    it('throws error if UUID is invalid', async () => {
      await expect(getParkedResult('parked://invalid-uuid-format', config)).rejects.toThrow(
        'Invalid parked UUID format',
      );
    });

    it('throws error if file does not exist', async () => {
      fs.pathExists.mockResolvedValue(false);
      const ref = `parked://12345678-1234-1234-1234-1234567890ab`;
      await expect(getParkedResult(ref, config)).rejects.toThrow(
        'Parked result not found or expired',
      );
    });

    it('returns parsed json if file exists and contains json', async () => {
      const payload = { hello: 'world' };
      fs.pathExists.mockResolvedValue(true);
      fs.readFile.mockResolvedValue(JSON.stringify(payload));

      const ref = `parked://12345678-1234-1234-1234-1234567890ab`;
      const result = await getParkedResult(ref, config);

      expect(fs.readFile).toHaveBeenCalledWith(
        '/fake/project/.sfdt/cache/parked/12345678-1234-1234-1234-1234567890ab.json',
        'utf8',
      );
      expect(result).toEqual(payload);
    });

    it('returns raw text if json parse fails', async () => {
      fs.pathExists.mockResolvedValue(true);
      fs.readFile.mockResolvedValue('raw text data');

      const ref = `parked://12345678-1234-1234-1234-1234567890ab`;
      const result = await getParkedResult(ref, config);
      expect(result).toBe('raw text data');
    });
  });

  describe('cleanupParkedResults', () => {
    it('returns 0 if cache directory does not exist', async () => {
      fs.pathExists.mockResolvedValue(false);
      const count = await cleanupParkedResults(config);
      expect(count).toBe(0);
    });

    it('removes expired files and ignores non-expired or invalid files', async () => {
      fs.pathExists.mockResolvedValue(true);
      fs.readdir.mockResolvedValue([
        'expired.json',
        'fresh.json',
        'readme.txt',
      ]);

      const now = Date.now();
      fs.stat.mockImplementation(async (filePath) => {
        if (filePath.endsWith('expired.json')) {
          return { mtimeMs: now - 120 * 1000 }; // 120 seconds old (TTL is 60 seconds)
        }
        if (filePath.endsWith('fresh.json')) {
          return { mtimeMs: now - 10 * 1000 }; // 10 seconds old
        }
        return { mtimeMs: now };
      });

      fs.remove.mockResolvedValue(undefined);

      const count = await cleanupParkedResults(config);

      expect(fs.remove).toHaveBeenCalledWith('/fake/project/.sfdt/cache/parked/expired.json');
      expect(fs.remove).not.toHaveBeenCalledWith('/fake/project/.sfdt/cache/parked/fresh.json');
      expect(count).toBe(1);
    });
  });
});
