// AI Prompt Library — ported from
// /Users/dkennedy/dev/2.0.2_0 copy/config/ai-prompt-library.js.
//
// Unified API over the shipped default prompts and any user-created custom
// prompts. The v2.0.2 module hard-coded chrome.storage.* access and the
// legacy-sync migration; this port inverts both — storage is injected via
// KeyValueStorage, and the migration shim lives in the extension wrapper
// where it has access to chrome.storage.sync.
//
// Surface preserved at parity: load, reload, getCategories, getAll, getEnabled,
// getStandardPrompts, getCustomPrompts, getById, getDefaultPromptId,
// getStoredDefaultPromptId, setDefaultPromptId, assemble, setStandardEnabled,
// cloneToCustom, addCustom, updateCustom, deleteCustom, exportCustomsAsJson,
// importCustoms, validateCustomPrompt.

import {
  DEFAULT_PROMPT_TEMPLATES,
  type DefaultPromptTemplate,
  type PromptCategory,
  type PromptContext,
} from './default-prompts.js';
import type { KeyValueStorage } from './storage.js';

export const PROMPT_CATEGORIES = Object.freeze([
  'Documentation',
  'Debugging',
  'Analysis',
  'Optimization',
  'Diagramming',
  'Testing',
  'Explanation',
] as const);

const DEFAULT_CONTEXTS: readonly PromptContext[] = Object.freeze(['flow-canvas']);

const CUSTOM_ID_PREFIX = 'custom_';
const MAX_TITLE_LEN = 100;
const MAX_DESCRIPTION_LEN = 500;
const MAX_PROMPT_LEN = 50_000;

const STORAGE_KEY_DISABLED = 'aiPromptLibrary.disabledStandardIds';
const STORAGE_KEY_CUSTOMS = 'aiPromptLibrary.customPrompts';
const STORAGE_KEY_DEFAULT = 'aiPromptLibrary.defaultPromptId';

export interface CustomPrompt {
  id: string;
  title: string;
  description: string;
  prompt: string;
  category: PromptCategory;
  contexts: PromptContext[];
  enabled: boolean;
  createdAt: string;
  modifiedAt: string;
}

export interface ResolvedPrompt {
  id: string;
  title: string;
  description: string;
  prompt: string;
  category: PromptCategory;
  contexts: PromptContext[];
  enabled: boolean;
  _type: 'standard' | 'custom';
  _isFallbackDefault?: boolean;
  createdAt?: string;
  modifiedAt?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export type ConflictMode = 'skip' | 'overwrite' | 'copy';

export interface ImportOptions {
  conflictMode?: ConflictMode;
  dryRun?: boolean;
}

export interface ImportEntry {
  id: string;
  title: string;
  reason?: string;
}

export interface ImportError {
  title: string;
  reasons: string[];
}

export interface ImportResult {
  imported: ImportEntry[];
  skipped: ImportEntry[];
  overwritten: ImportEntry[];
  copied: ImportEntry[];
  errors: ImportError[];
  fatal: string | null;
}

export interface PromptLibraryOptions {
  storage?: KeyValueStorage;
  defaults?: readonly DefaultPromptTemplate[];
  // Override for tests so timestamps and IDs are deterministic.
  now?: () => string;
  generateId?: () => string;
}

interface CryptoLike {
  randomUUID?: () => string;
}

function defaultIdGenerator(): string {
  // crypto.randomUUID is available in Node 22+ and all modern browsers via
  // globalThis. Look it up without referring to the ambient `crypto` global
  // so flow-core's tsconfig stays DOM-free.
  const g = (globalThis as unknown as { crypto?: CryptoLike }).crypto;
  const uuid =
    g && typeof g.randomUUID === 'function'
      ? g.randomUUID()
      : `${Math.random().toString(16).slice(2, 10)}-${Date.now().toString(16)}`;
  return `${CUSTOM_ID_PREFIX}${uuid.replace(/-/g, '').slice(0, 8)}`;
}

function defaultNow(): string {
  return new Date().toISOString();
}

function normaliseContexts(input: unknown): PromptContext[] {
  if (!Array.isArray(input) || input.length === 0) return DEFAULT_CONTEXTS.slice();
  return input.filter((c): c is PromptContext => typeof c === 'string' && c.length > 0);
}

function isCustomPromptShape(value: unknown): value is Partial<CustomPrompt> {
  return typeof value === 'object' && value !== null;
}

function normaliseStoredCustom(raw: unknown, now: () => string): CustomPrompt | null {
  if (!isCustomPromptShape(raw)) return null;
  if (typeof raw.id !== 'string' || !raw.id.startsWith(CUSTOM_ID_PREFIX)) return null;
  if (typeof raw.title !== 'string' || !raw.title.trim()) return null;
  if (typeof raw.prompt !== 'string' || !raw.prompt) return null;

  const rawCategory = raw.category as string | undefined;
  const category: PromptCategory = (PROMPT_CATEGORIES as readonly string[]).includes(rawCategory ?? '')
    ? (rawCategory as PromptCategory)
    : 'Documentation';

  return {
    id: raw.id,
    title: raw.title.trim(),
    description: typeof raw.description === 'string' ? raw.description.trim() : '',
    prompt: raw.prompt,
    category,
    contexts: normaliseContexts(raw.contexts),
    enabled: raw.enabled !== false,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : now(),
    modifiedAt: typeof raw.modifiedAt === 'string' ? raw.modifiedAt : now(),
  };
}

function shapeCustom(custom: CustomPrompt): ResolvedPrompt {
  return {
    id: custom.id,
    title: custom.title,
    description: custom.description,
    prompt: custom.prompt,
    category: custom.category,
    contexts: custom.contexts.slice(),
    enabled: custom.enabled !== false,
    createdAt: custom.createdAt,
    modifiedAt: custom.modifiedAt,
    _type: 'custom',
  };
}

function shapeStandard(
  std: DefaultPromptTemplate,
  disabledIds: readonly string[],
): ResolvedPrompt {
  return {
    id: std.id,
    title: std.title,
    description: std.description,
    prompt: std.prompt,
    category: std.category,
    contexts: Array.isArray(std.contexts) ? std.contexts.slice() : DEFAULT_CONTEXTS.slice(),
    enabled: !disabledIds.includes(std.id),
    _type: 'standard',
    _isFallbackDefault: !!std.isFallbackDefault,
  };
}

function stripInternalFields(custom: CustomPrompt): Omit<CustomPrompt, never> {
  return {
    id: custom.id,
    title: custom.title,
    description: custom.description,
    prompt: custom.prompt,
    category: custom.category,
    contexts: custom.contexts.slice(),
    enabled: custom.enabled !== false,
    createdAt: custom.createdAt,
    modifiedAt: custom.modifiedAt,
  };
}

export class PromptLibrary {
  private readonly storage: KeyValueStorage | null;
  private readonly defaults: readonly DefaultPromptTemplate[];
  private readonly now: () => string;
  private readonly generateId: () => string;

  private disabledIds: string[] = [];
  private customs: CustomPrompt[] = [];
  private defaultId: string | null = null;
  private loaded = false;

  constructor(options: PromptLibraryOptions = {}) {
    this.storage = options.storage ?? null;
    this.defaults = options.defaults ?? DEFAULT_PROMPT_TEMPLATES;
    this.now = options.now ?? defaultNow;
    this.generateId = options.generateId ?? defaultIdGenerator;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    await this.readFromStorage();
    this.loaded = true;
  }

  async reload(): Promise<void> {
    this.loaded = false;
    await this.load();
  }

  private async readFromStorage(): Promise<void> {
    if (!this.storage) {
      this.disabledIds = [];
      this.customs = [];
      this.defaultId = null;
      return;
    }
    const [disabled, customs, defaultId] = await Promise.all([
      this.storage.get<string[]>(STORAGE_KEY_DISABLED),
      this.storage.get<unknown[]>(STORAGE_KEY_CUSTOMS),
      this.storage.get<string>(STORAGE_KEY_DEFAULT),
    ]);
    this.disabledIds = Array.isArray(disabled) ? disabled.slice() : [];
    this.customs = Array.isArray(customs)
      ? customs.map((raw) => normaliseStoredCustom(raw, this.now)).filter((c): c is CustomPrompt => c !== null)
      : [];
    this.defaultId = typeof defaultId === 'string' ? defaultId : null;
  }

  private async writeDisabled(): Promise<void> {
    if (this.storage) await this.storage.set(STORAGE_KEY_DISABLED, this.disabledIds);
  }

  private async writeCustoms(): Promise<void> {
    if (this.storage) await this.storage.set(STORAGE_KEY_CUSTOMS, this.customs);
  }

  // ----- Read API -----

  getCategories(): readonly PromptCategory[] {
    return PROMPT_CATEGORIES;
  }

  getAll(): ResolvedPrompt[] {
    return [
      ...this.defaults.map((s) => shapeStandard(s, this.disabledIds)),
      ...this.customs.map(shapeCustom),
    ];
  }

  getEnabled(): ResolvedPrompt[] {
    return this.getAll().filter((p) => p.enabled);
  }

  getStandardPrompts(): ResolvedPrompt[] {
    return this.defaults.map((s) => shapeStandard(s, this.disabledIds));
  }

  getCustomPrompts(): ResolvedPrompt[] {
    return this.customs.map(shapeCustom);
  }

  getById(id: string | null | undefined): ResolvedPrompt | null {
    if (!id) return null;
    return this.getAll().find((p) => p.id === id) ?? null;
  }

  getStoredDefaultPromptId(): string | null {
    return this.defaultId;
  }

  // Resolves the current default prompt id, self-healing if nothing is enabled.
  // Returns null only if the library has no prompts at all.
  getDefaultPromptId(): string | null {
    const all = this.getAll();

    if (this.defaultId) {
      const current = all.find((p) => p.id === this.defaultId);
      if (current && current.enabled) return current.id;
    }

    const firstEnabled = all.find((p) => p.enabled);
    if (firstEnabled) return firstEnabled.id;

    const fallback = this.defaults.find((t) => t.isFallbackDefault) ?? this.defaults[0];
    if (fallback) {
      // Force-enable the fallback so the AI Assistant never opens with nothing.
      this.disabledIds = this.disabledIds.filter((x) => x !== fallback.id);
      void this.writeDisabled();
      return fallback.id;
    }
    return null;
  }

  async setDefaultPromptId(id: string): Promise<void> {
    await this.load();
    const prompt = this.getById(id);
    if (!prompt) throw new Error(`Unknown prompt id: ${id}`);
    this.defaultId = id;
    if (this.storage) await this.storage.set(STORAGE_KEY_DEFAULT, id);
  }

  assemble(id: string, metadataJson: string): string | null {
    const prompt = this.getById(id);
    if (!prompt) return null;
    return prompt.prompt + metadataJson;
  }

  // ----- Standard prompt actions -----

  async setStandardEnabled(id: string, enabled: boolean): Promise<void> {
    await this.load();
    if (!this.defaults.some((t) => t.id === id)) {
      throw new Error(`Unknown standard prompt id: ${id}`);
    }
    const currentlyDisabled = this.disabledIds.includes(id);
    if (enabled && currentlyDisabled) {
      this.disabledIds = this.disabledIds.filter((x) => x !== id);
      await this.writeDisabled();
    } else if (!enabled && !currentlyDisabled) {
      this.disabledIds = this.disabledIds.concat(id);
      await this.writeDisabled();
    }
  }

  async cloneToCustom(standardId: string): Promise<ResolvedPrompt> {
    await this.load();
    const source = this.defaults.find((t) => t.id === standardId);
    if (!source) throw new Error(`Unknown standard prompt id: ${standardId}`);

    const now = this.now();
    const custom: CustomPrompt = {
      id: this.generateId(),
      title: `${source.title} (Custom)`,
      description: source.description,
      prompt: source.prompt,
      category: source.category,
      contexts: Array.isArray(source.contexts) ? source.contexts.slice() : DEFAULT_CONTEXTS.slice(),
      enabled: true,
      createdAt: now,
      modifiedAt: now,
    };
    this.customs.push(custom);
    await this.writeCustoms();
    await this.setStandardEnabled(standardId, false);
    return shapeCustom(custom);
  }

  // ----- Custom prompt actions -----

  async addCustom(data: Partial<CustomPrompt>): Promise<ResolvedPrompt> {
    await this.load();
    const validation = this.validateCustomPrompt(data);
    if (!validation.valid) {
      throw new Error('Invalid custom prompt: ' + validation.errors.join('; '));
    }
    const now = this.now();
    const custom: CustomPrompt = {
      id: this.generateId(),
      title: String(data.title).trim(),
      description: String(data.description).trim(),
      prompt: String(data.prompt),
      category: data.category as PromptCategory,
      contexts: normaliseContexts(data.contexts),
      enabled: data.enabled !== false,
      createdAt: now,
      modifiedAt: now,
    };
    this.customs.push(custom);
    await this.writeCustoms();
    return shapeCustom(custom);
  }

  async updateCustom(id: string, updates: Partial<CustomPrompt>): Promise<ResolvedPrompt> {
    await this.load();
    const index = this.customs.findIndex((c) => c.id === id);
    if (index === -1) throw new Error(`Unknown custom prompt id: ${id}`);
    const current = this.customs[index]!;
    const merged: CustomPrompt = {
      ...current,
      title: updates.title !== undefined ? String(updates.title).trim() : current.title,
      description:
        updates.description !== undefined ? String(updates.description).trim() : current.description,
      prompt: updates.prompt !== undefined ? String(updates.prompt) : current.prompt,
      category: updates.category !== undefined ? (updates.category as PromptCategory) : current.category,
      contexts:
        updates.contexts !== undefined ? normaliseContexts(updates.contexts) : current.contexts,
      enabled: updates.enabled !== undefined ? !!updates.enabled : current.enabled,
      modifiedAt: this.now(),
    };
    const validation = this.validateCustomPrompt(merged);
    if (!validation.valid) {
      throw new Error('Invalid custom prompt: ' + validation.errors.join('; '));
    }
    this.customs[index] = merged;
    await this.writeCustoms();
    return shapeCustom(merged);
  }

  async deleteCustom(id: string): Promise<boolean> {
    await this.load();
    const before = this.customs.length;
    this.customs = this.customs.filter((c) => c.id !== id);
    if (this.customs.length === before) return false;
    await this.writeCustoms();
    if (this.defaultId === id) {
      this.defaultId = null;
      if (this.storage) await this.storage.remove(STORAGE_KEY_DEFAULT);
    }
    return true;
  }

  // ----- Import / export -----

  exportCustomsAsJson(): string {
    return JSON.stringify(
      {
        version: 1,
        exportedAt: this.now(),
        prompts: this.customs.map(stripInternalFields),
      },
      null,
      2,
    );
  }

  async importCustoms(jsonText: string, options: ImportOptions = {}): Promise<ImportResult> {
    await this.load();
    const conflictMode: ConflictMode = options.conflictMode ?? 'skip';
    const dryRun = !!options.dryRun;
    const result: ImportResult = {
      imported: [],
      skipped: [],
      overwritten: [],
      copied: [],
      errors: [],
      fatal: null,
    };

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      result.fatal = 'File is not valid JSON: ' + (e as Error).message;
      return result;
    }

    const prompts: unknown[] | null = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { prompts?: unknown[] }).prompts)
        ? (parsed as { prompts: unknown[] }).prompts
        : null;

    if (!prompts) {
      result.fatal =
        'Expected a JSON object with a "prompts" array, or a JSON array of prompts.';
      return result;
    }

    const working = this.customs.slice();
    const now = this.now();

    for (let i = 0; i < prompts.length; i += 1) {
      const raw = prompts[i] as Partial<CustomPrompt> | null;
      const label = raw && typeof raw.title === 'string' ? raw.title.slice(0, 60) : `item[${i}]`;

      const validation = this.validateCustomPrompt(raw);
      if (!validation.valid) {
        result.errors.push({ title: label, reasons: validation.errors });
        continue;
      }

      const incomingId = typeof raw?.id === 'string' && raw.id.startsWith(CUSTOM_ID_PREFIX) ? raw.id : this.generateId();

      const candidate: CustomPrompt = {
        id: incomingId,
        title: String(raw!.title).trim(),
        description: String(raw!.description).trim(),
        prompt: String(raw!.prompt),
        category: raw!.category as PromptCategory,
        contexts: normaliseContexts(raw!.contexts),
        enabled: raw!.enabled !== false,
        createdAt: typeof raw!.createdAt === 'string' ? raw!.createdAt : now,
        modifiedAt: now,
      };

      const conflictIndex = working.findIndex((c) => c.id === candidate.id);
      if (conflictIndex === -1) {
        working.push(candidate);
        result.imported.push({ id: candidate.id, title: candidate.title });
        continue;
      }

      if (conflictMode === 'skip') {
        result.skipped.push({ id: candidate.id, title: candidate.title, reason: 'ID already exists' });
      } else if (conflictMode === 'overwrite') {
        working[conflictIndex] = candidate;
        result.overwritten.push({ id: candidate.id, title: candidate.title });
      } else if (conflictMode === 'copy') {
        candidate.id = this.generateId();
        working.push(candidate);
        result.copied.push({ id: candidate.id, title: candidate.title });
      }
    }

    if (!dryRun) {
      this.customs = working;
      await this.writeCustoms();
    }
    return result;
  }

  // ----- Validation -----

  validateCustomPrompt(data: unknown): ValidationResult {
    const errors: string[] = [];
    if (!data || typeof data !== 'object') {
      return { valid: false, errors: ['Prompt must be an object.'] };
    }

    const d = data as Partial<CustomPrompt> & { id?: unknown };
    const title = typeof d.title === 'string' ? d.title.trim() : '';
    const description = typeof d.description === 'string' ? d.description.trim() : '';
    const prompt = typeof d.prompt === 'string' ? d.prompt : '';
    const category = typeof d.category === 'string' ? d.category : '';

    if (!title) errors.push('Title is required.');
    else if (title.length > MAX_TITLE_LEN) errors.push(`Title must be ${MAX_TITLE_LEN} characters or fewer.`);

    if (!description) errors.push('Description is required.');
    else if (description.length > MAX_DESCRIPTION_LEN)
      errors.push(`Description must be ${MAX_DESCRIPTION_LEN} characters or fewer.`);

    if (!prompt || !prompt.trim()) errors.push('Prompt text is required.');
    else if (prompt.length > MAX_PROMPT_LEN)
      errors.push(`Prompt must be ${MAX_PROMPT_LEN} characters or fewer.`);

    if (!category) errors.push('Category is required.');
    else if (!(PROMPT_CATEGORIES as readonly string[]).includes(category))
      errors.push(`Category must be one of: ${PROMPT_CATEGORIES.join(', ')}.`);

    if (d.id !== undefined && d.id !== null) {
      if (typeof d.id !== 'string' || !d.id.startsWith(CUSTOM_ID_PREFIX)) {
        errors.push(`Custom prompt id must be a string starting with "${CUSTOM_ID_PREFIX}".`);
      }
    }

    return { valid: errors.length === 0, errors };
  }
}
