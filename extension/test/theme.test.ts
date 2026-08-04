import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resolveEffectiveTheme,
  applyTheme,
  watchTheme,
  type EffectiveTheme,
} from '../lib/theme.js';
import {
  SettingsSchema,
  saveSettings,
  _clearSettingsCacheForTests,
} from '../lib/settings.js';

const THEME_ATTR = 'data-sfdt-theme';

// Controllable prefers-color-scheme mock. Captures registered change listeners
// so the test can drive an OS scheme flip, mirroring a real MediaQueryList.
function installMatchMedia(initialDark: boolean) {
  let dark = initialDark;
  const listeners = new Set<() => void>();
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query.includes('dark') ? dark : false,
    media: query,
    addEventListener: (_: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
    addListener: (cb: () => void) => listeners.add(cb),
    removeListener: (cb: () => void) => listeners.delete(cb),
    dispatchEvent: () => true,
    onchange: null,
  })) as unknown as typeof window.matchMedia;
  return {
    setDark(next: boolean) {
      dark = next;
      for (const cb of listeners) cb();
    },
    listenerCount: () => listeners.size,
    restore() {
      window.matchMedia = original;
    },
  };
}

// watchTheme applies asynchronously (loadSettings + storage microtasks).
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('extension/lib/theme', () => {
  beforeEach(() => {
    _clearSettingsCacheForTests();
    document.documentElement.removeAttribute(THEME_ATTR);
  });

  describe('resolveEffectiveTheme (stored setting + OS → effective)', () => {
    it('manual light/dark wins over the OS', () => {
      expect(resolveEffectiveTheme('light', true)).toBe('light');
      expect(resolveEffectiveTheme('light', false)).toBe('light');
      expect(resolveEffectiveTheme('dark', false)).toBe('dark');
      expect(resolveEffectiveTheme('dark', true)).toBe('dark');
    });

    it('auto follows the OS preference', () => {
      expect(resolveEffectiveTheme('auto', true)).toBe('dark');
      expect(resolveEffectiveTheme('auto', false)).toBe('light');
    });
  });

  describe('applyTheme', () => {
    let mm: ReturnType<typeof installMatchMedia>;
    afterEach(() => mm?.restore());

    it('writes the resolved theme to the document root and returns it', () => {
      mm = installMatchMedia(true);
      const eff: EffectiveTheme = applyTheme('auto', document);
      expect(eff).toBe('dark');
      expect(document.documentElement.getAttribute(THEME_ATTR)).toBe('dark');
    });

    it('manual light overrides an OS dark preference', () => {
      mm = installMatchMedia(true);
      expect(applyTheme('light', document)).toBe('light');
      expect(document.documentElement.getAttribute(THEME_ATTR)).toBe('light');
    });
  });

  describe('watchTheme', () => {
    let mm: ReturnType<typeof installMatchMedia>;
    afterEach(() => mm?.restore());

    it('reads the persisted setting on boot (persistence read)', async () => {
      await saveSettings(SettingsSchema.parse({ theme: 'dark' }));
      _clearSettingsCacheForTests();
      mm = installMatchMedia(false);

      const { stop } = watchTheme(document);
      await flush();
      expect(document.documentElement.getAttribute(THEME_ATTR)).toBe('dark');
      stop();
    });

    it('defaults to auto and follows the OS when nothing is stored', async () => {
      mm = installMatchMedia(true); // OS = dark
      const { stop } = watchTheme(document);
      await flush();
      expect(document.documentElement.getAttribute(THEME_ATTR)).toBe('dark');
      stop();
    });

    it('auto re-applies live when the OS scheme flips (media-query listener)', async () => {
      mm = installMatchMedia(false); // OS = light
      const { stop } = watchTheme(document);
      await flush();
      expect(document.documentElement.getAttribute(THEME_ATTR)).toBe('light');

      mm.setDark(true); // OS flips to dark
      expect(document.documentElement.getAttribute(THEME_ATTR)).toBe('dark');
      stop();
    });

    it('re-applies when the setting changes in another surface', async () => {
      await saveSettings(SettingsSchema.parse({ theme: 'light' }));
      _clearSettingsCacheForTests();
      mm = installMatchMedia(true); // OS dark, but setting is light
      const { stop } = watchTheme(document);
      await flush();
      expect(document.documentElement.getAttribute(THEME_ATTR)).toBe('light');

      // Another surface writes dark → onSettingsChange fires.
      await saveSettings(SettingsSchema.parse({ theme: 'dark' }));
      await flush();
      expect(document.documentElement.getAttribute(THEME_ATTR)).toBe('dark');
      stop();
    });

    it('unsubscribe detaches the media-query listener', async () => {
      mm = installMatchMedia(false);
      const { stop } = watchTheme(document);
      await flush();
      expect(mm.listenerCount()).toBe(1);
      stop();
      expect(mm.listenerCount()).toBe(0);
    });

    it('persists across a restart: saved dark survives a cache-cleared reload', async () => {
      await saveSettings(SettingsSchema.parse({ theme: 'dark' }));
      // Simulate a fresh boot: cache cleared, storage retained.
      _clearSettingsCacheForTests();
      document.documentElement.removeAttribute(THEME_ATTR);
      mm = installMatchMedia(false);
      const { stop } = watchTheme(document);
      await flush();
      expect(document.documentElement.getAttribute(THEME_ATTR)).toBe('dark');
      stop();
    });

    it('preview via setSetting survives an OS scheme flip (manual wins for unsaved preview)', async () => {
      // Repro of the options live-preview bug: saved=auto, OS=light, user
      // previews "light"; OS flips to dark before Save must NOT revert to dark.
      await saveSettings(SettingsSchema.parse({ theme: 'auto' }));
      _clearSettingsCacheForTests();
      mm = installMatchMedia(false); // OS = light
      const { stop, setSetting } = watchTheme(document);
      await flush();
      expect(document.documentElement.getAttribute(THEME_ATTR)).toBe('light'); // auto → light

      setSetting('light'); // user previews Light (unsaved)
      expect(document.documentElement.getAttribute(THEME_ATTR)).toBe('light');

      mm.setDark(true); // OS flips to dark mid-preview
      // Bug would resolve auto → dark; fixed behaviour keeps the previewed light.
      expect(document.documentElement.getAttribute(THEME_ATTR)).toBe('light');
      stop();
    });
  });
});

const EXT_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');

// Every surface that renders on its own chrome-extension:// page must RESOLVE
// the stored theme, not merely ship the token sheet. The sheet's
// `prefers-color-scheme` block is only a pre-JS fallback; without watchTheme
// nothing writes `data-sfdt-theme`, so an explicit Light/Dark choice is ignored
// and the surface silently follows the OS instead. The popup shipped that way —
// it injected tokens and never resolved them.
describe('own-page surfaces resolve the stored theme', () => {
  const SURFACES = [
    'entrypoints/app/main.ts',
    'entrypoints/sidepanel/main.ts',
    'entrypoints/options/main.ts',
    'entrypoints/popup/main.ts',
  ];

  it.each(SURFACES)('%s injects tokens AND calls watchTheme', (surface) => {
    const source = fs.readFileSync(path.join(EXT_ROOT, surface), 'utf8');
    expect(source, `${surface} must inject the token sheet`).toContain('SFDT_TOKENS_CSS');
    expect(source, `${surface} must resolve the stored theme`).toMatch(/watchTheme\s*\(/);
    // color-scheme drives native control rendering (scrollbars, form widgets);
    // without it a dark surface still paints light scrollbars.
    expect(source, `${surface} must set color-scheme`).toContain('OWN_PAGE_COLOR_SCHEME_CSS');
  });

  it('the guard would catch a surface that only injects tokens', () => {
    // A file-scan assertion that silently matched nothing would stay green
    // forever — this is the shape the popup actually had.
    const broken = "styleTag.textContent = `${SFDT_TOKENS_CSS}`;";
    expect(broken).toContain('SFDT_TOKENS_CSS');
    expect(broken).not.toMatch(/watchTheme\s*\(/);
  });
});
