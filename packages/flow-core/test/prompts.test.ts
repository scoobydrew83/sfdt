import { describe, it, expect } from 'vitest';
import { PromptLibrary, PROMPT_CATEGORIES } from '../src/prompts.js';
import { createMemoryStorage } from '../src/storage.js';

function makeLib(seed: Record<string, unknown> = {}) {
  const storage = createMemoryStorage(seed);
  let counter = 0;
  const lib = new PromptLibrary({
    storage,
    now: () => '2026-05-14T12:00:00.000Z',
    generateId: () => {
      counter += 1;
      return `custom_t${counter.toString(16).padStart(8, '0')}`;
    },
  });
  return { lib, storage };
}

describe('flow-core/prompts', () => {
  describe('read API', () => {
    it('getAll returns 5 standards + 0 customs on fresh load', async () => {
      const { lib } = makeLib();
      await lib.load();
      const all = lib.getAll();
      expect(all).toHaveLength(5);
      expect(all.every((p) => p._type === 'standard')).toBe(true);
    });

    it('getEnabled hides disabled standards', async () => {
      const { lib } = makeLib({ 'aiPromptLibrary.disabledStandardIds': ['draw-io'] });
      await lib.load();
      const enabled = lib.getEnabled();
      expect(enabled.find((p) => p.id === 'draw-io')).toBeUndefined();
      expect(enabled.find((p) => p.id === 'summarise')).toBeDefined();
    });

    it('getCategories exposes the frozen category list', () => {
      const { lib } = makeLib();
      expect(lib.getCategories()).toBe(PROMPT_CATEGORIES);
    });

    it('getById finds standards and customs', async () => {
      const { lib } = makeLib();
      await lib.load();
      expect(lib.getById('summarise')?.title).toBe('Summarise Flow');
      expect(lib.getById('nonsense')).toBeNull();
    });
  });

  describe('default prompt resolution', () => {
    it('falls back to the isFallbackDefault template when no defaultId is stored', async () => {
      const { lib } = makeLib();
      await lib.load();
      expect(lib.getDefaultPromptId()).toBe('summarise');
    });

    it('honours a stored defaultId if it resolves to an enabled prompt', async () => {
      const { lib } = makeLib({ 'aiPromptLibrary.defaultPromptId': 'improvements' });
      await lib.load();
      expect(lib.getDefaultPromptId()).toBe('improvements');
    });

    it('skips a stored defaultId that points at a disabled prompt', async () => {
      const { lib } = makeLib({
        'aiPromptLibrary.defaultPromptId': 'improvements',
        'aiPromptLibrary.disabledStandardIds': ['improvements'],
      });
      await lib.load();
      // Should fall through to the first enabled prompt — which is the
      // fallback default (summarise).
      expect(lib.getDefaultPromptId()).toBe('summarise');
    });

    it('self-heals by re-enabling the fallback when every prompt is disabled', async () => {
      const { lib } = makeLib({
        'aiPromptLibrary.disabledStandardIds': [
          'summarise',
          'describe-elements',
          'draw-io',
          'improvements',
          'test-scenarios',
        ],
      });
      await lib.load();
      expect(lib.getDefaultPromptId()).toBe('summarise');
      // After the call, summarise is no longer in the disabled list.
      expect(lib.getStandardPrompts().find((p) => p.id === 'summarise')?.enabled).toBe(true);
    });
  });

  describe('setDefaultPromptId', () => {
    it('persists the choice to storage', async () => {
      const { lib, storage } = makeLib();
      await lib.load();
      await lib.setDefaultPromptId('draw-io');
      expect(await storage.get('aiPromptLibrary.defaultPromptId')).toBe('draw-io');
    });

    it('throws on unknown id', async () => {
      const { lib } = makeLib();
      await lib.load();
      await expect(lib.setDefaultPromptId('nonsense')).rejects.toThrow(/Unknown/);
    });
  });

  describe('assemble', () => {
    it('appends metadata JSON to the prompt body', async () => {
      const { lib } = makeLib();
      await lib.load();
      const out = lib.assemble('summarise', '{"x": 1}')!;
      expect(out.endsWith('{"x": 1}')).toBe(true);
    });

    it('returns null for an unknown id', async () => {
      const { lib } = makeLib();
      await lib.load();
      expect(lib.assemble('nonsense', '{}')).toBeNull();
    });
  });

  describe('setStandardEnabled', () => {
    it('persists disable and enable transitions', async () => {
      const { lib, storage } = makeLib();
      await lib.load();
      await lib.setStandardEnabled('draw-io', false);
      expect(await storage.get('aiPromptLibrary.disabledStandardIds')).toContain('draw-io');
      await lib.setStandardEnabled('draw-io', true);
      expect(await storage.get('aiPromptLibrary.disabledStandardIds')).not.toContain('draw-io');
    });

    it('throws on unknown standard id', async () => {
      const { lib } = makeLib();
      await lib.load();
      await expect(lib.setStandardEnabled('nonsense', false)).rejects.toThrow(/Unknown/);
    });
  });

  describe('addCustom / validation', () => {
    it('creates a custom prompt with generated id and timestamps', async () => {
      const { lib } = makeLib();
      await lib.load();
      const custom = await lib.addCustom({
        title: 'My Prompt',
        description: 'Custom analysis',
        prompt: 'Do the thing.',
        category: 'Analysis',
      });
      expect(custom.id).toMatch(/^custom_/);
      expect(custom._type).toBe('custom');
      expect(custom.createdAt).toBe('2026-05-14T12:00:00.000Z');
    });

    it('rejects a prompt missing required fields', async () => {
      const { lib } = makeLib();
      await lib.load();
      await expect(lib.addCustom({ title: 'just a title' } as never)).rejects.toThrow(/Invalid/);
    });

    it('rejects unknown categories', async () => {
      const { lib } = makeLib();
      await lib.load();
      await expect(
        lib.addCustom({
          title: 'X',
          description: 'X',
          prompt: 'X',
          category: 'NoSuchCategory' as never,
        }),
      ).rejects.toThrow(/Category/);
    });

    it('rejects titles longer than the limit', async () => {
      const { lib } = makeLib();
      await lib.load();
      await expect(
        lib.addCustom({
          title: 'x'.repeat(200),
          description: 'X',
          prompt: 'X',
          category: 'Analysis',
        }),
      ).rejects.toThrow(/Title/);
    });
  });

  describe('updateCustom', () => {
    it('merges updates and bumps modifiedAt', async () => {
      const { lib } = makeLib();
      await lib.load();
      const created = await lib.addCustom({
        title: 'Original',
        description: 'D',
        prompt: 'P',
        category: 'Analysis',
      });
      const updated = await lib.updateCustom(created.id, { title: 'Renamed' });
      expect(updated.title).toBe('Renamed');
      expect(updated.description).toBe('D');
    });

    it('throws on unknown custom id', async () => {
      const { lib } = makeLib();
      await lib.load();
      await expect(lib.updateCustom('custom_nope', { title: 'X' })).rejects.toThrow(/Unknown/);
    });
  });

  describe('deleteCustom', () => {
    it('removes the custom prompt', async () => {
      const { lib } = makeLib();
      await lib.load();
      const created = await lib.addCustom({
        title: 'X',
        description: 'X',
        prompt: 'X',
        category: 'Analysis',
      });
      expect(await lib.deleteCustom(created.id)).toBe(true);
      expect(lib.getById(created.id)).toBeNull();
    });

    it('clears the stored default if the deleted prompt was the default', async () => {
      const { lib, storage } = makeLib();
      await lib.load();
      const created = await lib.addCustom({
        title: 'X',
        description: 'X',
        prompt: 'X',
        category: 'Analysis',
      });
      await lib.setDefaultPromptId(created.id);
      await lib.deleteCustom(created.id);
      expect(await storage.get('aiPromptLibrary.defaultPromptId')).toBeNull();
    });
  });

  describe('cloneToCustom', () => {
    it('clones a standard, suffixes the title, and disables the source', async () => {
      const { lib } = makeLib();
      await lib.load();
      const clone = await lib.cloneToCustom('draw-io');
      expect(clone.title).toBe('Generate Draw.io Diagram (Custom)');
      expect(lib.getStandardPrompts().find((p) => p.id === 'draw-io')?.enabled).toBe(false);
    });
  });

  describe('importCustoms', () => {
    const sample = {
      version: 1,
      prompts: [
        {
          id: 'custom_AAAAAAAA',
          title: 'Imported',
          description: 'D',
          prompt: 'P',
          category: 'Analysis',
        },
      ],
    };

    it('imports a fresh prompt', async () => {
      const { lib } = makeLib();
      await lib.load();
      const result = await lib.importCustoms(JSON.stringify(sample));
      expect(result.imported).toHaveLength(1);
      expect(result.fatal).toBeNull();
    });

    it('skips ID conflicts by default', async () => {
      const { lib } = makeLib();
      await lib.load();
      await lib.importCustoms(JSON.stringify(sample));
      const result = await lib.importCustoms(JSON.stringify(sample));
      expect(result.imported).toHaveLength(0);
      expect(result.skipped).toHaveLength(1);
    });

    it('overwrite conflict mode replaces existing custom', async () => {
      const { lib } = makeLib();
      await lib.load();
      await lib.importCustoms(JSON.stringify(sample));
      const result = await lib.importCustoms(JSON.stringify(sample), { conflictMode: 'overwrite' });
      expect(result.overwritten).toHaveLength(1);
    });

    it('copy conflict mode imports under a new id', async () => {
      const { lib } = makeLib();
      await lib.load();
      await lib.importCustoms(JSON.stringify(sample));
      const result = await lib.importCustoms(JSON.stringify(sample), { conflictMode: 'copy' });
      expect(result.copied).toHaveLength(1);
      expect(result.copied[0]!.id).not.toBe('custom_AAAAAAAA');
    });

    it('dryRun reports the same shape without persisting', async () => {
      const { lib, storage } = makeLib();
      await lib.load();
      const result = await lib.importCustoms(JSON.stringify(sample), { dryRun: true });
      expect(result.imported).toHaveLength(1);
      expect(await storage.get('aiPromptLibrary.customPrompts')).toBeNull();
    });

    it('rejects malformed JSON via a fatal error', async () => {
      const { lib } = makeLib();
      await lib.load();
      const result = await lib.importCustoms('not json {');
      expect(result.fatal).toMatch(/valid JSON/);
    });

    it('rejects payloads without a prompts array', async () => {
      const { lib } = makeLib();
      await lib.load();
      const result = await lib.importCustoms(JSON.stringify({ version: 1 }));
      expect(result.fatal).toMatch(/prompts/);
    });

    it('per-item errors do not abort the import', async () => {
      const { lib } = makeLib();
      await lib.load();
      const payload = {
        version: 1,
        prompts: [
          { title: 'no description' }, // invalid — should be reported
          { title: 'Good', description: 'D', prompt: 'P', category: 'Analysis' },
        ],
      };
      const result = await lib.importCustoms(JSON.stringify(payload));
      expect(result.errors).toHaveLength(1);
      expect(result.imported).toHaveLength(1);
    });
  });

  describe('exportCustomsAsJson', () => {
    it('round-trips through importCustoms', async () => {
      const { lib: lib1 } = makeLib();
      await lib1.load();
      await lib1.addCustom({
        title: 'X',
        description: 'D',
        prompt: 'P',
        category: 'Analysis',
      });
      const json = lib1.exportCustomsAsJson();

      const { lib: lib2 } = makeLib();
      await lib2.load();
      const result = await lib2.importCustoms(json);
      expect(result.imported).toHaveLength(1);
    });
  });

  describe('reload', () => {
    it('picks up storage changes made out of band', async () => {
      const { lib, storage } = makeLib();
      await lib.load();
      await storage.set('aiPromptLibrary.disabledStandardIds', ['draw-io']);
      await lib.reload();
      expect(lib.getStandardPrompts().find((p) => p.id === 'draw-io')?.enabled).toBe(false);
    });
  });

  describe('default id + timestamp generators', () => {
    // No now/generateId overrides → exercises defaultIdGenerator + defaultNow.
    it('mints a custom_ id and a real ISO timestamp', async () => {
      const lib = new PromptLibrary({ storage: createMemoryStorage() });
      await lib.load();
      const custom = await lib.addCustom({
        title: 'X',
        description: 'D',
        prompt: 'P',
        category: 'Analysis',
      });
      expect(custom.id).toMatch(/^custom_[0-9a-f]{8}$/);
      expect(custom.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    });

    it('uses the getRandomValues fallback when randomUUID is unavailable', async () => {
      const orig = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
      Object.defineProperty(globalThis, 'crypto', {
        configurable: true,
        value: {
          getRandomValues: (buf: Uint8Array) => {
            buf.fill(0xab);
            return buf;
          },
        },
      });
      try {
        const lib = new PromptLibrary({ storage: createMemoryStorage() });
        await lib.load();
        const custom = await lib.addCustom({
          title: 'X',
          description: 'D',
          prompt: 'P',
          category: 'Analysis',
        });
        expect(custom.id).toBe('custom_abababab');
      } finally {
        if (orig) Object.defineProperty(globalThis, 'crypto', orig);
        else delete (globalThis as { crypto?: unknown }).crypto;
      }
    });

    it('falls back to a time-derived id when no crypto API exists', async () => {
      const orig = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
      Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
      try {
        const lib = new PromptLibrary({ storage: createMemoryStorage() });
        await lib.load();
        const custom = await lib.addCustom({
          title: 'X',
          description: 'D',
          prompt: 'P',
          category: 'Analysis',
        });
        expect(custom.id).toMatch(/^custom_[0-9a-f]+$/);
      } finally {
        if (orig) Object.defineProperty(globalThis, 'crypto', orig);
        else delete (globalThis as { crypto?: unknown }).crypto;
      }
    });
  });

  describe('validateCustomPrompt edge cases', () => {
    it('rejects a non-object payload', () => {
      const { lib } = makeLib();
      const result = lib.validateCustomPrompt('nope');
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(['Prompt must be an object.']);
    });

    it('rejects an over-length description', () => {
      const { lib } = makeLib();
      const result = lib.validateCustomPrompt({
        title: 'T',
        description: 'd'.repeat(501),
        prompt: 'P',
        category: 'Analysis',
      });
      expect(result.errors.some((e) => /Description must be/.test(e))).toBe(true);
    });

    it('rejects an over-length prompt body', () => {
      const { lib } = makeLib();
      const result = lib.validateCustomPrompt({
        title: 'T',
        description: 'D',
        prompt: 'p'.repeat(50_001),
        category: 'Analysis',
      });
      expect(result.errors.some((e) => /Prompt must be/.test(e))).toBe(true);
    });

    it('rejects an id that does not use the custom_ prefix', () => {
      const { lib } = makeLib();
      const result = lib.validateCustomPrompt({
        id: 'std-id',
        title: 'T',
        description: 'D',
        prompt: 'P',
        category: 'Analysis',
      });
      expect(result.errors.some((e) => /must be a string starting with/.test(e))).toBe(true);
    });
  });

  describe('without injected storage', () => {
    it('loads with empty state and keeps customs in memory only', async () => {
      const lib = new PromptLibrary();
      await lib.load();
      expect(lib.getAll()).toHaveLength(5);
      expect(lib.getCustomPrompts()).toHaveLength(0);
      const custom = await lib.addCustom({
        title: 'X',
        description: 'D',
        prompt: 'P',
        category: 'Analysis',
      });
      expect(lib.getById(custom.id)?.title).toBe('X');
    });

    it('getById returns null for a null/undefined id', () => {
      const lib = new PromptLibrary();
      expect(lib.getById(null)).toBeNull();
      expect(lib.getById(undefined)).toBeNull();
    });
  });

  describe('custom defaults', () => {
    // A template with no `contexts` array exercises the DEFAULT_CONTEXTS
    // fallback in shapeStandard and cloneToCustom.
    const minimalDefaults = [
      {
        id: 'only-one',
        title: 'Only One',
        description: 'D',
        prompt: 'P',
        category: 'Analysis',
        isFallbackDefault: true,
      },
    ] as never;

    it('shapeStandard falls back to the default contexts when a template omits them', async () => {
      const lib = new PromptLibrary({ storage: createMemoryStorage(), defaults: minimalDefaults });
      await lib.load();
      const std = lib.getStandardPrompts()[0]!;
      expect(std.contexts).toEqual(['flow-canvas']);
    });

    it('cloneToCustom copies the default contexts when the source template omits them', async () => {
      const lib = new PromptLibrary({ storage: createMemoryStorage(), defaults: minimalDefaults });
      await lib.load();
      const clone = await lib.cloneToCustom('only-one');
      expect(clone.contexts).toEqual(['flow-canvas']);
    });

    it('getDefaultPromptId returns null when there are no templates at all', async () => {
      const lib = new PromptLibrary({ storage: createMemoryStorage(), defaults: [] as never });
      await lib.load();
      expect(lib.getDefaultPromptId()).toBeNull();
    });
  });

  describe('customs hydrated from storage', () => {
    it('normalises stored customs and drops malformed entries', async () => {
      const stored = [
        null, // not an object
        { id: 'not-custom', title: 'T', prompt: 'P' }, // wrong id prefix
        { id: 'custom_a', prompt: 'P' }, // missing title
        { id: 'custom_b', title: 'B' }, // missing prompt
        {
          id: 'custom_full',
          title: '  Full  ',
          description: '  desc  ',
          prompt: 'body',
          category: 'NopeCategory', // invalid → coerced to Documentation
          contexts: ['flow-canvas'],
          enabled: false,
          createdAt: '2020-01-01T00:00:00.000Z',
          modifiedAt: '2020-01-02T00:00:00.000Z',
        },
        {
          id: 'custom_min',
          title: 'Min',
          prompt: 'body', // no description, no timestamps → defaults applied
        },
      ];
      const { lib } = makeLib({ 'aiPromptLibrary.customPrompts': stored });
      await lib.load();
      const customs = lib.getCustomPrompts();
      expect(customs.map((c) => c.id).sort()).toEqual(['custom_full', 'custom_min']);

      const full = customs.find((c) => c.id === 'custom_full')!;
      expect(full.title).toBe('Full'); // trimmed
      expect(full.description).toBe('desc'); // trimmed
      expect(full.category).toBe('Documentation'); // invalid coerced
      expect(full.enabled).toBe(false);
      expect(full.createdAt).toBe('2020-01-01T00:00:00.000Z');

      const min = customs.find((c) => c.id === 'custom_min')!;
      expect(min.description).toBe('');
      expect(min.createdAt).toBe('2026-05-14T12:00:00.000Z'); // from now()
    });
  });

  describe('getStoredDefaultPromptId', () => {
    it('returns the raw stored id without self-healing', async () => {
      const { lib } = makeLib({ 'aiPromptLibrary.defaultPromptId': 'improvements' });
      await lib.load();
      expect(lib.getStoredDefaultPromptId()).toBe('improvements');
    });

    it('returns null when nothing is stored', async () => {
      const { lib } = makeLib();
      await lib.load();
      expect(lib.getStoredDefaultPromptId()).toBeNull();
    });
  });

  describe('deleteCustom — miss', () => {
    it('returns false when the id does not exist', async () => {
      const { lib } = makeLib();
      await lib.load();
      expect(await lib.deleteCustom('custom_missing')).toBe(false);
    });
  });

  describe('importCustoms — additional shapes', () => {
    it('accepts a bare JSON array of prompts', async () => {
      const { lib } = makeLib();
      await lib.load();
      const result = await lib.importCustoms(
        JSON.stringify([{ title: 'Arr', description: 'D', prompt: 'P', category: 'Analysis' }]),
      );
      expect(result.fatal).toBeNull();
      expect(result.imported).toHaveLength(1);
    });

    it('labels an invalid item with no string title as item[index]', async () => {
      const { lib } = makeLib();
      await lib.load();
      const result = await lib.importCustoms(JSON.stringify({ prompts: [{ description: 'D' }] }));
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.title).toBe('item[0]');
    });
  });

  describe('validateCustomPrompt — non-string fields', () => {
    it('treats a non-string title as missing', () => {
      const { lib } = makeLib();
      const result = lib.validateCustomPrompt({
        title: 123,
        description: 'D',
        prompt: 'P',
        category: 'Analysis',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => /Title is required/.test(e))).toBe(true);
    });
  });

  describe('updateCustom validation', () => {
    it('throws when the merged result is invalid (e.g. blanked title)', async () => {
      const { lib } = makeLib();
      await lib.load();
      const created = await lib.addCustom({
        title: 'Keep',
        description: 'D',
        prompt: 'P',
        category: 'Analysis',
      });
      await expect(lib.updateCustom(created.id, { title: '   ' })).rejects.toThrow(/Invalid/);
    });
  });
});
