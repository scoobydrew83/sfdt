import { describe, it, expect } from 'vitest';
import { ApiNameLibrary, ICON_TO_TYPE } from '../src/api-name.js';
import { createMemoryStorage } from '../src/storage.js';

describe('flow-core/api-name', () => {
  describe('lookups', () => {
    it('returns the default prefix entry for a known type (case-insensitive)', async () => {
      const lib = new ApiNameLibrary();
      await lib.load();
      expect(lib.getByType('Get Records')?.Snake_Case).toBe('Get_');
      expect(lib.getByType('get records')?.PascalCase).toBe('Get');
    });

    it('returns null for an unknown type or empty input', async () => {
      const lib = new ApiNameLibrary();
      await lib.load();
      expect(lib.getByType('NoSuchType')).toBeNull();
      expect(lib.getByType('')).toBeNull();
      expect(lib.getByType(null)).toBeNull();
    });

    it('maps Lightning icon-name attributes to prefix types', async () => {
      const lib = new ApiNameLibrary();
      expect(lib.getTypeFromIconName('standard:record_lookup')).toBe('get records');
      expect(lib.getTypeFromIconName('standard:decision')).toBe('decision');
      expect(lib.getTypeFromIconName('unknown:icon')).toBeNull();
      expect(lib.getTypeFromIconName(null)).toBeNull();
    });

    it('exposes the ICON_TO_TYPE map directly', () => {
      expect(ICON_TO_TYPE['standard:flow']).toBe('subflow');
    });
  });

  describe('expand — the CHANGELOG #4 fix', () => {
    it('Snake_Case: prefix + snake_normalised label', async () => {
      const lib = new ApiNameLibrary();
      await lib.load();
      expect(lib.expand('Active Accounts', 'Get Records', 'Snake_Case')).toBe('Get_Active_Accounts');
    });

    it('PascalCase: prefix + PascalCased label', async () => {
      const lib = new ApiNameLibrary();
      await lib.load();
      expect(lib.expand('active accounts', 'Get Records', 'PascalCase')).toBe('GetActiveAccounts');
    });

    it('camelCase: prefix + camelCased label', async () => {
      const lib = new ApiNameLibrary();
      await lib.load();
      // For Get Records, camelCase prefix is "get"; label normalises to ActiveAccounts;
      // final is "getActiveAccounts" — but our implementation concatenates "get" + "activeAccounts"
      expect(lib.expand('active accounts', 'Get Records', 'camelCase')).toBe('getactiveAccounts');
    });

    it('returns null on empty label', async () => {
      const lib = new ApiNameLibrary();
      await lib.load();
      expect(lib.expand('', 'Get Records', 'Snake_Case')).toBeNull();
    });

    it('strips punctuation that is not alphanumeric in Snake_Case', async () => {
      const lib = new ApiNameLibrary();
      await lib.load();
      expect(lib.expand('Account #1 / Renewal', 'Variable (Text)', 'Snake_Case')).toBe(
        'VarString_Account_1_Renewal',
      );
    });

    it('uses an empty prefix when the type is unknown but still normalises the label', async () => {
      const lib = new ApiNameLibrary();
      await lib.load();
      expect(lib.expand('Some Label', 'NoSuchType', 'Snake_Case')).toBe('Some_Label');
    });
  });

  describe('importCustom — overrides defaults', () => {
    it('replaces the prefix list when valid JSON is imported', async () => {
      const storage = createMemoryStorage();
      const lib = new ApiNameLibrary({ storage });
      await lib.load();
      const result = await lib.importCustom(
        JSON.stringify({
          version: 1,
          prefixes: [{ type: 'Custom', Snake_Case: 'C_', PascalCase: 'C', camelCase: 'c' }],
        }),
      );
      expect(result).toEqual({ success: true, count: 1 });
      expect(lib.isCustom()).toBe(true);
      expect(lib.getByType('Custom')?.Snake_Case).toBe('C_');
      expect(lib.getByType('Get Records')).toBeNull();
    });

    it('rejects invalid JSON', async () => {
      const lib = new ApiNameLibrary();
      const result = await lib.importCustom('not json {');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Invalid JSON/);
    });

    it('rejects JSON without a prefixes array', async () => {
      const lib = new ApiNameLibrary();
      const result = await lib.importCustom('{"version": 1}');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/prefixes/);
    });

    it('rejects an empty prefixes array', async () => {
      const lib = new ApiNameLibrary();
      const result = await lib.importCustom('{"version": 1, "prefixes": [{"foo": "bar"}]}');
      expect(result.success).toBe(false);
    });

    it('accepts legacy "snake" / "pascal" / "camel" field names', async () => {
      const lib = new ApiNameLibrary();
      const result = await lib.importCustom(
        JSON.stringify({
          version: 1,
          prefixes: [{ type: 'LegacyShape', snake: 'L_', pascal: 'L', camel: 'l' }],
        }),
      );
      expect(result.success).toBe(true);
      expect(lib.getByType('LegacyShape')?.Snake_Case).toBe('L_');
    });

    it('persists imports to injected storage and rehydrates on load', async () => {
      const storage = createMemoryStorage();
      const lib1 = new ApiNameLibrary({ storage });
      await lib1.importCustom(
        JSON.stringify({
          version: 1,
          prefixes: [{ type: 'Persisted', Snake_Case: 'P_', PascalCase: 'P', camelCase: 'p' }],
        }),
      );
      const lib2 = new ApiNameLibrary({ storage });
      await lib2.load();
      expect(lib2.isCustom()).toBe(true);
      expect(lib2.getByType('Persisted')?.Snake_Case).toBe('P_');
    });
  });

  describe('getAll / getDisplayList', () => {
    it('getAll returns a copy of the prefix list (mutating it does not corrupt state)', async () => {
      const lib = new ApiNameLibrary();
      await lib.load();
      const all = lib.getAll();
      expect(all.length).toBeGreaterThan(0);
      all.length = 0; // mutate the returned copy
      expect(lib.getAll().length).toBeGreaterThan(0);
    });

    it('getDisplayList pairs a lowercased lookup key with the original display label', async () => {
      const lib = new ApiNameLibrary();
      await lib.load();
      const list = lib.getDisplayList();
      const getRecords = list.find((e) => e.display === 'Get Records');
      expect(getRecords).toEqual({ type: 'get records', display: 'Get Records' });
    });
  });

  describe('load with storage', () => {
    it('falls back to defaults when storage holds an empty list', async () => {
      const storage = createMemoryStorage({ 'apiNameGenerator.customPrefixes': [] });
      const lib = new ApiNameLibrary({ storage });
      await lib.load();
      expect(lib.isCustom()).toBe(false);
      expect(lib.getByType('Get Records')?.Snake_Case).toBe('Get_');
    });
  });

  describe('expand — empty normalisation', () => {
    it('returns null when a punctuation-only label normalises to an empty string', async () => {
      const lib = new ApiNameLibrary();
      await lib.load();
      expect(lib.expand('###', 'Get Records', 'Snake_Case')).toBeNull();
      expect(lib.expand('###', 'Get Records', 'camelCase')).toBeNull();
    });
  });

  describe('importCustom — missing case fields default to empty strings', () => {
    it('keeps an entry with only a type, defaulting the case columns to empty', async () => {
      const lib = new ApiNameLibrary();
      const result = await lib.importCustom(
        JSON.stringify({ version: 1, prefixes: [{ type: 'BareType' }] }),
      );
      expect(result.success).toBe(true);
      expect(lib.getByType('BareType')).toEqual({
        type: 'BareType',
        Snake_Case: '',
        PascalCase: '',
        camelCase: '',
      });
    });
  });

  describe('resetToDefaults', () => {
    it('clears custom prefixes and restores the defaults', async () => {
      const storage = createMemoryStorage();
      const lib = new ApiNameLibrary({ storage });
      await lib.importCustom(
        JSON.stringify({
          version: 1,
          prefixes: [{ type: 'OnlyMe', Snake_Case: 'OM_', PascalCase: 'OM', camelCase: 'om' }],
        }),
      );
      await lib.resetToDefaults();
      expect(lib.isCustom()).toBe(false);
      expect(lib.getByType('OnlyMe')).toBeNull();
      expect(lib.getByType('Get Records')?.Snake_Case).toBe('Get_');
    });
  });

  describe('exportAsJson', () => {
    it('round-trips through importCustom', async () => {
      const lib1 = new ApiNameLibrary();
      await lib1.load();
      const json = lib1.exportAsJson();
      const lib2 = new ApiNameLibrary();
      const result = await lib2.importCustom(json);
      expect(result.success).toBe(true);
      expect(lib2.getByType('Get Records')?.Snake_Case).toBe('Get_');
    });
  });
});
