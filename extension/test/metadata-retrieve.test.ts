import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createMetadataRetrieveFeature,
  _metadataRetrieveTestApi,
} from '../features/metadata-retrieve.js';
import type { SalesforceApiClient } from '../lib/salesforce-api.js';

const { asArray } = _metadataRetrieveTestApi();

function fakeApi(overrides: Partial<SalesforceApiClient> = {}): SalesforceApiClient {
  return {
    apiSoap: vi.fn(async (wsdl: string, method: string, _args: any) => {
      if (method === 'describeMetadata') {
        return {
          metadataObjects: [
            { xmlName: 'ApexClass', directoryName: 'classes', inFolder: false },
            { xmlName: 'CustomObject', directoryName: 'objects', inFolder: false },
          ],
        };
      }
      if (method === 'listMetadata') {
        return [
          { fullName: 'MyTestClass', type: 'ApexClass', id: '1' },
        ];
      }
      if (method === 'retrieve') {
        return { id: 'retrieveJob123' };
      }
      if (method === 'checkRetrieveStatus') {
        return { done: true, success: true, zipFile: 'UEsDBAoAAAAAACGP1V...' };
      }
      if (method === 'deploy') {
        return { id: 'deployJob123' };
      }
      if (method === 'checkDeployStatus') {
        return { done: true, success: true, details: {} };
      }
      return {};
    }),
    ...overrides,
  } as unknown as SalesforceApiClient;
}

function clearBody(): void {
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
}

beforeEach(() => {
  clearBody();
});

describe('metadata-retrieve — asArray', () => {
  it('handles null / undefined / values / arrays', () => {
    expect(asArray(null)).toEqual([]);
    expect(asArray(undefined)).toEqual([]);
    expect(asArray('foo')).toEqual(['foo']);
    expect(asArray(['foo', 'bar'])).toEqual(['foo', 'bar']);
  });
});

describe('metadata-retrieve — feature manifest', () => {
  it('exposes the expected id, name and contexts', () => {
    const feature = createMetadataRetrieveFeature({ api: fakeApi() });
    expect(feature.manifest.id).toBe('metadata-retrieve');
    expect(feature.manifest.name).toBe('Metadata Retrieve & Deploy');
    expect(feature.manifest.contexts).toEqual([
      'setup_flows',
      'setup_other',
      'flow_builder',
      'flow_trigger_explorer',
      'record_page',
    ]);
  });
});

describe('metadata-retrieve — UI & Operations', () => {
  function setSalesforceUrl(): void {
    window.history.replaceState({}, '', 'https://x.lightning.force.com/lightning/r/Account/001000000000000AAA/view');
  }

  it('loads metadata describe and renders tree', async () => {
    setSalesforceUrl();
    const api = fakeApi();
    const feature = createMetadataRetrieveFeature({ api });
    await feature.onActivate?.();

    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // Verify describe was called
    expect(api.apiSoap).toHaveBeenCalledWith('Metadata', 'describeMetadata', { apiVersion: '62.0' });

    // Renders the metadata types in the tree
    expect(document.body.textContent).toContain('ApexClass');
    expect(document.body.textContent).toContain('CustomObject');
  });

  it('filters tree items', async () => {
    setSalesforceUrl();
    const api = fakeApi();
    const feature = createMetadataRetrieveFeature({ api });
    await feature.onActivate?.();

    await new Promise((r) => setTimeout(r, 0));

    const filterInput = document.querySelector('input[placeholder*="Filter"]') as HTMLInputElement;
    expect(filterInput).not.toBeNull();

    filterInput.value = 'Apex';
    filterInput.dispatchEvent(new Event('input'));

    expect(document.body.textContent).toContain('ApexClass');
    expect(document.body.textContent).not.toContain('CustomObject');
  });

  it('selects items and updates package.xml', async () => {
    setSalesforceUrl();
    const api = fakeApi();
    const feature = createMetadataRetrieveFeature({ api });
    await feature.onActivate?.();

    await new Promise((r) => setTimeout(r, 0));

    const chk = document.querySelector('.sfut-tree-chk') as HTMLInputElement;
    expect(chk).not.toBeNull();
    chk.click();

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea.value).toContain('<members>*</members>');
    expect(textarea.value).toContain('<name>ApexClass</name>');
  });

  it('runs retrieve and polls job status', async () => {
    setSalesforceUrl();
    // Custom mock to verify polling works
    let checkCount = 0;
    const api = fakeApi({
      apiSoap: vi.fn(async (wsdl: string, method: string, _args: any) => {
        if (method === 'describeMetadata') {
          return { metadataObjects: [{ xmlName: 'ApexClass' }] };
        }
        if (method === 'retrieve') {
          return { id: 'ret123' };
        }
        if (method === 'checkRetrieveStatus') {
          checkCount++;
          if (checkCount === 1) {
            return { done: false, success: false };
          }
          return { done: true, success: true, zipFile: 'UEsDBAoAAAAAA' };
        }
        return {};
      }) as unknown as SalesforceApiClient['apiSoap'],
    });

    const feature = createMetadataRetrieveFeature({ api });
    await feature.onActivate?.();
    await new Promise((r) => setTimeout(r, 0));

    const retrieveBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Retrieve Zip',
    );
    expect(retrieveBtn).not.toBeNull();
    retrieveBtn?.click();

    // Fast-forward standard polling timeouts
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 2050));
    await new Promise((r) => setTimeout(r, 2050));

    expect(api.apiSoap).toHaveBeenCalledWith('Metadata', 'retrieve', expect.any(Object));
    expect(api.apiSoap).toHaveBeenLastCalledWith('Metadata', 'checkRetrieveStatus', { id: 'ret123' });
    expect(checkCount).toBe(2);
  });
});
