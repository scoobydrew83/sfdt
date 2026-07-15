import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkVersionMatch } from '../scripts/check-version-match.js';

// The guard reads two JSON files and compares their `version`. Tests exercise
// the core against temp files so no real build is required.
describe('check-version-match (P0-7 packaging guard)', () => {
  let dir: string;
  let pkgPath: string;
  let manifestPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sfdt-vmatch-'));
    pkgPath = join(dir, 'package.json');
    manifestPath = join(dir, 'manifest.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('passes and returns the version when both match', () => {
    writeFileSync(pkgPath, JSON.stringify({ version: '0.7.0' }));
    writeFileSync(manifestPath, JSON.stringify({ version: '0.7.0' }));
    expect(checkVersionMatch({ pkgPath, manifestPath })).toEqual({ version: '0.7.0' });
  });

  it('throws naming both versions and the manifest file on mismatch', () => {
    writeFileSync(pkgPath, JSON.stringify({ version: '0.6.0' }));
    writeFileSync(manifestPath, JSON.stringify({ version: '0.5.0' }));
    expect(() => checkVersionMatch({ pkgPath, manifestPath })).toThrow(
      /0\.6\.0.*0\.5\.0|0\.5\.0.*0\.6\.0/,
    );
    // The manifest path is named so the failure is actionable.
    expect(() => checkVersionMatch({ pkgPath, manifestPath })).toThrow(manifestPath);
  });

  it('throws a clear error when the built manifest is missing', () => {
    writeFileSync(pkgPath, JSON.stringify({ version: '0.7.0' }));
    // manifestPath intentionally not written
    expect(() => checkVersionMatch({ pkgPath, manifestPath })).toThrow(/built manifest not found/);
  });

  it('throws a clear error when package.json is missing', () => {
    writeFileSync(manifestPath, JSON.stringify({ version: '0.7.0' }));
    expect(() => checkVersionMatch({ pkgPath, manifestPath })).toThrow(/package\.json not found/);
  });

  it('throws when the manifest has no version string', () => {
    writeFileSync(pkgPath, JSON.stringify({ version: '0.7.0' }));
    writeFileSync(manifestPath, JSON.stringify({ name: 'no version here' }));
    expect(() => checkVersionMatch({ pkgPath, manifestPath })).toThrow(/no "version" string/);
  });

  it('throws on invalid JSON', () => {
    writeFileSync(pkgPath, JSON.stringify({ version: '0.7.0' }));
    writeFileSync(manifestPath, '{ not valid json');
    expect(() => checkVersionMatch({ pkgPath, manifestPath })).toThrow(/not valid JSON/);
  });
});
