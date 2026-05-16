import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('fs-extra', () => ({
  default: {
    readJson: vi.fn(),
    outputJson: vi.fn().mockResolvedValue(undefined),
  },
}));
import fs from 'fs-extra';
import {
  getPrompt,
  getAllPrompts,
  setPromptOverride,
  resetPromptOverride,
  PROMPT_META,
} from '../../src/lib/prompts.js';
let _testId = 0;
function uniqueDir() {
  return `/test-project-${++_testId}/.sfdt`;
}
beforeEach(() => {
  vi.resetAllMocks();
  fs.readJson.mockRejectedValue(new Error('ENOENT'));
});
describe('getPrompt — no configDir', () => {
  it('returns the default prompt text', async () => {
    const result = await getPrompt('review');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain('senior Salesforce developer');
  });
  it('returns empty string for unknown key', async () => {
    const result = await getPrompt('nonexistent-key');
    expect(result).toBe('');
  });
  it('does not call fs.readJson when configDir is absent', async () => {
    await getPrompt('changelog');
    expect(fs.readJson).not.toHaveBeenCalled();
  });
});
describe('getPrompt — with configDir', () => {
  it('returns default when no override exists in prompts.json', async () => {
    const dir = uniqueDir();
    const result = await getPrompt('explain', dir);
    expect(result).toContain('deployment engineer');
  });
  it('calls fs.readJson to load overrides file', async () => {
    const dir = uniqueDir();
    await getPrompt('review', dir);
    expect(fs.readJson).toHaveBeenCalledWith(expect.stringContaining('prompts.json'));
  });
  it('returns user override when one exists in prompts.json', async () => {
    const dir = uniqueDir();
    fs.readJson.mockResolvedValueOnce({ review: 'My custom review prompt' });
    const result = await getPrompt('review', dir);
    expect(result).toBe('My custom review prompt');
  });
  it('falls back to default when override exists for a different key only', async () => {
    const dir = uniqueDir();
    fs.readJson.mockResolvedValueOnce({ explain: 'custom explain' });
    const result = await getPrompt('review', dir);
    expect(result).toContain('senior Salesforce developer');
  });
});
describe('getAllPrompts — no configDir', () => {
  it('returns an array with one entry per default key', async () => {
    const prompts = await getAllPrompts();
    expect(Array.isArray(prompts)).toBe(true);
    expect(prompts.length).toBeGreaterThan(0);
  });
  it('each entry has key, label, description, default, current, and overridden fields', async () => {
    const prompts = await getAllPrompts();
    for (const p of prompts) {
      expect(p).toHaveProperty('key');
      expect(p).toHaveProperty('label');
      expect(p).toHaveProperty('description');
      expect(p).toHaveProperty('default');
      expect(p).toHaveProperty('current');
      expect(p).toHaveProperty('overridden');
    }
  });
  it('overridden is false for all entries when no configDir is given', async () => {
    const prompts = await getAllPrompts();
    expect(prompts.every((p) => p.overridden === false)).toBe(true);
  });
  it('does not call fs.readJson when no configDir is provided', async () => {
    await getAllPrompts();
    expect(fs.readJson).not.toHaveBeenCalled();
  });
  it('returns PROMPT_META label and description on each entry', async () => {
    const prompts = await getAllPrompts();
    const reviewEntry = prompts.find((p) => p.key === 'review');
    expect(reviewEntry.label).toBe(PROMPT_META.review.label);
    expect(reviewEntry.description).toBe(PROMPT_META.review.description);
  });
});
describe('getAllPrompts — with configDir', () => {
  it('marks overridden entries correctly', async () => {
    const dir = uniqueDir();
    fs.readJson.mockResolvedValueOnce({ review: 'my review' });
    const prompts = await getAllPrompts(dir);
    const reviewEntry = prompts.find((p) => p.key === 'review');
    const explainEntry = prompts.find((p) => p.key === 'explain');
    expect(reviewEntry.overridden).toBe(true);
    expect(reviewEntry.current).toBe('my review');
    expect(explainEntry.overridden).toBe(false);
    expect(explainEntry.current).toBe(explainEntry.default);
  });
  it('returns correct default when no overrides file exists', async () => {
    const dir = uniqueDir();
    const prompts = await getAllPrompts(dir);
    expect(prompts.every((p) => p.overridden === false)).toBe(true);
    expect(prompts.every((p) => p.current === p.default)).toBe(true);
  });
});
describe('setPromptOverride', () => {
  it('writes override to prompts.json', async () => {
    const dir = uniqueDir();
    fs.readJson.mockResolvedValueOnce({});
    await setPromptOverride('review', 'new value', dir);
    expect(fs.outputJson).toHaveBeenCalledWith(
      expect.stringContaining('prompts.json'),
      { review: 'new value' },
      { spaces: 2 },
    );
  });
  it('merges with existing overrides in prompts.json', async () => {
    const dir = uniqueDir();
    fs.readJson.mockResolvedValueOnce({ explain: 'existing' });
    await setPromptOverride('review', 'new review', dir);
    expect(fs.outputJson).toHaveBeenCalledWith(
      expect.stringContaining('prompts.json'),
      { explain: 'existing', review: 'new review' },
      { spaces: 2 },
    );
  });
  it('throws when key is unknown', async () => {
    await expect(setPromptOverride('unknown-key', 'value', uniqueDir())).rejects.toThrow(
      /Unknown prompt key/,
    );
    expect(fs.outputJson).not.toHaveBeenCalled();
  });
  it('throws when value is not a string', async () => {
    await expect(setPromptOverride('review', 42, uniqueDir())).rejects.toThrow(
      /value must be a string/,
    );
  });
  it('throws when value is null', async () => {
    await expect(setPromptOverride('review', null, uniqueDir())).rejects.toThrow(
      /value must be a string/,
    );
  });
  it('invalidates cache so next getPrompt call re-reads the file', async () => {
    const dir = uniqueDir();
    fs.readJson.mockResolvedValueOnce({});
    await getPrompt('review', dir);
    await setPromptOverride('review', 'after override', dir);
    fs.readJson.mockResolvedValueOnce({ review: 'after override' });
    const result = await getPrompt('review', dir);
    expect(result).toBe('after override');
  });
});
describe('resetPromptOverride', () => {
  it('removes the key from prompts.json', async () => {
    const dir = uniqueDir();
    fs.readJson.mockResolvedValueOnce({ review: 'custom', explain: 'custom explain' });
    await resetPromptOverride('review', dir);
    expect(fs.outputJson).toHaveBeenCalledWith(
      expect.stringContaining('prompts.json'),
      { explain: 'custom explain' },
      { spaces: 2 },
    );
  });
  it('handles reset when key was not in overrides (no-op on the file)', async () => {
    const dir = uniqueDir();
    fs.readJson.mockResolvedValueOnce({ explain: 'custom explain' });
    await resetPromptOverride('review', dir);
    expect(fs.outputJson).toHaveBeenCalledWith(
      expect.stringContaining('prompts.json'),
      { explain: 'custom explain' },
      { spaces: 2 },
    );
  });
  it('throws when key is unknown', async () => {
    await expect(resetPromptOverride('bad-key', uniqueDir())).rejects.toThrow(
      /Unknown prompt key/,
    );
    expect(fs.outputJson).not.toHaveBeenCalled();
  });
  it('invalidates cache after reset so next load re-reads the file', async () => {
    const dir = uniqueDir();
    fs.readJson.mockResolvedValueOnce({ review: 'custom' });
    await getPrompt('review', dir);
    await resetPromptOverride('review', dir);
    fs.readJson.mockResolvedValueOnce({});
    const result = await getPrompt('review', dir);
    expect(result).toContain('senior Salesforce developer');
  });
});
describe('loadOverrides cache behavior', () => {
  it('returns cached value on second getPrompt call with the same configDir', async () => {
    const dir = uniqueDir();
    fs.readJson.mockResolvedValueOnce({ review: 'cached value' });
    const first = await getPrompt('review', dir);
    const second = await getPrompt('review', dir);
    expect(first).toBe('cached value');
    expect(second).toBe('cached value');
    expect(fs.readJson).toHaveBeenCalledTimes(1);
  });
});
