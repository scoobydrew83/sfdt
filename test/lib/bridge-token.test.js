import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

import {
  getBridgeTokenPath,
  getOrCreateBridgeToken,
  clearBridgeTokenCache,
  rotateBridgeToken,
  constantTimeEqual,
} from '../../src/lib/bridge/token.js';

describe('bridge/token', () => {
  let tmpHome;
  let homedirSpy;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'sfdt-token-test-'));
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    clearBridgeTokenCache();
  });

  afterEach(async () => {
    homedirSpy.mockRestore();
    clearBridgeTokenCache();
    await fs.remove(tmpHome).catch(() => {});
  });

  describe('getBridgeTokenPath', () => {
    it('returns ~/.sfdt/bridge-token relative to the current home directory', () => {
      const result = getBridgeTokenPath();
      expect(result).toBe(path.join(tmpHome, '.sfdt', 'bridge-token'));
    });
  });

  describe('getOrCreateBridgeToken', () => {
    it('creates a new token on first call and persists it to ~/.sfdt/bridge-token', async () => {
      const token = await getOrCreateBridgeToken();
      expect(typeof token).toBe('string');
      // 32 bytes base64url ~= 43 chars (no padding)
      expect(token.length).toBeGreaterThanOrEqual(40);

      const stored = (await fs.readFile(getBridgeTokenPath(), 'utf8')).trim();
      expect(stored).toBe(token);
    });

    it('returns the cached token on subsequent calls (does not re-read disk)', async () => {
      const first = await getOrCreateBridgeToken();
      // Tamper with the file — cache should win
      await fs.writeFile(getBridgeTokenPath(), 'tampered\n');
      const second = await getOrCreateBridgeToken();
      expect(second).toBe(first);
    });

    it('reads an existing token from disk if one already exists', async () => {
      const dir = path.join(tmpHome, '.sfdt');
      await fs.ensureDir(dir);
      await fs.writeFile(path.join(dir, 'bridge-token'), 'preexisting-strong-token-1234567890\n');
      const token = await getOrCreateBridgeToken();
      expect(token).toBe('preexisting-strong-token-1234567890');
    });

    it('rotates the token if the existing file is too short', async () => {
      const dir = path.join(tmpHome, '.sfdt');
      await fs.ensureDir(dir);
      await fs.writeFile(path.join(dir, 'bridge-token'), 'short\n');
      const token = await getOrCreateBridgeToken();
      expect(token).not.toBe('short');
      expect(token.length).toBeGreaterThanOrEqual(40);
    });

    it('writes the token file with 0600 permissions on POSIX', async () => {
      if (process.platform === 'win32') return; // chmod is a no-op on Windows
      await getOrCreateBridgeToken();
      const stat = await fs.stat(getBridgeTokenPath());
      // Last 9 bits are the mode; 0o600 = rw- --- ---
      expect(stat.mode & 0o777).toBe(0o600);
    });
  });

  describe('rotateBridgeToken', () => {
    it('replaces the existing token with a fresh value', async () => {
      const first = await getOrCreateBridgeToken();
      const second = await rotateBridgeToken();
      expect(second).not.toBe(first);
      expect(second.length).toBeGreaterThanOrEqual(40);
    });

    it('updates the in-memory cache so subsequent getOrCreate returns the new token', async () => {
      await getOrCreateBridgeToken();
      const rotated = await rotateBridgeToken();
      const after = await getOrCreateBridgeToken();
      expect(after).toBe(rotated);
    });

    it('persists the rotated token to disk', async () => {
      await getOrCreateBridgeToken();
      const rotated = await rotateBridgeToken();
      const onDisk = (await fs.readFile(getBridgeTokenPath(), 'utf8')).trim();
      expect(onDisk).toBe(rotated);
    });
  });

  describe('clearBridgeTokenCache', () => {
    it('forces a re-read from disk on the next getOrCreate call', async () => {
      const first = await getOrCreateBridgeToken();
      clearBridgeTokenCache();
      // Overwrite disk; clearing the cache means we should pick this up
      await fs.writeFile(getBridgeTokenPath(), 'reloaded-token-1234567890abcdef\n');
      const second = await getOrCreateBridgeToken();
      expect(second).toBe('reloaded-token-1234567890abcdef');
      expect(second).not.toBe(first);
    });
  });

  describe('constantTimeEqual', () => {
    it('returns true for two identical strings of equal length', () => {
      const token = crypto.randomBytes(32).toString('base64url');
      expect(constantTimeEqual(token, token)).toBe(true);
    });

    it('returns false for two different strings of equal length', () => {
      const a = 'a'.repeat(32);
      const b = 'b'.repeat(32);
      expect(constantTimeEqual(a, b)).toBe(false);
    });

    it('returns false when lengths differ', () => {
      expect(constantTimeEqual('short', 'a-much-longer-string')).toBe(false);
    });

    it('returns false when either argument is not a string', () => {
      expect(constantTimeEqual(null, 'abc')).toBe(false);
      expect(constantTimeEqual('abc', null)).toBe(false);
      expect(constantTimeEqual(123, 'abc')).toBe(false);
      expect(constantTimeEqual('abc', undefined)).toBe(false);
    });

    it('returns false for two empty strings of equal length — wait, both empty should be equal', () => {
      // Edge case: empty strings are equal by definition
      expect(constantTimeEqual('', '')).toBe(true);
    });
  });
});
