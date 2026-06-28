import { describe, it, expect, beforeEach } from 'vitest';
import { launchToken } from './api.js';

describe('launchToken', () => {
  beforeEach(() => {
    sessionStorage.clear();
    window.history.replaceState({}, '', '/');
  });

  it('reads the token from the URL, persists it, and scrubs it from the URL', () => {
    window.history.replaceState({}, '', '/?token=abc123&theme=dark');

    expect(launchToken()).toBe('abc123');
    expect(sessionStorage.getItem('sfdt_launch_token')).toBe('abc123');
    // Token gone from the address bar/history, other params preserved.
    expect(window.location.search).not.toContain('token');
    expect(window.location.search).toContain('theme=dark');
  });

  it('falls back to sessionStorage on a reload (no token in the URL)', () => {
    sessionStorage.setItem('sfdt_launch_token', 'persisted');
    expect(launchToken()).toBe('persisted');
    // Nothing to scrub; URL untouched.
    expect(window.location.search).toBe('');
  });

  it('returns null when there is neither a URL token nor a stored one', () => {
    expect(launchToken()).toBeNull();
  });
});
