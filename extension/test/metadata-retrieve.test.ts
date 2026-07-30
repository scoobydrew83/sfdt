import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createMetadataRetrieveFeature,
  _metadataRetrieveTestApi,
} from '../features/metadata-retrieve.js';
import type { SalesforceApiClient } from '../lib/salesforce-api.js';

const { asArray } = _metadataRetrieveTestApi();

function fakeApi(overrides: Partial<SalesforceApiClient> = {}): SalesforceApiClient {
  return {
    // The real client always exposes apiVersion (sourced from SF_API_VERSION);
    // the feature reads it synchronously to build the SOAP version string.
    apiVersion: 'v62.0',
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

    const chk = document.querySelector('.sfdt-tree-chk') as HTMLInputElement;
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

// ---------------------------------------------------------------------------
// Logic-focused additions. The runners (loadMetadataDescribe, toggleExpand,
// generatePackageXml, runRetrieve, runDeploy, loadFromPackageXml) aren't
// exported, so they're driven through the same DOM the production UI builds.
// ---------------------------------------------------------------------------

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function setSalesforceUrl(): void {
  window.history.replaceState({}, '', 'https://x.lightning.force.com/lightning/r/Account/001000000000000AAA/view');
}

function btnExact(text: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find((b) => b.textContent === text) as
    | HTMLButtonElement
    | undefined;
}

/** Click the expand triangle for a top-level metadata type by its label text. */
function expandType(name: string): void {
  const labelSpan = Array.from(document.querySelectorAll('span')).find(
    (s) => s.textContent === name && s.parentElement?.querySelector('input[type="checkbox"]'),
  );
  const expBtn = labelSpan!.parentElement!.querySelector('button') as HTMLButtonElement;
  expBtn.click();
}

describe('metadata-retrieve — tree expansion & package.xml', () => {
  it('maps Report to ReportFolder, filters managed members, and keeps the whole-type wildcard sticky', async () => {
    setSalesforceUrl();
    const api = fakeApi({
      apiSoap: vi.fn(async (_w: string, method: string) => {
        if (method === 'describeMetadata') {
          return {
            metadataObjects: [
              { xmlName: 'Report', directoryName: 'reports', inFolder: 'true' },
              { xmlName: 'ApexClass', directoryName: 'classes', inFolder: false },
            ],
          };
        }
        if (method === 'listMetadata') {
          return [
            { fullName: 'MyReport', fileName: 'reports/MyReport.report', type: 'Report', id: 'r1' },
            { fullName: 'Pkg__Report', fileName: 'x', type: 'Report', id: 'r2', namespacePrefix: 'Pkg' },
          ];
        }
        return {};
      }) as unknown as SalesforceApiClient['apiSoap'],
    });
    const feature = createMetadataRetrieveFeature({ api });
    await feature.onActivate?.();
    await flush();

    expandType('Report');
    await flush();
    await flush();

    // Report (not a folder itself) is queried as the ReportFolder pseudo-type
    expect(api.apiSoap).toHaveBeenCalledWith(
      'Metadata',
      'listMetadata',
      expect.objectContaining({ queries: expect.objectContaining({ type: 'ReportFolder' }) }),
    );

    // Managed (namespaced) member excluded; unmanaged member rendered
    expect(document.body.textContent).toContain('MyReport');
    expect(document.body.textContent).not.toContain('Pkg__Report');

    // Selecting the parent cascades to children in the tree, but the manifest
    // keeps the sticky whole-type wildcard (expanding never narrows it).
    const reportChk = Array.from(document.querySelectorAll('span'))
      .find((s) => s.textContent === 'Report')!
      .parentElement!.querySelector('input[type="checkbox"]') as HTMLInputElement;
    reportChk.checked = true;
    reportChk.dispatchEvent(new Event('change'));

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea.value).toContain('<name>Report</name>');
    expect(textarea.value).toContain('<members>*</members>');

    // Unticking one member narrows the wildcard to the remaining explicit list.
    const memberChk = Array.from(document.querySelectorAll('span'))
      .find((s) => s.textContent === 'MyReport')!
      .parentElement!.querySelector('input[type="checkbox"]') as HTMLInputElement;
    memberChk.checked = false;
    memberChk.dispatchEvent(new Event('change'));
    expect(textarea.value).not.toContain('<members>*</members>');
    expect(textarea.value).not.toContain('<name>Report</name>');
  });

  it('maps Dashboard/EmailTemplate to *Folder proofs, includes folder children, and sorts members', async () => {
    setSalesforceUrl();
    const api = fakeApi({
      apiSoap: vi.fn(async (_w: string, method: string) => {
        if (method === 'describeMetadata') {
          return {
            metadataObjects: [
              { xmlName: 'Dashboard', directoryName: 'dashboards', inFolder: 'true' },
              { xmlName: 'EmailTemplate', directoryName: 'email', inFolder: 'true' },
            ],
          };
        }
        if (method === 'listMetadata') {
          // Out of order + a folder-typed child to exercise the sort + isFolder paths
          return [
            { fullName: 'B_Item', fileName: 'b', type: 'Dashboard', id: '1' },
            { fullName: 'A_Folder', fileName: 'a', type: 'DashboardFolder', id: '2' },
          ];
        }
        return {};
      }) as unknown as SalesforceApiClient['apiSoap'],
    });
    const feature = createMetadataRetrieveFeature({ api });
    await feature.onActivate?.();
    await flush();

    expandType('Dashboard');
    await flush();
    await flush();
    expect(api.apiSoap).toHaveBeenCalledWith(
      'Metadata',
      'listMetadata',
      expect.objectContaining({ queries: expect.objectContaining({ type: 'DashboardFolder' }) }),
    );

    expandType('EmailTemplate');
    await flush();
    await flush();
    expect(api.apiSoap).toHaveBeenCalledWith(
      'Metadata',
      'listMetadata',
      expect.objectContaining({ queries: expect.objectContaining({ type: 'EmailFolder' }) }),
    );
  });

  it('logs an error when listing members fails', async () => {
    setSalesforceUrl();
    const api = fakeApi({
      apiSoap: vi.fn(async (_w: string, method: string) => {
        if (method === 'describeMetadata') return { metadataObjects: [{ xmlName: 'ApexClass' }] };
        if (method === 'listMetadata') throw new Error('list boom');
        return {};
      }) as unknown as SalesforceApiClient['apiSoap'],
    });
    const feature = createMetadataRetrieveFeature({ api });
    await feature.onActivate?.();
    await flush();
    expandType('ApexClass');
    await flush();
    await flush();
    expect(document.body.textContent).toContain('Failed to load members');
  });

  it('renders an empty-state message when the filter matches nothing', async () => {
    setSalesforceUrl();
    const feature = createMetadataRetrieveFeature({ api: fakeApi() });
    await feature.onActivate?.();
    await flush();

    const filter = document.querySelector('input[placeholder*="Filter"]') as HTMLInputElement;
    filter.value = 'zzz-not-a-real-type';
    filter.dispatchEvent(new Event('input'));
    expect(document.body.textContent).toContain('No matching metadata types');
  });

  it('reloads the describe when the Managed toggle changes', async () => {
    setSalesforceUrl();
    const api = fakeApi();
    const feature = createMetadataRetrieveFeature({ api });
    await feature.onActivate?.();
    await flush();

    const managedChk = Array.from(document.querySelectorAll('label'))
      .find((l) => l.textContent?.includes('Managed'))!
      .querySelector('input') as HTMLInputElement;
    managedChk.checked = true;
    managedChk.dispatchEvent(new Event('change'));
    await flush();
    await flush();

    const describeCalls = (api.apiSoap as any).mock.calls.filter((c: any[]) => c[1] === 'describeMetadata');
    expect(describeCalls.length).toBe(2);
  });
});

describe('metadata-retrieve — describe failure branches', () => {
  it('logs a parse failure when the response has no metadataObjects', async () => {
    setSalesforceUrl();
    const api = fakeApi({
      apiSoap: vi.fn(async () => ({})) as unknown as SalesforceApiClient['apiSoap'],
    });
    const feature = createMetadataRetrieveFeature({ api });
    await feature.onActivate?.();
    await flush();
    expect(document.body.textContent).toContain('Failed to parse metadata describe');
  });

  it('logs an error when the describe SOAP call throws', async () => {
    setSalesforceUrl();
    const api = fakeApi({
      apiSoap: vi.fn(async () => {
        throw new Error('SOAP boom');
      }) as unknown as SalesforceApiClient['apiSoap'],
    });
    const feature = createMetadataRetrieveFeature({ api });
    await feature.onActivate?.();
    await flush();
    expect(document.body.textContent).toContain('Describe metadata failed');
  });
});

// NOTE: the package.xml import path (loadFromPackageXml) is intentionally not
// covered — its <input type="file"> is created detached (never appended to the
// document) and the helper isn't exported, so there is no DOM/test seam to
// drive it without modifying production source.

describe('metadata-retrieve — retrieve polling outcomes', () => {
  function selectFirstType(): void {
    const chk = document.querySelector('.sfdt-tree-chk') as HTMLInputElement;
    chk.checked = true;
    chk.dispatchEvent(new Event('change'));
  }

  it('downloads the zip on a successful retrieve', async () => {
    setSalesforceUrl();
    // Return a same-origin URL: happy-dom navigates on anchor.click(), and a
    // null-origin blob: URL would break replaceState in later tests.
    const createObjSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('https://x.lightning.force.com/zip-stub');
    const api = fakeApi({
      apiSoap: vi.fn(async (_w: string, method: string) => {
        if (method === 'describeMetadata') return { metadataObjects: [{ xmlName: 'ApexClass' }] };
        if (method === 'retrieve') return { id: 'ret-ok' };
        if (method === 'checkRetrieveStatus') return { done: true, success: true, zipFile: btoa('PKfakezipbytes') };
        return {};
      }) as unknown as SalesforceApiClient['apiSoap'],
    });
    const feature = createMetadataRetrieveFeature({ api });
    await feature.onActivate?.();
    await flush();
    selectFirstType();

    vi.useFakeTimers();
    btnExact('Retrieve Zip')!.click();
    await vi.advanceTimersByTimeAsync(2100);
    vi.useRealTimers();

    expect(api.apiSoap).toHaveBeenCalledWith('Metadata', 'retrieve', expect.objectContaining({
      retrieveRequest: expect.objectContaining({
        unpackaged: expect.objectContaining({ types: expect.arrayContaining([
          expect.objectContaining({ name: 'ApexClass', members: ['*'] }),
        ]) }),
      }),
    }));
    expect(createObjSpy).toHaveBeenCalled();
    expect(document.body.textContent).toContain('zip downloaded successfully');
    createObjSpy.mockRestore();
  });

  it('reports a missing zip payload on an otherwise successful retrieve', async () => {
    setSalesforceUrl();
    const api = fakeApi({
      apiSoap: vi.fn(async (_w: string, method: string) => {
        if (method === 'describeMetadata') return { metadataObjects: [{ xmlName: 'ApexClass' }] };
        if (method === 'retrieve') return { id: 'ret-nozip' };
        if (method === 'checkRetrieveStatus') return { done: true, success: true };
        return {};
      }) as unknown as SalesforceApiClient['apiSoap'],
    });
    const feature = createMetadataRetrieveFeature({ api });
    await feature.onActivate?.();
    await flush();

    vi.useFakeTimers();
    btnExact('Retrieve Zip')!.click();
    await vi.advanceTimersByTimeAsync(2100);
    vi.useRealTimers();

    expect(document.body.textContent).toContain('no zipFile payload');
  });

  it('reports a failed retrieve job', async () => {
    setSalesforceUrl();
    const api = fakeApi({
      apiSoap: vi.fn(async (_w: string, method: string) => {
        if (method === 'describeMetadata') return { metadataObjects: [{ xmlName: 'ApexClass' }] };
        if (method === 'retrieve') return { id: 'ret-fail' };
        if (method === 'checkRetrieveStatus') return { done: true, success: false, status: 'Failed' };
        return {};
      }) as unknown as SalesforceApiClient['apiSoap'],
    });
    const feature = createMetadataRetrieveFeature({ api });
    await feature.onActivate?.();
    await flush();

    vi.useFakeTimers();
    btnExact('Retrieve Zip')!.click();
    await vi.advanceTimersByTimeAsync(2100);
    vi.useRealTimers();

    expect(document.body.textContent).toContain('Retrieve job failed');
  });

  it('errors when retrieve returns no job id', async () => {
    setSalesforceUrl();
    const api = fakeApi({
      apiSoap: vi.fn(async (_w: string, method: string) => {
        if (method === 'describeMetadata') return { metadataObjects: [{ xmlName: 'ApexClass' }] };
        if (method === 'retrieve') return {}; // no id
        return {};
      }) as unknown as SalesforceApiClient['apiSoap'],
    });
    const feature = createMetadataRetrieveFeature({ api });
    await feature.onActivate?.();
    await flush();
    btnExact('Retrieve Zip')!.click();
    await flush();
    await flush();
    expect(document.body.textContent).toContain('No retrieve ID returned');
  });

  it('surfaces a thrown error during retrieve', async () => {
    setSalesforceUrl();
    let calls = 0;
    const api = fakeApi({
      apiSoap: vi.fn(async (_w: string, method: string) => {
        if (method === 'describeMetadata') return { metadataObjects: [{ xmlName: 'ApexClass' }] };
        if (method === 'retrieve') {
          calls++;
          throw new Error('retrieve exploded');
        }
        return {};
      }) as unknown as SalesforceApiClient['apiSoap'],
    });
    const feature = createMetadataRetrieveFeature({ api });
    await feature.onActivate?.();
    await flush();

    btnExact('Retrieve Zip')!.click();
    await flush();
    await flush();

    expect(calls).toBe(1);
    expect(document.body.textContent).toContain('Retrieve failed: retrieve exploded');
  });
});

describe('metadata-retrieve — deploy flow', () => {
  function switchToDeploy(): void {
    btnExact('Deploy')!.click();
  }
  function setZipFile(): void {
    const fileInput = document.querySelector('input[type="file"][accept=".zip"]') as HTMLInputElement;
    const file = new File([new Uint8Array([80, 75, 3, 4])], 'bundle.zip', { type: 'application/zip' });
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
  }

  it('warns when no ZIP file is selected', async () => {
    setSalesforceUrl();
    const feature = createMetadataRetrieveFeature({ api: fakeApi() });
    await feature.onActivate?.();
    await flush();
    switchToDeploy();
    btnExact('Deploy ZIP')!.click();
    await flush();
    expect(document.body.textContent).toContain('select a metadata ZIP file');
  });

  it('deploys a ZIP with specified tests and reports success', async () => {
    setSalesforceUrl();
    const api = fakeApi();
    const feature = createMetadataRetrieveFeature({ api });
    await feature.onActivate?.();
    await flush();
    switchToDeploy();

    // Choose RunSpecifiedTests so reqOpts.runTests is built from the input
    const testLevel = document.querySelector('select') as HTMLSelectElement;
    testLevel.value = 'RunSpecifiedTests';
    testLevel.dispatchEvent(new Event('change'));
    const runTests = document.querySelector('input[placeholder*="MyTestClass"]') as HTMLInputElement;
    runTests.value = 'TestA, TestB';
    runTests.dispatchEvent(new Event('input'));

    setZipFile();
    btnExact('Deploy ZIP')!.click();
    await flush();
    await flush();
    await new Promise((r) => setTimeout(r, 2100));

    expect(api.apiSoap).toHaveBeenCalledWith('Metadata', 'deploy', expect.objectContaining({
      deployOptions: expect.objectContaining({
        testLevel: 'RunSpecifiedTests',
        runTests: ['TestA', 'TestB'],
      }),
    }));
    expect(document.body.textContent).toContain('Deployment completed successfully');
  });

  it('errors when deploy returns no job id', async () => {
    setSalesforceUrl();
    const api = fakeApi({
      apiSoap: vi.fn(async (_w: string, method: string) => {
        if (method === 'describeMetadata') return { metadataObjects: [{ xmlName: 'ApexClass' }] };
        if (method === 'deploy') return {}; // no id
        return {};
      }) as unknown as SalesforceApiClient['apiSoap'],
    });
    const feature = createMetadataRetrieveFeature({ api });
    await feature.onActivate?.();
    await flush();
    switchToDeploy();
    setZipFile();
    btnExact('Deploy ZIP')!.click();
    await flush();
    await flush();
    expect(document.body.textContent).toContain('No deployment job ID');
  });

  it('surfaces a thrown error during deploy', async () => {
    setSalesforceUrl();
    const api = fakeApi({
      apiSoap: vi.fn(async (_w: string, method: string) => {
        if (method === 'describeMetadata') return { metadataObjects: [{ xmlName: 'ApexClass' }] };
        if (method === 'deploy') throw new Error('deploy boom');
        return {};
      }) as unknown as SalesforceApiClient['apiSoap'],
    });
    const feature = createMetadataRetrieveFeature({ api });
    await feature.onActivate?.();
    await flush();
    switchToDeploy();
    setZipFile();
    btnExact('Deploy ZIP')!.click();
    await flush();
    await flush();
    expect(document.body.textContent).toContain('Deploy failed: deploy boom');
  });

  it('lists component and test failures when the deploy fails', async () => {
    setSalesforceUrl();
    const api = fakeApi({
      apiSoap: vi.fn(async (_w: string, method: string) => {
        if (method === 'describeMetadata') return { metadataObjects: [{ xmlName: 'ApexClass' }] };
        if (method === 'deploy') return { id: 'dep-fail' };
        if (method === 'checkDeployStatus') {
          return {
            done: true,
            success: false,
            details: {
              componentFailures: [{ componentType: 'ApexClass', fullName: 'Foo', problem: 'compile error' }],
              runTestResult: { failures: [{ name: 'FooTest', methodName: 'testIt', message: 'assert boom' }] },
            },
          };
        }
        return {};
      }) as unknown as SalesforceApiClient['apiSoap'],
    });
    const feature = createMetadataRetrieveFeature({ api });
    await feature.onActivate?.();
    await flush();
    switchToDeploy();
    setZipFile();
    btnExact('Deploy ZIP')!.click();
    await flush();
    await flush();
    await new Promise((r) => setTimeout(r, 2100));

    const text = document.body.textContent ?? '';
    expect(text).toContain('Deployment failed');
    expect(text).toContain('compile error');
    expect(text).toContain('assert boom');
  });
});

describe('metadata-retrieve — toolbar & overlay', () => {
  it('copies and downloads package.xml and switches tabs', async () => {
    setSalesforceUrl();
    const clipSpy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined as any);
    const createObjSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('https://x.lightning.force.com/xml-stub');
    const feature = createMetadataRetrieveFeature({ api: fakeApi() });
    await feature.onActivate?.();
    await flush();

    btnExact('Copy XML')!.click();
    expect(clipSpy).toHaveBeenCalledWith(expect.stringContaining('<Package'));

    btnExact('Download XML')!.click();
    expect(createObjSpy).toHaveBeenCalled();

    // Tab toggles
    btnExact('Deploy')!.click();
    btnExact('Retrieve')!.click();
    btnExact('Clear Logs')!.click();

    clipSpy.mockRestore();
    createObjSpy.mockRestore();
  });

  it('closes when the overlay backdrop is clicked', async () => {
    setSalesforceUrl();
    const feature = createMetadataRetrieveFeature({ api: fakeApi() });
    await feature.onActivate?.();
    await flush();
    const overlay = document.querySelector('.sfdt-view-overlay') as HTMLDivElement;
    overlay.dispatchEvent(new Event('click'));
    expect(document.querySelector('.sfdt-view-overlay')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// B-4: bridge-connected path. The bridge is mocked at the bridge-client
// boundary (bridgeFactory → { call }), the same seam bridge-tools tests use.
// Server XML is returned as sentinels so the tests can assert the
// single-writer rule literally: the preview shows the CLI's bytes verbatim,
// never anything the extension assembled itself.
// ---------------------------------------------------------------------------

const SERVER_ADDITIVE_XML = 'SERVER-ADDITIVE-XML';
const SERVER_DESTRUCTIVE_XML = 'SERVER-DESTRUCTIVE-XML';
const SERVER_EMPTY_PAIR_XML = 'SERVER-EMPTY-PAIR-XML';

function fakeBridge(onCall?: (req: any) => any) {
  const call = vi.fn(async (req: any) => {
    if (onCall) {
      const out = onCall(req);
      if (out !== undefined) return out;
    }
    if (req.kind === 'manifest.discover' && req.type === undefined) {
      return { ok: true, requestId: 'r', data: { org: 'devhub', types: ['CustomObject', 'ApexClass'] } };
    }
    if (req.kind === 'manifest.discover') {
      return { ok: true, requestId: 'r', data: { org: 'devhub', type: req.type, members: ['Alpha', 'Beta'] } };
    }
    if (req.kind === 'manifest.render') {
      if (req.mode === 'destructive') {
        return {
          ok: true,
          requestId: 'r',
          data: {
            mode: 'destructive',
            destructiveChangesXml: SERVER_DESTRUCTIVE_XML,
            emptyPackageXml: SERVER_EMPTY_PAIR_XML,
          },
        };
      }
      return { ok: true, requestId: 'r', data: { mode: 'additive', xml: SERVER_ADDITIVE_XML } };
    }
    return { ok: false, requestId: 'r', error: `unexpected kind ${req.kind}`, code: 'NOT_IMPLEMENTED' };
  });
  const factory = async () => ({ call });
  return { call, factory };
}

function offlineBridgeFactory() {
  const call = vi.fn(async (_req: any) => ({
    ok: false as const,
    requestId: 'r',
    error: 'sfdt is not running',
    code: 'BRIDGE_OFFLINE' as const,
  }));
  return { call, factory: async () => ({ call }) };
}

function mainTextarea(): HTMLTextAreaElement {
  return document.querySelector('#sfdt-meta-xml-textarea') as HTMLTextAreaElement;
}

function pairTextarea(): HTMLTextAreaElement {
  return document.querySelector('#sfdt-meta-pair-textarea') as HTMLTextAreaElement;
}

describe('metadata-retrieve — bridge-connected path', () => {
  it('discovers types over the bridge and never calls the SOAP describe', async () => {
    setSalesforceUrl();
    const api = fakeApi();
    const { call, factory } = fakeBridge();
    const feature = createMetadataRetrieveFeature({ api, bridgeFactory: factory });
    await feature.onActivate?.();

    // The type list came from manifest.discover (no `type` field) …
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'manifest.discover' }),
      expect.anything(),
    );
    expect(document.body.textContent).toContain('ApexClass');
    expect(document.body.textContent).toContain('CustomObject');
    expect(document.body.textContent).toContain('sfdt bridge connected');

    // … and the SOAP path was not touched at all.
    expect(api.apiSoap).not.toHaveBeenCalled();

    // Managed-package filtering is a SOAP-describe concept — hidden on the bridge path.
    const managedLabel = Array.from(document.querySelectorAll('label')).find(
      (l) => l.textContent?.includes('Managed'),
    ) as HTMLLabelElement;
    expect(managedLabel.style.display).toBe('none');
  });

  it('expands a type through manifest.discover and renders its members', async () => {
    setSalesforceUrl();
    const { call, factory } = fakeBridge();
    const feature = createMetadataRetrieveFeature({ api: fakeApi(), bridgeFactory: factory });
    await feature.onActivate?.();

    expandType('ApexClass');
    await flush();
    await flush();

    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'manifest.discover', type: 'ApexClass' }),
      expect.anything(),
    );
    expect(document.body.textContent).toContain('Alpha');
    expect(document.body.textContent).toContain('Beta');
  });

  it('renders the preview via manifest.render — server XML shown verbatim (single writer)', async () => {
    setSalesforceUrl();
    const { call, factory } = fakeBridge();
    const feature = createMetadataRetrieveFeature({ api: fakeApi(), bridgeFactory: factory });
    await feature.onActivate?.();

    const chk = document.querySelector('.sfdt-tree-chk') as HTMLInputElement;
    chk.checked = true;
    chk.dispatchEvent(new Event('change'));
    await flush();

    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'manifest.render',
        items: [{ type: 'ApexClass', member: '*' }],
        mode: 'additive',
        apiVersion: '62.0',
      }),
    );
    // The preview is byte-for-byte what the bridge returned — the extension
    // did not assemble any XML itself on this path.
    expect(mainTextarea().value).toBe(SERVER_ADDITIVE_XML);
  });

  it('sends explicit members (not the wildcard) when children are ticked', async () => {
    setSalesforceUrl();
    const { call, factory } = fakeBridge();
    const feature = createMetadataRetrieveFeature({ api: fakeApi(), bridgeFactory: factory });
    await feature.onActivate?.();

    expandType('ApexClass');
    await flush();
    await flush();

    // Tick just the "Alpha" child.
    const alphaChk = Array.from(document.querySelectorAll('span'))
      .find((s) => s.textContent === 'Alpha')!
      .parentElement!.querySelector('input[type="checkbox"]') as HTMLInputElement;
    alphaChk.checked = true;
    alphaChk.dispatchEvent(new Event('change'));
    await flush();

    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'manifest.render',
        items: [{ type: 'ApexClass', member: 'Alpha' }],
      }),
    );
  });

  it('destructive mode renders the pair, shows the warning banner, and disables retrieve', async () => {
    setSalesforceUrl();
    const { call, factory } = fakeBridge();
    const feature = createMetadataRetrieveFeature({ api: fakeApi(), bridgeFactory: factory });
    await feature.onActivate?.();

    const chk = document.querySelector('.sfdt-tree-chk') as HTMLInputElement;
    chk.checked = true;
    chk.dispatchEvent(new Event('change'));
    await flush();

    btnExact('Destructive')!.click();
    await flush();

    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'manifest.render', mode: 'destructive' }),
    );
    expect(mainTextarea().value).toBe(SERVER_DESTRUCTIVE_XML);
    expect(pairTextarea().value).toBe(SERVER_EMPTY_PAIR_XML);

    const banner = document.querySelector('[role="alert"]') as HTMLDivElement;
    expect(banner.style.display).toBe('block');
    expect(banner.textContent).toContain('DELETES');
    expect(banner.textContent).toContain('SFDT_DESTRUCTIVE_TIMING');

    const retrieveBtn = btnExact('Retrieve Zip')!;
    expect(retrieveBtn.disabled).toBe(true);

    // Switching back to additive re-renders and re-enables retrieve.
    btnExact('Additive')!.click();
    await flush();
    expect(mainTextarea().value).toBe(SERVER_ADDITIVE_XML);
    expect(retrieveBtn.disabled).toBe(false);
    expect(banner.style.display).toBe('none');
  });

  it('keeps the whole-type wildcard sticky when the type is expanded (bridge path)', async () => {
    setSalesforceUrl();
    const { call, factory } = fakeBridge();
    const feature = createMetadataRetrieveFeature({ api: fakeApi(), bridgeFactory: factory });
    await feature.onActivate?.();

    // Tick the whole type, then expand it — the children render ticked, but
    // the manifest (and the persisted selection) stay the `*` wildcard.
    const chk = document.querySelector('.sfdt-tree-chk') as HTMLInputElement;
    chk.checked = true;
    chk.dispatchEvent(new Event('change'));
    await flush();

    call.mockClear();
    expandType('ApexClass');
    await flush();
    await flush();

    // Expanding is browsing: it changes no selection, so it fires no render …
    expect(call.mock.calls.filter((c: any[]) => c[0].kind === 'manifest.render').length).toBe(0);
    // … and the children render ticked.
    const betaTick = Array.from(document.querySelectorAll('span'))
      .find((s) => s.textContent === 'Beta')!
      .parentElement!.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(betaTick.checked).toBe(true);

    // The next real selection change proves ApexClass is STILL a wildcard
    // after expansion rather than an explicit member list.
    const objChk = document.querySelectorAll('.sfdt-tree-chk')[1] as HTMLInputElement;
    objChk.checked = true;
    objChk.dispatchEvent(new Event('change'));
    await flush();
    const afterExpand = call.mock.calls.filter((c: any[]) => c[0].kind === 'manifest.render');
    expect(afterExpand.length).toBe(1);
    expect(afterExpand[0]![0].items).toEqual([
      { type: 'ApexClass', member: '*' },
      { type: 'CustomObject', member: '*' },
    ]);
    objChk.checked = false;
    objChk.dispatchEvent(new Event('change'));
    await flush();

    // Unticking one member narrows `*` to the remaining explicit members.
    const betaChk = Array.from(document.querySelectorAll('span'))
      .find((s) => s.textContent === 'Beta')!
      .parentElement!.querySelector('input[type="checkbox"]') as HTMLInputElement;
    betaChk.checked = false;
    betaChk.dispatchEvent(new Event('change'));
    await flush();

    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'manifest.render',
        items: [{ type: 'ApexClass', member: 'Alpha' }],
      }),
    );
  });

  it('discards a stale manifest.render response that resolves after a newer one', async () => {
    setSalesforceUrl();
    // Deferred render responses so the test controls resolution order.
    const pendingRenders: Array<{ items: any; resolve: (r: any) => void }> = [];
    const { factory } = fakeBridge((req) => {
      if (req.kind === 'manifest.render') {
        return new Promise((resolve) => {
          pendingRenders.push({ items: req.items, resolve });
        });
      }
      return undefined;
    });
    const feature = createMetadataRetrieveFeature({ api: fakeApi(), bridgeFactory: factory });
    await feature.onActivate?.();

    // Selection 1 (ApexClass) starts render A; selection 2 (CustomObject too)
    // starts render B while A is still in flight.
    const checks = document.querySelectorAll('.sfdt-tree-chk');
    (checks[0] as HTMLInputElement).checked = true;
    checks[0]!.dispatchEvent(new Event('change'));
    await flush();
    (document.querySelectorAll('.sfdt-tree-chk')[1] as HTMLInputElement).checked = true;
    document.querySelectorAll('.sfdt-tree-chk')[1]!.dispatchEvent(new Event('change'));
    await flush();
    expect(pendingRenders.length).toBe(2);

    // Resolve out of order: newer render B first, then stale render A.
    pendingRenders[1]!.resolve({
      ok: true,
      requestId: 'r',
      data: { mode: 'additive', xml: 'XML-FOR-NEWER-SELECTION' },
    });
    await flush();
    expect(mainTextarea().value).toBe('XML-FOR-NEWER-SELECTION');

    pendingRenders[0]!.resolve({
      ok: true,
      requestId: 'r',
      data: { mode: 'additive', xml: 'XML-FOR-STALE-SELECTION' },
    });
    await flush();

    // The stale response must NOT clobber the newer preview.
    expect(mainTextarea().value).toBe('XML-FOR-NEWER-SELECTION');
  });

  it('an in-flight render cannot repopulate a preview cleared by Clear all', async () => {
    setSalesforceUrl();
    const pendingRenders: Array<(r: any) => void> = [];
    const { factory } = fakeBridge((req) => {
      if (req.kind === 'manifest.render') {
        return new Promise((resolve) => {
          pendingRenders.push(resolve);
        });
      }
      return undefined;
    });
    const feature = createMetadataRetrieveFeature({ api: fakeApi(), bridgeFactory: factory });
    await feature.onActivate?.();

    const chk = document.querySelector('.sfdt-tree-chk') as HTMLInputElement;
    chk.checked = true;
    chk.dispatchEvent(new Event('change'));
    await flush();
    expect(pendingRenders.length).toBe(1);

    // Clear all while the render is still in flight, then let it resolve.
    btnExact('Clear all')!.click();
    await flush();
    expect(mainTextarea().value).toBe('');

    pendingRenders[0]!({ ok: true, requestId: 'r', data: { mode: 'additive', xml: 'LATE-XML' } });
    await flush();
    expect(mainTextarea().value).toBe('');
  });

  it('surfaces a member-discovery failure and collapses the node (no fabricated tree)', async () => {
    setSalesforceUrl();
    const { factory } = fakeBridge((req) => {
      if (req.kind === 'manifest.discover' && req.type) {
        return { ok: false, requestId: 'r', error: 'org unreachable', code: 'INTERNAL_ERROR' };
      }
      return undefined;
    });
    const feature = createMetadataRetrieveFeature({ api: fakeApi(), bridgeFactory: factory });
    await feature.onActivate?.();

    expandType('ApexClass');
    await flush();
    await flush();

    expect(document.body.textContent).toContain('Failed to load members: org unreachable');
    // The node collapsed back — nothing pretends the type is empty.
    const expBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'Expand ApexClass',
    );
    expect(expBtn).not.toBeUndefined();
  });

  it('logs a render failure without clobbering the last good preview', async () => {
    setSalesforceUrl();
    let failRender = false;
    const { factory } = fakeBridge((req) => {
      if (req.kind === 'manifest.render' && failRender) {
        return { ok: false, requestId: 'r', error: 'render boom', code: 'INTERNAL_ERROR' };
      }
      return undefined;
    });
    const feature = createMetadataRetrieveFeature({ api: fakeApi(), bridgeFactory: factory });
    await feature.onActivate?.();

    const chk = document.querySelector('.sfdt-tree-chk') as HTMLInputElement;
    chk.checked = true;
    chk.dispatchEvent(new Event('change'));
    await flush();
    expect(mainTextarea().value).toBe(SERVER_ADDITIVE_XML);

    failRender = true;
    btnExact('Destructive')!.click();
    await flush();

    expect(document.body.textContent).toContain('Manifest render failed: render boom');
    expect(mainTextarea().value).toBe(SERVER_ADDITIVE_XML);
  });
});

describe('metadata-retrieve — offline fallback', () => {
  it('falls back to the SOAP describe when the bridge is offline', async () => {
    setSalesforceUrl();
    const api = fakeApi();
    const { factory } = offlineBridgeFactory();
    const feature = createMetadataRetrieveFeature({ api, bridgeFactory: factory });
    await feature.onActivate?.();

    expect(api.apiSoap).toHaveBeenCalledWith('Metadata', 'describeMetadata', { apiVersion: '62.0' });
    expect(document.body.textContent).toContain('sfdt bridge unavailable');
    expect(document.body.textContent).toContain('ApexClass');

    // Selection renders through the kept private writer.
    const chk = document.querySelector('.sfdt-tree-chk') as HTMLInputElement;
    chk.checked = true;
    chk.dispatchEvent(new Event('change'));
    expect(mainTextarea().value).toContain('<members>*</members>');
    expect(mainTextarea().value).toContain('<name>ApexClass</name>');
  });

  it('builds the destructive pair locally when offline', async () => {
    setSalesforceUrl();
    const { factory } = offlineBridgeFactory();
    const feature = createMetadataRetrieveFeature({ api: fakeApi(), bridgeFactory: factory });
    await feature.onActivate?.();

    const chk = document.querySelector('.sfdt-tree-chk') as HTMLInputElement;
    chk.checked = true;
    chk.dispatchEvent(new Event('change'));
    btnExact('Destructive')!.click();
    await flush();

    // destructiveChanges.xml lists the members …
    expect(mainTextarea().value).toContain('<members>*</members>');
    expect(mainTextarea().value).toContain('<name>ApexClass</name>');
    // … and the paired package.xml is empty (version only, no <types>).
    expect(pairTextarea().value).toContain('<version>62.0</version>');
    expect(pairTextarea().value).not.toContain('<types>');
  });
});

describe('metadata-retrieve — per-org selection persistence', () => {
  it('persists a wildcard selection and restores it in a fresh instance', async () => {
    setSalesforceUrl();
    const { factory } = fakeBridge();
    const first = createMetadataRetrieveFeature({ api: fakeApi(), bridgeFactory: factory });
    await first.onActivate?.();

    const chk = document.querySelector('.sfdt-tree-chk') as HTMLInputElement;
    chk.checked = true;
    chk.dispatchEvent(new Event('change'));
    await flush();

    // Simulate closing and reopening the tool in a brand-new feature instance.
    clearBody();
    const second = createMetadataRetrieveFeature({ api: fakeApi(), bridgeFactory: factory });
    await second.onActivate?.();

    expect(document.body.textContent).toContain('Restored 1 saved selection');
    const restoredChk = document.querySelector('.sfdt-tree-chk') as HTMLInputElement;
    expect(restoredChk.checked).toBe(true);
    expect(mainTextarea().value).toBe(SERVER_ADDITIVE_XML);
  });

  it('persists member-level selections and seeds them back into the tree', async () => {
    setSalesforceUrl();
    const { call, factory } = fakeBridge();
    const first = createMetadataRetrieveFeature({ api: fakeApi(), bridgeFactory: factory });
    await first.onActivate?.();

    expandType('ApexClass');
    await flush();
    await flush();
    const alphaChk = Array.from(document.querySelectorAll('span'))
      .find((s) => s.textContent === 'Alpha')!
      .parentElement!.querySelector('input[type="checkbox"]') as HTMLInputElement;
    alphaChk.checked = true;
    alphaChk.dispatchEvent(new Event('change'));
    await flush();

    clearBody();
    call.mockClear();
    const second = createMetadataRetrieveFeature({ api: fakeApi(), bridgeFactory: factory });
    await second.onActivate?.();

    expect(document.body.textContent).toContain('Restored 1 saved selection');
    expect(document.body.textContent).toContain('Alpha');
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'manifest.render',
        items: [{ type: 'ApexClass', member: 'Alpha' }],
      }),
    );
  });

  it('clear-all wipes both the tree and the stored selection', async () => {
    setSalesforceUrl();
    const { factory } = fakeBridge();
    const first = createMetadataRetrieveFeature({ api: fakeApi(), bridgeFactory: factory });
    await first.onActivate?.();

    const chk = document.querySelector('.sfdt-tree-chk') as HTMLInputElement;
    chk.checked = true;
    chk.dispatchEvent(new Event('change'));
    await flush();

    btnExact('Clear all')!.click();
    await flush();

    expect((document.querySelector('.sfdt-tree-chk') as HTMLInputElement).checked).toBe(false);
    expect(mainTextarea().value).toBe('');

    // A fresh instance restores nothing.
    clearBody();
    const second = createMetadataRetrieveFeature({ api: fakeApi(), bridgeFactory: factory });
    await second.onActivate?.();
    expect(document.body.textContent).not.toContain('Restored');
  });

  it('keys the stored selection by Salesforce host — another org restores nothing', async () => {
    setSalesforceUrl();
    // happy-dom refuses cross-origin history rewrites, so the second org is
    // modelled through the feature's `win` seam instead.
    function winForHost(hostname: string): Window {
      return { location: { hostname }, navigator: window.navigator } as unknown as Window;
    }
    const { factory } = fakeBridge();
    const first = createMetadataRetrieveFeature({
      api: fakeApi(),
      bridgeFactory: factory,
      win: winForHost('org-a.my.salesforce.com'),
    });
    await first.onActivate?.();

    const chk = document.querySelector('.sfdt-tree-chk') as HTMLInputElement;
    chk.checked = true;
    chk.dispatchEvent(new Event('change'));
    await flush();

    // A different org host sees no restored selection …
    clearBody();
    const otherOrg = createMetadataRetrieveFeature({
      api: fakeApi(),
      bridgeFactory: factory,
      win: winForHost('org-b.my.salesforce.com'),
    });
    await otherOrg.onActivate?.();
    expect(document.body.textContent).not.toContain('Restored');
    expect((document.querySelector('.sfdt-tree-chk') as HTMLInputElement).checked).toBe(false);

    // … while the original host still restores its selection.
    clearBody();
    const sameOrg = createMetadataRetrieveFeature({
      api: fakeApi(),
      bridgeFactory: factory,
      win: winForHost('org-a.my.salesforce.com'),
    });
    await sameOrg.onActivate?.();
    expect(document.body.textContent).toContain('Restored 1 saved selection');
  });

  it('persists offline selections too (storage is path-independent)', async () => {
    setSalesforceUrl();
    const { factory } = offlineBridgeFactory();
    const first = createMetadataRetrieveFeature({ api: fakeApi(), bridgeFactory: factory });
    await first.onActivate?.();

    const chk = document.querySelector('.sfdt-tree-chk') as HTMLInputElement;
    chk.checked = true;
    chk.dispatchEvent(new Event('change'));
    await flush();

    clearBody();
    const second = createMetadataRetrieveFeature({ api: fakeApi(), bridgeFactory: factory });
    await second.onActivate?.();

    expect(document.body.textContent).toContain('Restored 1 saved selection');
    expect(mainTextarea().value).toContain('<members>*</members>');
  });
});

// ---------------------------------------------------------------------------
// B-4 follow-up (CI review bot on #297):
//   1. restoring a member-level selection must not truncate that type's tree —
//      a seeded node still fetches its real member list on expand, and the
//      restored ticks survive the merge (both paths).
//   2. plain expand/collapse must not fire a manifest.render round-trip.
// ---------------------------------------------------------------------------

describe('metadata-retrieve — seeded member restore does not truncate the tree', () => {
  it('fetches the full member list on expand and keeps the restored tick (bridge path)', async () => {
    setSalesforceUrl();
    const { call, factory } = fakeBridge();
    const first = createMetadataRetrieveFeature({ api: fakeApi(), bridgeFactory: factory });
    await first.onActivate?.();

    // Tick one member, then reopen the tool so the selection is restored.
    expandType('ApexClass');
    await flush();
    await flush();
    const alphaChk = Array.from(document.querySelectorAll('span'))
      .find((s) => s.textContent === 'Alpha')!
      .parentElement!.querySelector('input[type="checkbox"]') as HTMLInputElement;
    alphaChk.checked = true;
    alphaChk.dispatchEvent(new Event('change'));
    await flush();

    clearBody();
    call.mockClear();
    const second = createMetadataRetrieveFeature({ api: fakeApi(), bridgeFactory: factory });
    await second.onActivate?.();
    expect(document.body.textContent).toContain('Restored 1 saved selection');
    // Seeded-only tree: the sibling member is not there yet.
    expect(document.body.textContent).toContain('Alpha');
    expect(document.body.textContent).not.toContain('Beta');

    // Collapse then re-expand — the seeded node must still fetch.
    expandType('ApexClass'); // collapse
    await flush();
    expandType('ApexClass'); // expand → fetch
    await flush();
    await flush();

    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'manifest.discover', type: 'ApexClass' }),
      expect.anything(),
    );
    // Full member list is visible …
    expect(document.body.textContent).toContain('Alpha');
    expect(document.body.textContent).toContain('Beta');

    // … and the restored tick survived the merge (Alpha ticked, Beta not).
    const tickState = (name: string) =>
      (Array.from(document.querySelectorAll('span'))
        .find((s) => s.textContent === name)!
        .parentElement!.querySelector('input[type="checkbox"]') as HTMLInputElement).checked;
    expect(tickState('Alpha')).toBe(true);
    expect(tickState('Beta')).toBe(false);

    // The manifest still carries exactly the restored member.
    const renderCalls = call.mock.calls.filter((c: any[]) => c[0].kind === 'manifest.render');
    for (const c of renderCalls) {
      expect(c[0].items).toEqual([{ type: 'ApexClass', member: 'Alpha' }]);
    }
  });

  it('fetches the full member list on expand and keeps the restored tick (offline path)', async () => {
    setSalesforceUrl();
    const { factory } = offlineBridgeFactory();
    const listApi = () =>
      fakeApi({
        apiSoap: vi.fn(async (_w: string, method: string) => {
          if (method === 'describeMetadata') {
            return { metadataObjects: [{ xmlName: 'ApexClass', directoryName: 'classes', inFolder: false }] };
          }
          if (method === 'listMetadata') {
            return [
              { fullName: 'Alpha', fileName: 'classes/Alpha.cls', type: 'ApexClass', id: '1' },
              { fullName: 'Beta', fileName: 'classes/Beta.cls', type: 'ApexClass', id: '2' },
            ];
          }
          return {};
        }) as unknown as SalesforceApiClient['apiSoap'],
      });

    const first = createMetadataRetrieveFeature({ api: listApi(), bridgeFactory: factory });
    await first.onActivate?.();
    expandType('ApexClass');
    await flush();
    await flush();
    const alphaChk = Array.from(document.querySelectorAll('span'))
      .find((s) => s.textContent === 'Alpha')!
      .parentElement!.querySelector('input[type="checkbox"]') as HTMLInputElement;
    alphaChk.checked = true;
    alphaChk.dispatchEvent(new Event('change'));
    await flush();

    clearBody();
    const secondApi = listApi();
    const second = createMetadataRetrieveFeature({ api: secondApi, bridgeFactory: factory });
    await second.onActivate?.();
    expect(document.body.textContent).toContain('Restored 1 saved selection');
    expect(document.body.textContent).not.toContain('Beta');

    expandType('ApexClass'); // collapse
    await flush();
    expandType('ApexClass'); // expand → SOAP listMetadata
    await flush();
    await flush();

    expect(secondApi.apiSoap).toHaveBeenCalledWith(
      'Metadata',
      'listMetadata',
      expect.objectContaining({ queries: expect.objectContaining({ type: 'ApexClass' }) }),
    );
    expect(document.body.textContent).toContain('Beta');
    const tickState = (name: string) =>
      (Array.from(document.querySelectorAll('span'))
        .find((s) => s.textContent === name)!
        .parentElement!.querySelector('input[type="checkbox"]') as HTMLInputElement).checked;
    expect(tickState('Alpha')).toBe(true);
    expect(tickState('Beta')).toBe(false);
    // The offline preview still lists only the restored member.
    expect(mainTextarea().value).toContain('<members>Alpha</members>');
    expect(mainTextarea().value).not.toContain('<members>Beta</members>');
  });

  it('keeps a restored member the org no longer lists rather than dropping the selection', async () => {
    setSalesforceUrl();
    // Persist a member that the discover response does not contain.
    await new Promise<void>((resolve) => {
      chrome.storage.local.set(
        { 'sfdt-manifest-selections:x.lightning.force.com': { items: [{ type: 'ApexClass', member: 'Gone' }] } },
        () => resolve(),
      );
    });
    const { call, factory } = fakeBridge();
    const feature = createMetadataRetrieveFeature({ api: fakeApi(), bridgeFactory: factory });
    await feature.onActivate?.();
    expect(document.body.textContent).toContain('Restored 1 saved selection');

    expandType('ApexClass'); // collapse
    await flush();
    expandType('ApexClass'); // expand → fetch
    await flush();
    await flush();

    expect(document.body.textContent).toContain('were not returned by the org');
    expect(document.body.textContent).toContain('Gone');
    const renderCalls = call.mock.calls.filter((c: any[]) => c[0].kind === 'manifest.render');
    for (const c of renderCalls) {
      expect(c[0].items).toEqual([{ type: 'ApexClass', member: 'Gone' }]);
    }
  });

  it('does not re-fetch a genuinely loaded member list on re-expand', async () => {
    setSalesforceUrl();
    const { call, factory } = fakeBridge();
    const feature = createMetadataRetrieveFeature({ api: fakeApi(), bridgeFactory: factory });
    await feature.onActivate?.();

    expandType('ApexClass');
    await flush();
    await flush();
    const discoverCount = () =>
      call.mock.calls.filter((c: any[]) => c[0].kind === 'manifest.discover' && c[0].type === 'ApexClass').length;
    expect(discoverCount()).toBe(1);

    expandType('ApexClass'); // collapse
    await flush();
    expandType('ApexClass'); // expand again — already loaded
    await flush();
    await flush();
    expect(discoverCount()).toBe(1);
  });
});

describe('metadata-retrieve — expand/collapse is browsing, not selecting', () => {
  it('fires no manifest.render for a plain expand/collapse, even with a live selection', async () => {
    setSalesforceUrl();
    const { call, factory } = fakeBridge();
    const feature = createMetadataRetrieveFeature({ api: fakeApi(), bridgeFactory: factory });
    await feature.onActivate?.();

    // A selection exists on another type, so an unconditional re-render would
    // be a real (wasted) round-trip rather than a no-op empty render.
    const objChk = document.querySelectorAll('.sfdt-tree-chk')[1] as HTMLInputElement;
    objChk.checked = true;
    objChk.dispatchEvent(new Event('change'));
    await flush();

    call.mockClear();
    expandType('ApexClass'); // expand → discover only
    await flush();
    await flush();
    expandType('ApexClass'); // collapse
    await flush();

    const kinds = call.mock.calls.map((c: any[]) => c[0].kind);
    expect(kinds).toContain('manifest.discover');
    expect(kinds).not.toContain('manifest.render');
  });

  it('writes no storage entry for a plain expand/collapse with nothing selected', async () => {
    setSalesforceUrl();
    const { call, factory } = fakeBridge();
    const feature = createMetadataRetrieveFeature({ api: fakeApi(), bridgeFactory: factory });
    await feature.onActivate?.();

    call.mockClear();
    expandType('ApexClass');
    await flush();
    await flush();
    expandType('ApexClass');
    await flush();

    expect(call.mock.calls.map((c: any[]) => c[0].kind)).not.toContain('manifest.render');
    const stored = await new Promise<unknown>((resolve) => {
      chrome.storage.local.get('sfdt-manifest-selections:x.lightning.force.com', (items: any) =>
        resolve(items?.['sfdt-manifest-selections:x.lightning.force.com']),
      );
    });
    expect(stored).toBeUndefined();
  });

  it('still renders on every real selection change (AC preserved)', async () => {
    setSalesforceUrl();
    const { call, factory } = fakeBridge();
    const feature = createMetadataRetrieveFeature({ api: fakeApi(), bridgeFactory: factory });
    await feature.onActivate?.();

    expandType('ApexClass');
    await flush();
    await flush();
    call.mockClear();

    // Type tick → render.
    const typeChk = document.querySelector('.sfdt-tree-chk') as HTMLInputElement;
    typeChk.checked = true;
    typeChk.dispatchEvent(new Event('change'));
    await flush();
    expect(call.mock.calls.filter((c: any[]) => c[0].kind === 'manifest.render').length).toBe(1);

    // Member untick (narrowing the sticky wildcard) → another render.
    const betaChk = Array.from(document.querySelectorAll('span'))
      .find((s) => s.textContent === 'Beta')!
      .parentElement!.querySelector('input[type="checkbox"]') as HTMLInputElement;
    betaChk.checked = false;
    betaChk.dispatchEvent(new Event('change'));
    await flush();
    expect(call.mock.calls.filter((c: any[]) => c[0].kind === 'manifest.render').length).toBe(2);

    // Expanding a wildcard-selected type does not re-render (sticky `*`).
    expandType('ApexClass'); // collapse
    await flush();
    expandType('ApexClass'); // expand (already loaded)
    await flush();
    expect(call.mock.calls.filter((c: any[]) => c[0].kind === 'manifest.render').length).toBe(2);
  });
});
