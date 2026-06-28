import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createRestExploreFeature,
  _restExploreTestApi,
  readRestHistory,
  pushRestHistory,
  clearRestHistory,
} from '../features/rest-explore.js';
import {
  _resetSettingsShapesForTests,
  _clearSettingsCacheForTests,
} from '../lib/settings.js';
import type { SalesforceApiClient } from '../lib/salesforce-api.js';

const { prettyJson, HISTORY_CAP } = _restExploreTestApi();

function fakeApi(overrides: Partial<SalesforceApiClient> = {}): SalesforceApiClient {
  return {
    rawRequest: vi.fn(async (_method: string, _endpoint: string) => ({ ok: true })),
    ...overrides,
  } as unknown as SalesforceApiClient;
}

function clearBody(): void {
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
}

beforeEach(() => {
  _resetSettingsShapesForTests();
  _clearSettingsCacheForTests();
  clearBody();
});

describe('rest-explore — prettyJson', () => {
  it('returns indented JSON for objects', () => {
    expect(prettyJson({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it('formats arrays', () => {
    expect(prettyJson([1, 2])).toBe('[\n  1,\n  2\n]');
  });

  it('handles null / undefined as empty', () => {
    expect(prettyJson(null)).toBe('');
    expect(prettyJson(undefined)).toBe('');
  });

  it('falls back to String() when JSON.stringify throws (circular)', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(prettyJson(circular)).toBe('[object Object]');
  });
});

describe('rest-explore — history', () => {
  it('round-trips entries and dedupes by (method, path, body)', async () => {
    await pushRestHistory({
      method: 'GET',
      path: '/services/data/v62.0/sobjects/Account/describe',
      ts: 1,
    });
    await pushRestHistory({
      method: 'GET',
      path: '/services/data/v62.0/sobjects/Account/describe',
      ts: 2,
    });
    const back = await readRestHistory();
    expect(back).toHaveLength(1);
    expect(back[0]?.ts).toBe(2);
  });

  it('treats different methods at the same path as distinct entries', async () => {
    await pushRestHistory({ method: 'GET', path: '/x', ts: 1 });
    await pushRestHistory({ method: 'DELETE', path: '/x', ts: 2 });
    const back = await readRestHistory();
    expect(back).toHaveLength(2);
  });

  it('caps history at HISTORY_CAP entries', async () => {
    for (let i = 0; i < HISTORY_CAP + 3; i += 1) {
      await pushRestHistory({ method: 'GET', path: `/x${i}`, ts: i });
    }
    const back = await readRestHistory();
    expect(back).toHaveLength(HISTORY_CAP);
  });

  it('clears history on demand', async () => {
    await pushRestHistory({ method: 'GET', path: '/x', ts: 1 });
    await clearRestHistory();
    expect(await readRestHistory()).toEqual([]);
  });
});

describe('rest-explore — modal', () => {
  function setSalesforceUrl(): void {
    window.history.replaceState({}, '', 'https://x.lightning.force.com/lightning/setup/SetupOneHome/home');
  }

  it('issues a GET against the entered path', async () => {
    setSalesforceUrl();
    const api = fakeApi({
      rawRequest: vi.fn(async () => ({ name: 'Account', fields: [] })) as unknown as SalesforceApiClient['rawRequest'],
    });
    const feature = createRestExploreFeature({ api, skipDestructiveConfirm: true });
    await feature.onActivate?.();

    const path = document.querySelector('input[type="text"]') as HTMLInputElement;
    path.value = '/services/data/v62.0/sobjects/Account/describe';
    const sendBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Send',
    );
    sendBtn?.click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(api.rawRequest).toHaveBeenCalledWith(
      'GET',
      '/services/data/v62.0/sobjects/Account/describe',
      undefined,
    );
    expect(document.body.textContent).toContain('"name": "Account"');
  });

  it('parses the body as JSON for POST and passes it to rawRequest', async () => {
    setSalesforceUrl();
    const api = fakeApi({
      rawRequest: vi.fn(async () => ({ id: '001abc', success: true })) as unknown as SalesforceApiClient['rawRequest'],
    });
    const feature = createRestExploreFeature({ api, skipDestructiveConfirm: true });
    await feature.onActivate?.();

    const select = document.querySelector('select') as HTMLSelectElement;
    select.value = 'POST';
    select.dispatchEvent(new Event('change'));

    const path = document.querySelector('input[type="text"]') as HTMLInputElement;
    path.value = '/services/data/v62.0/sobjects/Account';
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = '{"Name":"Acme"}';
    const sendBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Send',
    );
    sendBtn?.click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(api.rawRequest).toHaveBeenCalledWith(
      'POST',
      '/services/data/v62.0/sobjects/Account',
      { Name: 'Acme' },
    );
  });

  it('rejects an endpoint that does not start with /', async () => {
    setSalesforceUrl();
    const api = fakeApi();
    const feature = createRestExploreFeature({ api, skipDestructiveConfirm: true });
    await feature.onActivate?.();

    const path = document.querySelector('input[type="text"]') as HTMLInputElement;
    path.value = 'services/data/v62.0/sobjects';
    const sendBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Send',
    );
    sendBtn?.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(api.rawRequest).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('must start with');
  });

  it('shows an error panel when rawRequest throws', async () => {
    setSalesforceUrl();
    const api = fakeApi({
      rawRequest: vi.fn(async () => {
        throw new Error('500 INTERNAL_ERROR');
      }) as unknown as SalesforceApiClient['rawRequest'],
    });
    const feature = createRestExploreFeature({ api, skipDestructiveConfirm: true });
    await feature.onActivate?.();
    const path = document.querySelector('input[type="text"]') as HTMLInputElement;
    path.value = '/services/data/v62.0/limits/';
    const sendBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Send',
    );
    sendBtn?.click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(document.body.textContent).toContain('500 INTERNAL_ERROR');
  });

  it('surfaces invalid JSON in the body as a clear error', async () => {
    setSalesforceUrl();
    const api = fakeApi();
    const feature = createRestExploreFeature({ api, skipDestructiveConfirm: true });
    await feature.onActivate?.();

    const select = document.querySelector('select') as HTMLSelectElement;
    select.value = 'POST';
    select.dispatchEvent(new Event('change'));
    const path = document.querySelector('input[type="text"]') as HTMLInputElement;
    path.value = '/services/data/v62.0/sobjects/Account';
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = '{not valid';
    const sendBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Send',
    );
    sendBtn?.click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(api.rawRequest).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Body is not valid JSON');
  });
});

describe('rest-explore — onActivate guard', () => {
  it('shows a warning and opens no overlay off a Salesforce page', async () => {
    const api = fakeApi();
    const win = { location: { href: 'https://example.com/not-salesforce' } } as unknown as Window;
    const feature = createRestExploreFeature({ api, win });
    await feature.onActivate?.();
    await new Promise((r) => setTimeout(r, 0));

    expect(document.querySelector('.sfdt-rest-explore-overlay')).toBeNull();
    expect(document.body.textContent).toContain('Open a Salesforce page');
  });
});

describe('rest-explore — modal interactions', () => {
  function setSalesforceUrl(): void {
    window.history.replaceState({}, '', 'https://x.lightning.force.com/lightning/setup/SetupOneHome/home');
  }
  function sendButton(): HTMLButtonElement {
    return Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Send',
    ) as HTMLButtonElement;
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('requires a second Send click to confirm a DELETE', async () => {
    setSalesforceUrl();
    const api = fakeApi({
      rawRequest: vi.fn(async () => ({ deleted: true })) as unknown as SalesforceApiClient['rawRequest'],
    });
    const feature = createRestExploreFeature({ api }); // destructive confirm enabled
    await feature.onActivate?.();

    const select = document.querySelector('select') as HTMLSelectElement;
    select.value = 'DELETE';
    select.dispatchEvent(new Event('change'));
    const path = document.querySelector('input[type="text"]') as HTMLInputElement;
    path.value = '/services/data/v62.0/sobjects/Account/001';

    sendButton().click();
    await flush();
    expect(api.rawRequest).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Click Send again to confirm DELETE');

    sendButton().click();
    await flush();
    await flush();
    expect(api.rawRequest).toHaveBeenCalledWith('DELETE', '/services/data/v62.0/sobjects/Account/001', undefined);
  });

  it('sends on Ctrl+Enter in the path input', async () => {
    setSalesforceUrl();
    const api = fakeApi({
      rawRequest: vi.fn(async () => ({ ok: 1 })) as unknown as SalesforceApiClient['rawRequest'],
    });
    const feature = createRestExploreFeature({ api, skipDestructiveConfirm: true });
    await feature.onActivate?.();

    const path = document.querySelector('input[type="text"]') as HTMLInputElement;
    path.value = '/services/data/v62.0/limits/';
    path.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    await flush();
    await flush();
    expect(api.rawRequest).toHaveBeenCalledWith('GET', '/services/data/v62.0/limits/', undefined);
  });

  it('sends on Ctrl+Enter in the body textarea (POST)', async () => {
    setSalesforceUrl();
    const api = fakeApi({
      rawRequest: vi.fn(async () => ({ id: 'x' })) as unknown as SalesforceApiClient['rawRequest'],
    });
    const feature = createRestExploreFeature({ api, skipDestructiveConfirm: true });
    await feature.onActivate?.();

    const select = document.querySelector('select') as HTMLSelectElement;
    select.value = 'POST';
    select.dispatchEvent(new Event('change'));
    const path = document.querySelector('input[type="text"]') as HTMLInputElement;
    path.value = '/services/data/v62.0/sobjects/Account';
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = '{"Name":"Acme"}';
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
    await flush();
    await flush();
    expect(api.rawRequest).toHaveBeenCalledWith('POST', '/services/data/v62.0/sobjects/Account', { Name: 'Acme' });
  });

  it('closes when the overlay backdrop is clicked', async () => {
    setSalesforceUrl();
    const feature = createRestExploreFeature({ api: fakeApi(), skipDestructiveConfirm: true });
    await feature.onActivate?.();
    const overlay = document.querySelector('.sfdt-rest-explore-overlay') as HTMLDivElement;
    expect(overlay).not.toBeNull();
    overlay.click(); // e.target === overlay
    expect(document.querySelector('.sfdt-rest-explore-overlay')).toBeNull();
  });

  it('copies the last response to the clipboard', async () => {
    setSalesforceUrl();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true });
    const api = fakeApi({
      rawRequest: vi.fn(async () => ({ name: 'Account' })) as unknown as SalesforceApiClient['rawRequest'],
    });
    const feature = createRestExploreFeature({ api, skipDestructiveConfirm: true });
    await feature.onActivate?.();
    const path = document.querySelector('input[type="text"]') as HTMLInputElement;
    path.value = '/services/data/v62.0/sobjects/Account/describe';
    sendButton().click();
    await flush();
    await flush();

    const copyBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Copy response',
    ) as HTMLButtonElement;
    expect(copyBtn.style.display).toBe('inline-block');
    copyBtn.click();
    await flush();
    expect(writeText).toHaveBeenCalledWith('{\n  "name": "Account"\n}');
    expect(document.body.textContent).toContain('Response copied');
  });

  it('reports a clipboard failure via toast', async () => {
    setSalesforceUrl();
    const writeText = vi.fn(async () => {
      throw new Error('denied');
    });
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true });
    const api = fakeApi({
      rawRequest: vi.fn(async () => ({ ok: true })) as unknown as SalesforceApiClient['rawRequest'],
    });
    const feature = createRestExploreFeature({ api, skipDestructiveConfirm: true });
    await feature.onActivate?.();
    const path = document.querySelector('input[type="text"]') as HTMLInputElement;
    path.value = '/services/data/v62.0/limits/';
    sendButton().click();
    await flush();
    await flush();

    const copyBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Copy response',
    ) as HTMLButtonElement;
    copyBtn.click();
    await flush();
    expect(document.body.textContent).toContain('Could not copy to clipboard');
  });
});

describe('rest-explore — history menu', () => {
  function setSalesforceUrl(): void {
    window.history.replaceState({}, '', 'https://x.lightning.force.com/lightning/setup/SetupOneHome/home');
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const historyButton = () =>
    Array.from(document.querySelectorAll('button')).find((b) => b.textContent === '▸ History ▾') as HTMLButtonElement;

  it('renders the empty state when there is no history', async () => {
    setSalesforceUrl();
    const feature = createRestExploreFeature({ api: fakeApi(), skipDestructiveConfirm: true });
    await feature.onActivate?.();
    historyButton().click();
    await flush();
    expect(document.body.textContent).toContain('No requests yet.');
  });

  it('renders saved entries and applies one on click', async () => {
    setSalesforceUrl();
    await pushRestHistory({ method: 'POST', path: '/services/data/v62.0/sobjects/Account', body: '{"Name":"X"}', ts: 1 });
    const feature = createRestExploreFeature({ api: fakeApi(), skipDestructiveConfirm: true });
    await feature.onActivate?.();
    historyButton().click();
    await flush();

    const badge = Array.from(document.querySelectorAll('span')).find((s) => s.textContent === 'POST');
    const item = badge?.parentElement as HTMLDivElement;
    expect(item).toBeTruthy();
    item.click();

    const select = document.querySelector('select') as HTMLSelectElement;
    const path = document.querySelector('input[type="text"]') as HTMLInputElement;
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    expect(select.value).toBe('POST');
    expect(path.value).toBe('/services/data/v62.0/sobjects/Account');
    expect(textarea.value).toBe('{"Name":"X"}');
  });

  it('clears history through the Clear history button', async () => {
    setSalesforceUrl();
    await pushRestHistory({ method: 'GET', path: '/x', ts: 1 });
    const feature = createRestExploreFeature({ api: fakeApi(), skipDestructiveConfirm: true });
    await feature.onActivate?.();
    const clearBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Clear history',
    ) as HTMLButtonElement;
    clearBtn.click();
    await flush();
    expect(await readRestHistory()).toEqual([]);
    expect(document.body.textContent).toContain('History cleared');
  });
});

describe('rest-explore — feature manifest', () => {
  it('exposes the expected id, name and contexts', () => {
    const feature = createRestExploreFeature({ api: fakeApi() });
    expect(feature.manifest.id).toBe('rest-explore');
    expect(feature.manifest.name).toBe('REST API Explorer');
    expect(feature.manifest.contexts).toEqual([
      'setup_flows',
      'setup_other',
      'flow_builder',
      'flow_trigger_explorer',
    ]);
  });
});
