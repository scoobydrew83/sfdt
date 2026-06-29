import { describe, it, expect } from 'vitest';
import { parseLaunchToken, dashboardPageUrl, themeQueryFromKind } from '../src/lib/dashboard-url.js';

describe('parseLaunchToken', () => {
  it('extracts the token from an sfdt ui line', () => {
    expect(parseLaunchToken('Dashboard running at http://localhost:7654?token=abc123_XY-Z')).toBe('abc123_XY-Z');
  });
  it('tolerates ANSI color codes and surrounding text', () => {
    const line = '[32m  Dashboard running at http://localhost:7654?token=TOK3N[39m\n';
    expect(parseLaunchToken(line)).toBe('TOK3N');
  });
  it('returns undefined when there is no token', () => {
    expect(parseLaunchToken('Press Ctrl+C to stop.')).toBeUndefined();
  });
});

describe('dashboardPageUrl', () => {
  it('builds the root url with a token', () => {
    expect(dashboardPageUrl(7654, undefined, 'TOK')).toBe('http://localhost:7654/?token=TOK');
  });
  it('deep-links to a page with the token', () => {
    expect(dashboardPageUrl(7654, 'audit', 'TOK')).toBe('http://localhost:7654/audit?token=TOK');
  });
  it('normalizes a leading slash on the page', () => {
    expect(dashboardPageUrl(8080, '/monitor', 'T')).toBe('http://localhost:8080/monitor?token=T');
  });
  it('omits the query when no token is known', () => {
    expect(dashboardPageUrl(7654, 'scan')).toBe('http://localhost:7654/scan');
  });
  it('appends the theme alongside the token', () => {
    expect(dashboardPageUrl(7654, 'audit', 'TOK', 'light')).toBe(
      'http://localhost:7654/audit?token=TOK&theme=light',
    );
  });
  it('appends the theme even without a token', () => {
    expect(dashboardPageUrl(7654, undefined, undefined, 'dark')).toBe(
      'http://localhost:7654/?theme=dark',
    );
  });
});

describe('themeQueryFromKind', () => {
  it('maps Light (1) and HighContrastLight (4) to light', () => {
    expect(themeQueryFromKind(1)).toBe('light');
    expect(themeQueryFromKind(4)).toBe('light');
  });
  it('maps Dark (2) and HighContrast (3) to dark', () => {
    expect(themeQueryFromKind(2)).toBe('dark');
    expect(themeQueryFromKind(3)).toBe('dark');
  });
});
