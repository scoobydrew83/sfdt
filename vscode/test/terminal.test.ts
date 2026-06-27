import { describe, it, expect } from 'vitest';
import { shellQuote, buildTerminalCommand } from '../src/lib/terminal.js';

describe('shellQuote', () => {
  it('leaves safe tokens unquoted', () => {
    expect(shellQuote('audit')).toBe('audit');
    expect(shellQuote('--org')).toBe('--org');
    expect(shellQuote('DevHub')).toBe('DevHub');
    expect(shellQuote('a/b-c.d:e=f')).toBe('a/b-c.d:e=f');
  });
  it('quotes tokens with spaces or specials', () => {
    expect(shellQuote('My Org')).toBe(`'My Org'`);
    expect(shellQuote('a;b')).toBe(`'a;b'`);
  });
  it('escapes embedded single quotes', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
  it('quotes the empty string', () => {
    expect(shellQuote('')).toBe(`''`);
  });
});

describe('buildTerminalCommand', () => {
  it('builds a plain command', () => {
    expect(buildTerminalCommand(['audit', 'all'])).toBe('sfdt audit all');
  });
  it('appends --org when given', () => {
    expect(buildTerminalCommand(['audit', 'all'], { org: 'dev' })).toBe('sfdt audit all --org dev');
  });
  it('quotes an org alias with spaces', () => {
    expect(buildTerminalCommand(['monitor', 'all'], { org: 'My Org' })).toBe(`sfdt monitor all --org 'My Org'`);
  });
  it('honors a custom cli path', () => {
    expect(buildTerminalCommand(['deploy'], { cliPath: '/usr/local/bin/sfdt' })).toBe('/usr/local/bin/sfdt deploy');
  });
  it('does not duplicate an existing --org', () => {
    expect(buildTerminalCommand(['audit', '--org', 'x'], { org: 'dev' })).toBe('sfdt audit --org x');
  });
});
