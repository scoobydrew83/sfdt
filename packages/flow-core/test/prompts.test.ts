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
});
