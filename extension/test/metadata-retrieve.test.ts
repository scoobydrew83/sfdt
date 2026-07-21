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
  it('maps Report to ReportFolder, filters managed members, and folds selected children into package.xml', async () => {
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

    // Selecting the parent cascades to children -> members listed explicitly
    const reportChk = Array.from(document.querySelectorAll('span'))
      .find((s) => s.textContent === 'Report')!
      .parentElement!.querySelector('input[type="checkbox"]') as HTMLInputElement;
    reportChk.checked = true;
    reportChk.dispatchEvent(new Event('change'));

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea.value).toContain('<name>Report</name>');
    expect(textarea.value).toContain('<members>MyReport</members>');
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
