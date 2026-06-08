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
});
