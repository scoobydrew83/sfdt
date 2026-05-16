import { DEFAULT_PREFIXES, ICON_TO_TYPE } from './api-name-defaults.js';
import type { PrefixEntry } from './api-name-defaults.js';
import type { KeyValueStorage } from './storage.js';
export type NamingPattern = 'Snake_Case' | 'PascalCase' | 'camelCase';
export type { PrefixEntry };
export interface PrefixFile {
  version: number;
  description?: string;
  prefixes: PrefixEntry[];
}
export interface ApiNameImportResult {
  success: boolean;
  count: number;
  error?: string;
}
const STORAGE_KEY = 'apiNameGenerator.customPrefixes';
function normaliseEntry(raw: Partial<PrefixEntry> & Record<string, unknown>): PrefixEntry | null {
  const type = String(raw.type ?? '').trim();
  if (!type) return null;
  return {
    type,
    Snake_Case: String(raw.Snake_Case ?? raw.snake ?? '').trim(),
    PascalCase: String(raw.PascalCase ?? raw.pascal ?? '').trim(),
    camelCase: String(raw.camelCase ?? raw.camel ?? '').trim(),
  };
}
function toSnakeCase(label: string): string {
  return label
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/^_+|_+$/g, '');
}
function toPascalCase(label: string): string {
  return label
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}
function toCamelCase(label: string): string {
  const pascal = toPascalCase(label);
  return pascal ? pascal.charAt(0).toLowerCase() + pascal.slice(1) : '';
}
function applyPattern(label: string, pattern: NamingPattern): string {
  switch (pattern) {
    case 'Snake_Case':
      return toSnakeCase(label);
    case 'PascalCase':
      return toPascalCase(label);
    case 'camelCase':
      return toCamelCase(label);
  }
}
export interface ApiNameLibraryOptions {
  storage?: KeyValueStorage;
  defaults?: readonly PrefixEntry[];
}
export class ApiNameLibrary {
  private readonly storage: KeyValueStorage | null;
  private readonly defaults: readonly PrefixEntry[];
  private prefixes: PrefixEntry[];
  private custom = false;
  private loaded = false;
  constructor(options: ApiNameLibraryOptions = {}) {
    this.storage = options.storage ?? null;
    this.defaults = options.defaults ?? DEFAULT_PREFIXES;
    this.prefixes = this.defaults.slice();
  }
  async load(): Promise<void> {
    if (this.loaded) return;
    if (this.storage) {
      const stored = await this.storage.get<PrefixEntry[]>(STORAGE_KEY);
      if (Array.isArray(stored) && stored.length > 0) {
        this.prefixes = stored;
        this.custom = true;
        this.loaded = true;
        return;
      }
    }
    this.prefixes = this.defaults.slice();
    this.custom = false;
    this.loaded = true;
  }
  isCustom(): boolean {
    return this.custom;
  }
  getAll(): PrefixEntry[] {
    return this.prefixes.slice();
  }
  getByType(typeName: string | null | undefined): PrefixEntry | null {
    if (!typeName) return null;
    const lower = typeName.toLowerCase();
    return this.prefixes.find((p) => p.type.toLowerCase() === lower) ?? null;
  }
  getTypeFromIconName(iconName: string | null | undefined): string | null {
    if (!iconName) return null;
    return ICON_TO_TYPE[iconName] ?? null;
  }
  getDisplayList(): Array<{ type: string; display: string }> {
    return this.prefixes.map((p) => ({ type: p.type.toLowerCase(), display: p.type }));
  }
  exportAsJson(): string {
    const file: PrefixFile = {
      version: 1,
      description: 'Custom API name prefixes for SFDT SF Helper.',
      prefixes: this.prefixes,
    };
    return JSON.stringify(file, null, 2);
  }
  expand(label: string, typeName: string, pattern: NamingPattern): string | null {
    if (!label || !label.trim()) return null;
    const entry = this.getByType(typeName);
    const prefix = entry ? entry[pattern] : '';
    const normalised = applyPattern(label, pattern);
    if (!normalised) return null;
    return `${prefix}${normalised}`;
  }
  async importCustom(jsonString: string): Promise<ApiNameImportResult> {
    let data: unknown;
    try {
      data = JSON.parse(jsonString);
    } catch (err) {
      return { success: false, count: 0, error: `Invalid JSON: ${(err as Error).message}` };
    }
    if (
      !data ||
      typeof data !== 'object' ||
      !Array.isArray((data as { prefixes?: unknown }).prefixes)
    ) {
      return { success: false, count: 0, error: 'JSON must contain a "prefixes" array.' };
    }
    const valid = ((data as PrefixFile).prefixes as Array<Partial<PrefixEntry>>)
      .map(normaliseEntry)
      .filter((entry): entry is PrefixEntry => entry !== null);
    if (valid.length === 0) {
      return {
        success: false,
        count: 0,
        error: 'No valid prefix entries found. Each entry needs at least a "type" field.',
      };
    }
    if (this.storage) await this.storage.set(STORAGE_KEY, valid);
    this.prefixes = valid;
    this.custom = true;
    this.loaded = true;
    return { success: true, count: valid.length };
  }
  async resetToDefaults(): Promise<void> {
    if (this.storage) await this.storage.remove(STORAGE_KEY);
    this.prefixes = this.defaults.slice();
    this.custom = false;
    this.loaded = true;
  }
}
export { ICON_TO_TYPE, DEFAULT_PREFIXES };
