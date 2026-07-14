/**
 * Guards for the curated API-version registry that grounds the upgrade
 * advisor. The freshness test is deliberately time-dependent: when Salesforce
 * ships a new GA release, it fails until someone curates the new version's
 * entry — the failing test IS the maintenance reminder (see RELEASING.md).
 */

import { describe, it, expect } from 'vitest';
import { expectedGaApiVersion } from '@sfdt/flow-core';
import { loadRegistry } from '../../src/lib/api-version-advisor.js';

const registry = await loadRegistry();

describe('api-version-registry', () => {
  it('is at least as new as the current GA API version (update it each Salesforce release)', () => {
    const ga = expectedGaApiVersion(new Date());
    expect(
      registry.maxVersion,
      `Registry maxVersion (${registry.maxVersion}) is behind the current GA API version (${ga}). ` +
        'Curate the new release in src/lib/data/api-version-registry.json — facts only from the official release notes.',
    ).toBeGreaterThanOrEqual(ga);
  });

  it('covers every version from 45 to maxVersion with no gaps', () => {
    for (let v = 45; v <= registry.maxVersion; v++) {
      expect(registry.versions[String(v)], `missing registry entry for v${v}`).toBeTruthy();
    }
  });

  it('every entry has the full shape (release, per-family changes/breaking, featuresUnlocked, sources)', () => {
    for (const [v, entry] of Object.entries(registry.versions)) {
      expect(entry.release, `v${v}.release`).toMatch(/^(Spring|Summer|Winter) '\d\d$/);
      for (const family of ['apex', 'flow', 'lwc']) {
        expect(Array.isArray(entry[family]?.changes), `v${v}.${family}.changes`).toBe(true);
        expect(Array.isArray(entry[family]?.breaking), `v${v}.${family}.breaking`).toBe(true);
      }
      expect(Array.isArray(entry.featuresUnlocked), `v${v}.featuresUnlocked`).toBe(true);
      expect(entry.sources?.length, `v${v}.sources must cite at least one source`).toBeGreaterThan(0);
    }
  });

  it('release names follow the 3-per-year cadence (v45 = Spring \'19)', () => {
    // Deterministic mapping: Spring/Summer/Winter cycle, year advances after Summer.
    const SEASONS = ['Spring', 'Summer', 'Winter'];
    for (const [v, entry] of Object.entries(registry.versions)) {
      const n = Number(v) - 45; // v45 = Spring '19
      const season = SEASONS[n % 3];
      const year = 19 + Math.floor((n + 1) / 3);
      expect(entry.release, `v${v}`).toBe(`${season} '${year}`);
    }
  });
});
