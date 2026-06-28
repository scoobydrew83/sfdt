import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createSoapExploreFeature,
  readSoapHistory,
  pushSoapHistory,
  clearSoapHistory,
} from '../features/soap-explore.js';
import type { SalesforceApiClient } from '../lib/salesforce-api.js';
import {
  _resetSettingsShapesForTests,
  _clearSettingsCacheForTests,
} from '../lib/settings.js';

function fakeApi(overrides: Partial<SalesforceApiClient> = {}): SalesforceApiClient {
  return {
    apiSoap: vi.fn(async (_wsdl: string, _method: string, _args: any) => ({ success: true })),
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

describe('soap-explore — feature manifest', () => {
  it('exposes the expected id, name and contexts', () => {
    const feature = createSoapExploreFeature({ api: fakeApi() });
    expect(feature.manifest.id).toBe('soap-explore');
    expect(feature.manifest.name).toBe('SOAP API Explorer');
    expect(feature.manifest.contexts).toEqual([
      'setup_flows',
      'setup_other',
      'flow_builder',
      'flow_trigger_explorer',
      'record_page',
    ]);
  });
});

describe('soap-explore — history', () => {
  it('round-trips entries and dedupes', async () => {
    await pushSoapHistory({
      wsdl: 'Partner',
      operation: 'getUserInfo',
      payload: '{}',
      ts: 1,
    });
    await pushSoapHistory({
      wsdl: 'Partner',
      operation: 'getUserInfo',
      payload: '{}',
      ts: 2,
    });
    const back = await readSoapHistory();
    expect(back).toHaveLength(1);
    expect(back[0]?.ts).toBe(2);
  });

  it('clears history on demand', async () => {
    await pushSoapHistory({ wsdl: 'Partner', operation: 'x', payload: '{}', ts: 1 });
    await clearSoapHistory();
    expect(await readSoapHistory()).toEqual([]);
  });
});

describe('soap-explore — UI', () => {
  function setSalesforceUrl(): void {
    window.history.replaceState({}, '', 'https://x.lightning.force.com/lightning/r/Account/001000000000000AAA/view');
  }

  it('populates select options and updates template', async () => {
    setSalesforceUrl();
    const api = fakeApi();
    const feature = createSoapExploreFeature({ api });
    await feature.onActivate?.();

    const wsdlSelect = document.querySelector('select') as HTMLSelectElement;
    expect(wsdlSelect).not.toBeNull();
    expect(wsdlSelect.value).toBe('Partner');

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea.value).toBe('{}'); // default for getUserInfo template

    // Switch WSDL to Metadata
    wsdlSelect.value = 'Metadata';
    wsdlSelect.dispatchEvent(new Event('change'));

    // Should load describeMetadata template
    expect(textarea.value).toContain('apiVersion');
  });

  it('submits requests via apiSoap', async () => {
    setSalesforceUrl();
    const api = fakeApi({
      apiSoap: vi.fn(async () => ({ mockResult: 'hello' })) as unknown as SalesforceApiClient['apiSoap'],
    });
    const feature = createSoapExploreFeature({ api });
    await feature.onActivate?.();

    const sendBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Send',
    );
    expect(sendBtn).not.toBeNull();
    sendBtn?.click();

    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(api.apiSoap).toHaveBeenCalledWith('Partner', 'getUserInfo', {});
    expect(document.body.textContent).toContain('"mockResult": "hello"');
  });

  it('handles custom operations and custom JSON payload', async () => {
    setSalesforceUrl();
    const api = fakeApi();
    const feature = createSoapExploreFeature({ api });
    await feature.onActivate?.();

    const opInput = document.querySelector('input[placeholder*="Operation"]') as HTMLInputElement;
    opInput.value = 'customSoapMethod';

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = '{"foo": "bar"}';

    const sendBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Send',
    );
    sendBtn?.click();

    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(api.apiSoap).toHaveBeenCalledWith('Partner', 'customSoapMethod', { foo: 'bar' });
  });

  it('rejects invalid JSON payload', async () => {
    setSalesforceUrl();
    const api = fakeApi();
    const feature = createSoapExploreFeature({ api });
    await feature.onActivate?.();

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = '{invalid';

    const sendBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Send',
    );
    sendBtn?.click();

    await new Promise((r) => setTimeout(r, 0));
    expect(api.apiSoap).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Payload is not valid JSON');
  });

  it('requires an operation name', async () => {
    setSalesforceUrl();
    const api = fakeApi();
    const feature = createSoapExploreFeature({ api });
    await feature.onActivate?.();

    // Switch operation dropdown to Custom and leave the input blank.
    const opSelect = document.querySelectorAll('select')[1] as HTMLSelectElement;
    opSelect.value = 'custom';
    opSelect.dispatchEvent(new Event('change'));
    const opInput = document.querySelector('input[placeholder*="Operation"]') as HTMLInputElement;
    opInput.value = '';

    const sendBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Send',
    );
    sendBtn?.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(api.apiSoap).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Operation name is required');
  });

  it('surfaces an apiSoap error', async () => {
    setSalesforceUrl();
    const api = fakeApi({
      apiSoap: vi.fn(async () => {
        throw new Error('INVALID_SESSION_ID');
      }) as unknown as SalesforceApiClient['apiSoap'],
    });
    const feature = createSoapExploreFeature({ api });
    await feature.onActivate?.();

    const sendBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Send',
    );
    sendBtn?.click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(document.body.textContent).toContain('INVALID_SESSION_ID');
  });

  it('ignores a second Send while a request is in flight', async () => {
    setSalesforceUrl();
    let resolve!: (v: unknown) => void;
    const pending = new Promise((r) => {
      resolve = r;
    });
    const apiSoap = vi.fn(() => pending);
    const api = fakeApi({ apiSoap: apiSoap as unknown as SalesforceApiClient['apiSoap'] });
    const feature = createSoapExploreFeature({ api });
    await feature.onActivate?.();

    const sendBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Send',
    ) as HTMLButtonElement;
    sendBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    sendBtn.click(); // should be a no-op: isWorking guard
    await new Promise((r) => setTimeout(r, 0));

    expect(apiSoap).toHaveBeenCalledTimes(1);
    resolve({ done: true });
    await new Promise((r) => setTimeout(r, 0));
  });

  it('switches the operation dropdown back to a templated op', async () => {
    setSalesforceUrl();
    const api = fakeApi();
    const feature = createSoapExploreFeature({ api });
    await feature.onActivate?.();

    const wsdlSelect = document.querySelectorAll('select')[0] as HTMLSelectElement;
    wsdlSelect.value = 'Metadata';
    wsdlSelect.dispatchEvent(new Event('change'));

    const opSelect = document.querySelectorAll('select')[1] as HTMLSelectElement;
    opSelect.value = 'listMetadata';
    opSelect.dispatchEvent(new Event('change'));

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea.value).toContain('ApexClass');
    const opInput = document.querySelector('input[placeholder*="Operation"]') as HTMLInputElement;
    expect(opInput.value).toBe('listMetadata');
    expect(opInput.style.display).toBe('none');
  });

  it('closes on backdrop click and Close button (removes doc listener)', async () => {
    setSalesforceUrl();
    const feature = createSoapExploreFeature({ api: fakeApi() });
    await feature.onActivate?.();
    const overlay = document.querySelector('.sfdt-soap-explore-overlay') as HTMLDivElement;
    expect(overlay).not.toBeNull();

    const closeBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === '×',
    ) as HTMLButtonElement;
    closeBtn.click(); // hits close() with docClickHandler set
    expect(document.querySelector('.sfdt-soap-explore-overlay')).toBeNull();
  });

  it('closes when the overlay backdrop is clicked', async () => {
    setSalesforceUrl();
    const feature = createSoapExploreFeature({ api: fakeApi() });
    await feature.onActivate?.();
    const overlay = document.querySelector('.sfdt-soap-explore-overlay') as HTMLDivElement;
    overlay.click();
    expect(document.querySelector('.sfdt-soap-explore-overlay')).toBeNull();
  });
});

describe('soap-explore — clipboard', () => {
  function setSalesforceUrl(): void {
    window.history.replaceState({}, '', 'https://x.lightning.force.com/lightning/r/Account/001000000000000AAA/view');
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  async function runOnce() {
    const api = fakeApi({
      apiSoap: vi.fn(async () => ({ greeting: 'hi' })) as unknown as SalesforceApiClient['apiSoap'],
    });
    const feature = createSoapExploreFeature({ api });
    await feature.onActivate?.();
    const sendBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Send',
    ) as HTMLButtonElement;
    sendBtn.click();
    await flush();
    await flush();
  }

  it('copies the last response', async () => {
    setSalesforceUrl();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true });
    await runOnce();

    const copyBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Copy response',
    ) as HTMLButtonElement;
    expect(copyBtn.style.display).toBe('inline-block');
    copyBtn.click();
    await flush();
    expect(writeText).toHaveBeenCalledWith('{\n  "greeting": "hi"\n}');
    expect(document.body.textContent).toContain('Response copied');
  });

  it('reports a clipboard failure', async () => {
    setSalesforceUrl();
    const writeText = vi.fn(async () => {
      throw new Error('nope');
    });
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true });
    await runOnce();

    const copyBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Copy response',
    ) as HTMLButtonElement;
    copyBtn.click();
    await flush();
    expect(document.body.textContent).toContain('Could not copy response');
  });
});

describe('soap-explore — history menu', () => {
  function setSalesforceUrl(): void {
    window.history.replaceState({}, '', 'https://x.lightning.force.com/lightning/r/Account/001000000000000AAA/view');
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const historyButton = () =>
    Array.from(document.querySelectorAll('button')).find((b) => b.textContent === '▸ History ▾') as HTMLButtonElement;

  it('renders the empty state', async () => {
    setSalesforceUrl();
    const feature = createSoapExploreFeature({ api: fakeApi() });
    await feature.onActivate?.();
    historyButton().click();
    await flush();
    expect(document.body.textContent).toContain('No requests yet.');
  });

  it('renders entries and applies one on click', async () => {
    setSalesforceUrl();
    await pushSoapHistory({ wsdl: 'Tooling', operation: 'query', payload: '{"queryString":"SELECT Id FROM ApexClass"}', ts: 1 });
    const feature = createSoapExploreFeature({ api: fakeApi() });
    await feature.onActivate?.();
    historyButton().click();
    await flush();

    const badge = Array.from(document.querySelectorAll('span')).find((s) => s.textContent === 'Tooling');
    const item = badge?.parentElement as HTMLDivElement;
    expect(item).toBeTruthy();
    item.click();

    const wsdlSelect = document.querySelectorAll('select')[0] as HTMLSelectElement;
    const opInput = document.querySelector('input[placeholder*="Operation"]') as HTMLInputElement;
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    expect(wsdlSelect.value).toBe('Tooling');
    expect(opInput.value).toBe('query');
    expect(textarea.value).toBe('{"queryString":"SELECT Id FROM ApexClass"}');
  });

  it('clears history through the Clear history button', async () => {
    setSalesforceUrl();
    await pushSoapHistory({ wsdl: 'Partner', operation: 'getUserInfo', payload: '{}', ts: 1 });
    const feature = createSoapExploreFeature({ api: fakeApi() });
    await feature.onActivate?.();
    const clearBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Clear history',
    ) as HTMLButtonElement;
    clearBtn.click();
    await flush();
    expect(await readSoapHistory()).toEqual([]);
    expect(document.body.textContent).toContain('History cleared');
  });
});
