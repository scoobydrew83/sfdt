import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture what createPaletteOpener hands the overlay, and stub the overlay so the
// real describe/network path (loadObjects) never runs in this unit test.
const h = vi.hoisted(() => ({ captured: null as any }));
vi.mock('../ui/command-palette.js', () => ({
  openCommandPalette: (opts: any) => {
    h.captured = opts;
    return { close: () => {}, isOpen: () => true };
  },
}));

import { createPaletteOpener } from '../features/command-palette.js';
import {
  _clearSettingsCacheForTests,
  saveSettings,
  SettingsSchema,
} from '../lib/settings.js';

function makeWin() {
  return {
    open: vi.fn(),
    location: { href: 'https://x.lightning.force.com/lightning/page/home', assign: vi.fn() },
  } as any;
}

function opener(win: any) {
  return createPaletteOpener({
    getGate: () => ({
      available: [],
      isRegistered: () => true,
      disabledRemote: new Set<string>(),
      isEnabled: () => true,
    }),
    getHostname: () => 'x.lightning.force.com',
    activateFeature: vi.fn(),
    inspectRecord: vi.fn(),
    win,
  });
}

describe('createPaletteOpener — custom shortcuts (P2-2 PR-3)', () => {
  beforeEach(() => {
    h.captured = null;
    _clearSettingsCacheForTests();
    chrome.storage.local.clear();
  });

  it('maps stored {name,url} shortcuts into sourceInputs.customShortcuts (new-tab)', async () => {
    await saveSettings(
      SettingsSchema.parse({ customShortcuts: [{ name: 'Docs', url: 'https://sfdt.dev/' }] }),
    );
    _clearSettingsCacheForTests();
    await opener(makeWin()).open();
    expect(h.captured.sourceInputs.customShortcuts).toEqual([
      { id: 'Docs', label: 'Docs', url: 'https://sfdt.dev/', openInNewTab: true },
    ]);
  });

  it('opens a shortcut via window.open (never navigates the SF tab away)', async () => {
    await saveSettings(
      SettingsSchema.parse({ customShortcuts: [{ name: 'Docs', url: 'https://sfdt.dev/' }] }),
    );
    _clearSettingsCacheForTests();
    const win = makeWin();
    await opener(win).open();
    const sc = h.captured.sourceInputs.customShortcuts[0];
    // The overlay dispatches a url action through executors.navigate — drive it.
    h.captured.executors.navigate(sc.url, sc.openInNewTab);
    expect(win.open).toHaveBeenCalledWith('https://sfdt.dev/', '_blank', 'noopener');
    expect(win.location.assign).not.toHaveBeenCalled();
  });
});
