import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createSavedSoqlFeature } from '../features/saved-soql.js';
import { SOQL_TEMPLATES, isValidTemplateSoql } from '../features/soql-templates.js';
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

  it('renders the built-in Templates group with all templates and no delete affordance', async () => {
    const feature = createSavedSoqlFeature({});
    await feature.onActivate?.();
    await flush();

    const overlay = document.querySelector('.sfdt-view-overlay') as HTMLElement;
    expect(overlay.textContent).toContain('Templates');
    expect(overlay.textContent).toContain('Built-in');
    for (const tpl of SOQL_TEMPLATES) {
      expect(overlay.textContent).toContain(tpl.name);
    }

    // Built-ins live in their own labelled list...
    const tplList = overlay.querySelector('[aria-label="Built-in SOQL templates"]') as HTMLElement;
    expect(tplList).toBeTruthy();
    // ...each with a Load button (keyboard-reachable native <button>)...
    const loadBtns = [...tplList.querySelectorAll('button')].filter((b) => b.textContent === 'Load');
    expect(loadBtns.length).toBe(SOQL_TEMPLATES.length);
    // ...and NO delete affordance (built-ins cannot be deleted).
    const deleteBtns = [...tplList.querySelectorAll('button')].filter((b) => b.textContent === '🗑');
    expect(deleteBtns.length).toBe(0);
  });

  it('loads a template into the runner via the onLoadQuery hook', async () => {
    const onLoadQuery = vi.fn();
    const feature = createSavedSoqlFeature({ onLoadQuery });
    await feature.onActivate?.();
    await flush();

    const tplList = document.querySelector('[aria-label="Built-in SOQL templates"]') as HTMLElement;
    const firstLoad = [...tplList.querySelectorAll('button')].find((b) => b.textContent === 'Load');
    firstLoad!.click();
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

describe('SOQL template pack (data)', () => {
  it('ships at least 8 templates with unique names and a valid api mode', () => {
    expect(SOQL_TEMPLATES.length).toBeGreaterThanOrEqual(8);
    const names = SOQL_TEMPLATES.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tpl of SOQL_TEMPLATES) {
      expect(tpl.name.trim().length).toBeGreaterThan(0);
      expect(tpl.description.trim().length).toBeGreaterThan(0);
      expect(['rest', 'tooling']).toContain(tpl.api);
    }
  });

  // AC2: every template parses via the extension's SOQL validation.
  it('every template is structurally valid SOQL', () => {
    for (const tpl of SOQL_TEMPLATES) {
      expect(isValidTemplateSoql(tpl.q), `${tpl.name}: ${tpl.q}`).toBe(true);
    }
  });

  it('rejects malformed SOQL (validator sanity)', () => {
    expect(isValidTemplateSoql('SELECT Id FROM Account')).toBe(true);
    expect(isValidTemplateSoql('DELETE FROM Account')).toBe(false);
    expect(isValidTemplateSoql('SELECT Id Account')).toBe(false); // no FROM
    expect(isValidTemplateSoql("SELECT Id FROM Account WHERE Name = 'x")).toBe(false); // unbalanced quote
    expect(isValidTemplateSoql('SELECT Id FROM Account;')).toBe(false); // trailing semicolon
  });
});

describe('saved-soql feature — query language (P4-3)', () => {
  function getStorage(key: string): Promise<unknown> {
    return new Promise((r) => chrome.storage.local.get(key, (res) => r(res?.[key])));
  }

  it('badges each row with its query language and stages it for the runner', async () => {
    await setStorage({
      'soqlRunner.savedQueries': {
        entries: [{ name: 'Find Acme', q: 'FIND {Acme} IN ALL FIELDS', api: 'rest', lang: 'sosl' }],
      },
    });
    const feature = createSavedSoqlFeature({ onLoadQuery: vi.fn() });
    await feature.onActivate?.();
    await flush();

    const overlay = document.querySelector('.sfdt-view-overlay') as HTMLElement;
    const badges = [...overlay.querySelectorAll('span')].filter((s) => s.textContent === 'SOSL');
    expect(badges.length).toBe(1);

    const loadBtn = [...overlay.querySelectorAll('button')].find((b) => b.textContent === 'Load');
    loadBtn!.click();
    await flush();
    expect(await getStorage('soqlRunner.pendingQuery')).toEqual({
      q: 'FIND {Acme} IN ALL FIELDS',
      api: 'rest',
      lang: 'sosl',
    });
  });

  it('infers the language for entries stored before the toggle shipped', async () => {
    await setStorage({
      'soqlRunner.history': {
        // No `lang` key — written by an older version.
        entries: [{ q: 'FIND {Legacy}', api: 'rest', ts: 1 }],
      },
    });
    const feature = createSavedSoqlFeature({ onLoadQuery: vi.fn() });
    await feature.onActivate?.();
    await flush();

    const overlay = document.querySelector('.sfdt-view-overlay') as HTMLElement;
    const row = [...overlay.querySelectorAll('span')].find((s) => s.textContent === 'FIND {Legacy}')
      ?.parentElement as HTMLElement;
    expect([...row.querySelectorAll('span')].some((s) => s.textContent === 'SOSL')).toBe(true);
    (row.querySelector('button') as HTMLButtonElement).click();
    await flush();
    expect(await getStorage('soqlRunner.pendingQuery')).toMatchObject({ lang: 'sosl' });
  });
});
