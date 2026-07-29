import { describe, it, expect } from 'vitest';
import { GUI_ROUTES, initialPageFromPath } from './routes.js';

describe('initialPageFromPath', () => {
  it('deep-links to a known page from the path', () => {
    expect(initialPageFromPath('/manifest-builder')).toBe('manifest-builder');
    expect(initialPageFromPath('/audit')).toBe('audit');
  });
  it('boots on the dashboard for the root path', () => {
    expect(initialPageFromPath('/')).toBe('dashboard');
    expect(initialPageFromPath('')).toBe('dashboard');
  });
  it('falls back to the dashboard for unknown paths', () => {
    expect(initialPageFromPath('/nope')).toBe('dashboard');
    expect(initialPageFromPath('/index.html')).toBe('dashboard');
  });
  it('ignores anything past the first segment', () => {
    expect(initialPageFromPath('/scan/extra/deep')).toBe('scan');
  });
  it('tolerates missing input and repeated slashes', () => {
    expect(initialPageFromPath(undefined)).toBe('dashboard');
    expect(initialPageFromPath('//monitor')).toBe('monitor');
  });
  it('round-trips every registered route id', () => {
    for (const { id } of GUI_ROUTES) {
      expect(initialPageFromPath(`/${id}`)).toBe(id);
    }
  });
});
