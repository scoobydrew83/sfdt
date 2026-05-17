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

  it('handles null / undefined as empty', () => {
    expect(prettyJson(null)).toBe('');
    expect(prettyJson(undefined)).toBe('');
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
