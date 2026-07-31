// Value fidelity of the JSON seed in lib/feature-defaults.ts.
//
// Why this file exists, and why it cannot live in feature-manifests.test.ts:
// every shipped manifest declares `enabledByDefault: true`, so NO assertion
// made over the real manifests can distinguish a correct
// `m.enabledByDefault ?? true` mapping from a constant `true`. A seed that
// registers every shipped id but silently drops the flag passes the entire rest of
// the suite — including the parity test and the "seeds a default for every
// shipped feature" membership check, which asserts ids, not values.
//
// That gap sits exactly on the load-bearing path: the JSON seed is the only
// thing that answers for a registry-free surface (entrypoints/background.ts
// gates the context menu through isFeatureEnabled and builds no registry), so
// it is what a future ship-off feature would depend on. The fix is to mock the
// manifest module with an entry that actually declares false — the one input
// the real corpus cannot supply.
//
// feature-manifests.test.ts owns the complementary half: that the ids and
// values in the JSON match the real factory manifests 1:1.

import { describe, it, expect, vi } from 'vitest';

vi.mock('../lib/feature-manifests.json', () => ({
  default: [
    { id: 'fixture-ships-off', name: 'x', contexts: [], enabledByDefault: false },
    { id: 'fixture-ships-on', name: 'y', contexts: [], enabledByDefault: true },
    { id: 'fixture-omitted', name: 'z', contexts: [] },
  ],
}));

describe('feature-defaults — the JSON seed carries each manifest value, not a constant', () => {
  it('honours enabledByDefault: false from the JSON seed', async () => {
    const { isEnabledByDefault } = await import('../lib/feature-defaults.js');
    // The assertion a constant-`true` seed cannot survive.
    expect(isEnabledByDefault('fixture-ships-off')).toBe(false);
  });

  it('honours enabledByDefault: true, and treats an omitted flag as true', async () => {
    const { isEnabledByDefault } = await import('../lib/feature-defaults.js');
    expect(isEnabledByDefault('fixture-ships-on')).toBe(true);
    expect(isEnabledByDefault('fixture-omitted')).toBe(true);
  });

  it('an id absent from the seed falls back to enabled', async () => {
    const { isEnabledByDefault } = await import('../lib/feature-defaults.js');
    expect(isEnabledByDefault('fixture-not-in-the-seed')).toBe(true);
  });

  // The seed reaching isEnabledByDefault is necessary but not sufficient — this
  // pins that a seeded `false` survives all the way through the real settings
  // resolution for a user with no stored preferences, which is what the
  // registry-free surfaces actually call.
  it('a seeded enabledByDefault:false resolves to disabled through isFeatureEnabled', async () => {
    const { isFeatureEnabled, SettingsSchema } = await import('../lib/settings.js');
    const noStoredPreferences = SettingsSchema.parse({});
    expect(isFeatureEnabled(noStoredPreferences, 'fixture-ships-off')).toBe(false);
    expect(isFeatureEnabled(noStoredPreferences, 'fixture-ships-on')).toBe(true);
    expect(isFeatureEnabled(noStoredPreferences, 'fixture-omitted')).toBe(true);
  });

  // A user's explicit choice must still beat a seeded default — same invariant
  // the registerFeatureDefault() path pins, re-checked on the JSON path.
  it('a stored preference still overrides a seeded default in both directions', async () => {
    const { isFeatureEnabled, SettingsSchema } = await import('../lib/settings.js');
    const optedIn = SettingsSchema.parse({ features: { 'fixture-ships-off': true } });
    expect(isFeatureEnabled(optedIn, 'fixture-ships-off')).toBe(true);
    const optedOut = SettingsSchema.parse({ features: { 'fixture-ships-on': false } });
    expect(isFeatureEnabled(optedOut, 'fixture-ships-on')).toBe(false);
  });
});
