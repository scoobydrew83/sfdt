import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createSavedSoqlFeature } from '../features/saved-soql.js';
import { setWorkspaceViewSink } from '../ui/present-view.js';

const flush = () => new Promise((r) => setTimeout(r, 0));

function setStorage(obj: Record<string, unknown>): Promise<void> {
  return new Promise((r) => chrome.storage.local.set(obj, () => r()));
}

beforeEach(async () => {
  document.body.innerHTML = '';
  setWorkspaceViewSink(null);
  // Start each test from empty saved/history storage.
  await setStorage({ 'soqlRunner.savedQueries': { entries: [] }, 'soqlRunner.history': { entries: [] } });
  window.history.replaceState({}, '', 'https://x.lightning.force.com/lightning/setup/SetupOneHome/home');
});

describe('saved-soql feature', () => {
  it('renders the panel with bookmark + recent sections and empty states', async () => {
    const feature = createSavedSoqlFeature({});
    await feature.onActivate?.();
    await flush();

    const overlay = document.querySelector('.sfdt-view-overlay');
    expect(overlay).not.toBeNull();
    const text = overlay?.textContent ?? '';
    expect(text).toContain('Saved SOQL');
    expect(text).toContain('Bookmarks');
    expect(text).toContain('No bookmarks yet');
    expect(text).toContain('Recent');
  });

  it('lists bookmarked queries and Load fires the onLoadQuery hook', async () => {
    await setStorage({
      'soqlRunner.savedQueries': {
        entries: [{ name: 'My Accounts', q: 'SELECT Id FROM Account', api: 'rest' }],
      },
    });
    const onLoadQuery = vi.fn();
    const feature = createSavedSoqlFeature({ onLoadQuery });
    await feature.onActivate?.();
    await flush();

    const overlay = document.querySelector('.sfdt-view-overlay') as HTMLElement;
    expect(overlay.textContent).toContain('My Accounts');
    expect(overlay.textContent).toContain('SELECT Id FROM Account');

    const loadBtn = [...overlay.querySelectorAll('button')].find((b) => b.textContent === 'Load');
    expect(loadBtn).toBeTruthy();
    loadBtn!.click();
    await flush();
    expect(onLoadQuery).toHaveBeenCalledOnce();
  });

  it('does not open outside a Salesforce context', async () => {
    // Drive the context guard via the window the feature reads, rather than
    // mutating the document origin (happy-dom blocks cross-origin pushState).
    const feature = createSavedSoqlFeature({
      win: { location: { href: 'https://example.com/' } } as unknown as Window,
    });
    await feature.onActivate?.();
    await flush();
    expect(document.querySelector('.sfdt-view-overlay')).toBeNull();
  });
});
