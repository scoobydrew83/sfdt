import { describe, it, expect } from 'vitest';
import { PROTOCOL_VERSION, negotiateProtocolVersion } from '../src/bridge-contract.js';

describe('flow-core/bridge-contract — PROTOCOL_VERSION', () => {
  it('is a major.minor semver string', () => {
    expect(PROTOCOL_VERSION).toMatch(/^\d+\.\d+$/);
  });
});

describe('flow-core/bridge-contract — negotiateProtocolVersion', () => {
  it('returns ok when versions match exactly', () => {
    const result = negotiateProtocolVersion('1.0', '1.0');
    expect(result).toEqual({ ok: true, severity: 'ok' });
  });

  it('returns warn for a minor mismatch with the same major', () => {
    const result = negotiateProtocolVersion('1.2', '1.0');
    expect(result.ok).toBe(true);
    expect(result.severity).toBe('warn');
    if (result.severity === 'warn') {
      expect(result.message).toContain('minor mismatch');
    }
  });

  it('returns error for a different major version (server ahead)', () => {
    const result = negotiateProtocolVersion('2.0', '1.0');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('major version mismatch');
      expect(result.message).toContain('extension');
    }
  });

  it('returns error for a different major version (client ahead)', () => {
    const result = negotiateProtocolVersion('1.0', '2.0');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('sfdt CLI');
    }
  });

  it('treats an undefined server version as legacy 0.0 (major mismatch)', () => {
    const result = negotiateProtocolVersion(undefined, '1.0');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('major version mismatch');
    }
  });

  it('refuses unparseable server versions', () => {
    const result = negotiateProtocolVersion('not-a-version', '1.0');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('Could not parse');
    }
  });

  it('tolerates a 3-segment server version (treats trailing as patch, ignored)', () => {
    const result = negotiateProtocolVersion('1.0.5', '1.0');
    expect(result).toEqual({ ok: true, severity: 'ok' });
  });

  it('defaults clientVersion to PROTOCOL_VERSION when omitted', () => {
    const result = negotiateProtocolVersion(PROTOCOL_VERSION);
    expect(result).toEqual({ ok: true, severity: 'ok' });
  });
});
