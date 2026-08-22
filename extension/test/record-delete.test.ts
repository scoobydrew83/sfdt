// P4-1 PR-4: the record-delete capability gate.
//
// The whole point of this feature having its own id is that it must be
// kill-switchable independently of the inspector it lives in, and off until the
// user asks for it. Both are truth-table questions, so they are tested as one.
import { describe, it, expect } from 'vitest';
import {
  RECORD_DELETE_ID,
  isRecordDeleteEnabled,
  createRecordDeleteFeature,
} from '../features/record-delete.js';
import { SettingsSchema, type Settings } from '../lib/settings.js';
import { registerFeatureDefault, _clearFeatureDefaultForTests } from '../lib/feature-defaults.js';

const settingsWith = (features: Record<string, boolean>): Settings =>
  SettingsSchema.parse({ features }) as Settings;

describe('createRecordDeleteFeature', () => {
  it('is metadata only — nothing to activate, no injected UI', () => {
    const f = createRecordDeleteFeature();
    expect(f.manifest.id).toBe('record-delete');
    expect(f.onActivate).toBeUndefined();
  });

  it('declares itself off by default — that flag IS the opt-in mechanism', () => {
    expect(createRecordDeleteFeature().manifest.enabledByDefault).toBe(false);
  });

  it('asks for no new permission', () => {
    expect(createRecordDeleteFeature().manifest.permissions).toBeUndefined();
  });
});

describe('isRecordDeleteEnabled — the truth table', () => {
  // The manifest flag is only authoritative once registered, which is exactly
  // how the runtime works (lib/feature-defaults.ts).
  const withDefault = <T>(fn: () => T): T => {
    registerFeatureDefault(RECORD_DELETE_ID, false);
    try { return fn(); } finally { _clearFeatureDefaultForTests(RECORD_DELETE_ID); }
  };

  it('is OFF for a user with no stored preferences at all', () => {
    // Not "a profile where the toggle was set off by hand" — a genuinely fresh
    // one. That specific starting state is what proves the manifest flag is
    // authoritative rather than incidentally matching.
    withDefault(() => {
      expect(isRecordDeleteEnabled(SettingsSchema.parse({}) as Settings, [])).toBe(false);
    });
  });

  it('is ON once the user opts in, and the kill switch is clear', () => {
    withDefault(() => {
      expect(isRecordDeleteEnabled(settingsWith({ [RECORD_DELETE_ID]: true }), [])).toBe(true);
    });
  });

  it('is OFF when the kill switch names it, even though the user opted in', () => {
    withDefault(() => {
      const on = settingsWith({ [RECORD_DELETE_ID]: true });
      expect(isRecordDeleteEnabled(on, [RECORD_DELETE_ID])).toBe(false);
      expect(isRecordDeleteEnabled(on, new Set([RECORD_DELETE_ID]))).toBe(false);
    });
  });

  it('is OFF when both say no', () => {
    withDefault(() => {
      expect(isRecordDeleteEnabled(settingsWith({ [RECORD_DELETE_ID]: false }), [RECORD_DELETE_ID]))
        .toBe(false);
    });
  });

  it('killing inspect-record does not kill delete, and vice versa', () => {
    // The proof of decision 1: two ids, two switches. A sub-flag inside
    // inspect-record could not express this at all.
    withDefault(() => {
      const on = settingsWith({ [RECORD_DELETE_ID]: true, 'inspect-record': true });
      expect(isRecordDeleteEnabled(on, ['inspect-record'])).toBe(true);
      expect(isRecordDeleteEnabled(on, [RECORD_DELETE_ID])).toBe(false);
    });
  });

  it('accepts the kill list as an array or a Set — content.ts holds a Set', () => {
    withDefault(() => {
      const on = settingsWith({ [RECORD_DELETE_ID]: true });
      expect(isRecordDeleteEnabled(on, new Set<string>())).toBe(true);
      expect(isRecordDeleteEnabled(on, [])).toBe(true);
    });
  });
});
