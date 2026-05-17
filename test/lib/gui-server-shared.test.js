import { describe, it, expect, vi, beforeEach } from 'vitest';
import { stripAnsi, tryReadJson, safeReaddir, buildPlaceholderHtml } from '../../src/lib/gui-server/shared.js';

vi.mock('fs-extra', () => ({
  default: {
    readJson: vi.fn(),
    readdir: vi.fn(),
  },
}));

import fs from 'fs-extra';

describe('stripAnsi', () => {
  it('removes SGR escape sequences', () => {
    expect(stripAnsi('\x1B[0;32mgreen\x1B[0m')).toBe('green');
  });

  it('removes OSC sequences', () => {
    expect(stripAnsi('\x1B]0;title\x07rest')).toBe('rest');
  });

  it('removes character set designators', () => {
    expect(stripAnsi('\x1B(Btext')).toBe('text');
  });

  it('passes non-string values through unchanged', () => {
    expect(stripAnsi(null)).toBe(null);
    expect(stripAnsi(42)).toBe(42);
    expect(stripAnsi(undefined)).toBe(undefined);
  });

  it('returns plain string unchanged', () => {
    expect(stripAnsi('hello world')).toBe('hello world');
  });

  it('handles multiple sequences in one string', () => {
    expect(stripAnsi('\x1B[1mBold\x1B[0m and \x1B[31mred\x1B[0m')).toBe('Bold and red');
  });
});

describe('tryReadJson', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns parsed JSON on success', async () => {
    fs.readJson.mockResolvedValue({ key: 'value' });
    expect(await tryReadJson('/some/file.json')).toEqual({ key: 'value' });
    expect(fs.readJson).toHaveBeenCalledWith('/some/file.json');
  });

  it('returns null when file does not exist', async () => {
    fs.readJson.mockRejectedValue(new Error('ENOENT'));
    expect(await tryReadJson('/missing.json')).toBeNull();
  });

  it('returns null on invalid JSON', async () => {
    fs.readJson.mockRejectedValue(new SyntaxError('Unexpected token'));
    expect(await tryReadJson('/bad.json')).toBeNull();
  });
});

describe('safeReaddir', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns directory entries on success', async () => {
    fs.readdir.mockResolvedValue(['a.json', 'b.json']);
    expect(await safeReaddir('/logs')).toEqual(['a.json', 'b.json']);
  });

  it('returns empty array when directory does not exist', async () => {
    fs.readdir.mockRejectedValue(new Error('ENOENT'));
    expect(await safeReaddir('/missing')).toEqual([]);
  });
});

describe('buildPlaceholderHtml', () => {
  it('returns a string containing the version', () => {
    const html = buildPlaceholderHtml('1.2.3');
    expect(html).toContain('1.2.3');
  });

  it('returns valid HTML with doctype', () => {
    const html = buildPlaceholderHtml('0.0.1');
    expect(html).toMatch(/^<!doctype html>/i);
  });

  it('includes the build instruction command', () => {
    const html = buildPlaceholderHtml('1.0.0');
    expect(html).toContain('npm run build:gui');
  });

  it('includes the title', () => {
    const html = buildPlaceholderHtml('1.0.0');
    expect(html).toContain('SFDT Dashboard');
  });
});
