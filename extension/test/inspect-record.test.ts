import { describe, it, expect, beforeEach, vi } from 'vitest';
import { extractRecordContext } from '../lib/context-detector.js';
import {
  createInspectRecordFeature,
  _inspectRecordTestApi,
} from '../features/inspect-record.js';
import { _resetSettingsShapesForTests, _clearSettingsCacheForTests } from '../lib/settings.js';
import type { SalesforceApiClient } from '../lib/salesforce-api.js';

const { isRecordId } = _inspectRecordTestApi();

function fakeApi(overrides: Partial<SalesforceApiClient> = {}): SalesforceApiClient {
  return {
    query: vi.fn(),
    toolingQuery: vi.fn(),
    queryMore: vi.fn(),
    apiGet: vi.fn(async () => ({})),
    apiRequest: vi.fn(async () => ({})),
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

describe('inspect-record — context parser & helpers', () => {
  describe('extractRecordContext', () => {
    it('parses standard Lightning record URLs', () => {
      const url = 'https://mydomain.lightning.force.com/lightning/r/Account/001800000000001AAA/view';
      const ctx = extractRecordContext(url);
      expect(ctx).toEqual({ sobjectName: 'Account', recordId: '001800000000001AAA' });
    });

    it('parses Lightning URLs without SObject names', () => {
      const url = 'https://mydomain.lightning.force.com/lightning/r/001800000000001AAA/view';
      const ctx = extractRecordContext(url);
      expect(ctx).toEqual({ recordId: '001800000000001AAA' });
    });

    it('parses ID query parameter from URL', () => {
      const url = 'https://mydomain.lightning.force.com/apex/CustomPage?id=001800000000001AAA';
      const ctx = extractRecordContext(url);
      expect(ctx).toEqual({ recordId: '001800000000001AAA' });
    });

    it('parses Classic ID path structure', () => {
      const url = 'https://mydomain.my.salesforce.com/001800000000001AAA';
      const ctx = extractRecordContext(url);
      expect(ctx).toEqual({ recordId: '001800000000001AAA' });
    });

    it('ignores non-salesforce / non-record URLs', () => {
      expect(extractRecordContext('https://google.com')).toBeNull();
      expect(extractRecordContext('https://mydomain.lightning.force.com/lightning/setup/Flows/home')).toBeNull();
    });
  });

  describe('isRecordId', () => {
    it('validates 15-to-18 character ID formats', () => {
      expect(isRecordId('001800000000001AAA')).toBe(true);
      expect(isRecordId('001800000000001')).toBe(true);
      expect(isRecordId('001')).toBe(false);
      expect(isRecordId('000800000000001AAA')).toBe(false); // standard prefix exclusions
      expect(isRecordId('abc')).toBe(false);
    });
  });

});

describe('inspect-record — UI activation & inspection', () => {
  function setSalesforceUrl(url: string): void {
    window.history.replaceState({}, '', url);
  }

  it('renders records in search grid on activation', async () => {
    setSalesforceUrl('https://x.lightning.force.com/lightning/r/Account/001800000000001AAA/view');

    const globalMock = vi.fn().mockResolvedValue({
      sobjects: [{ name: 'Account', label: 'Account', keyPrefix: '001' }]
    });

    const describeMock = vi.fn().mockResolvedValue({
      name: 'Account',
      label: 'Account Label',
      fields: [
        { name: 'Id', label: 'Record ID', type: 'id', updateable: false, relationshipName: null, referenceTo: [] },
        { name: 'Name', label: 'Account Name', type: 'string', updateable: true, relationshipName: null, referenceTo: [] },
        { name: 'Phone', label: 'Phone Number', type: 'phone', updateable: true, relationshipName: null, referenceTo: [] }
      ]
    });

    const rowGetMock = vi.fn().mockResolvedValue({
      Id: '001800000000001AAA',
      Name: 'Acme Test Corp',
      Phone: '123-456-7890'
    });

    const apiGetMock = vi.fn(async (path: string) => {
      if (path.includes('/sobjects/Account/describe')) return describeMock();
      if (path.includes('/sobjects/Account/001800000000001AAA')) return rowGetMock();
      if (path.includes('/sobjects/')) return globalMock();
      return {};
    });

    const api = fakeApi({ apiGet: apiGetMock });
    const feature = createInspectRecordFeature({ api });

    await feature.onActivate?.();

    // Flush promises
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // Verify modal elements are shown
    const recordInfo = Array.from(
      document.querySelectorAll('.sfdt-view-overlay span'),
    ).find((s) => s.textContent?.includes('Account · 001800000000001AAA'));
    expect(recordInfo).toBeTruthy();

    const trs = document.querySelectorAll('tbody tr');
    expect(trs).toHaveLength(3);

    const values = Array.from(document.querySelectorAll('tbody tr td span')).map(span => span.textContent);
    expect(values).toContain('Acme Test Corp');
    expect(values).toContain('123-456-7890');
  });

  it('toggles between Fields and JSON views, copies the raw payload, and preserves toggle state', async () => {
    setSalesforceUrl('https://x.lightning.force.com/lightning/r/Account/001800000000001AAA/view');

    const globalMock = vi.fn().mockResolvedValue({
      sobjects: [{ name: 'Account', label: 'Account', keyPrefix: '001' }]
    });

    const describeMock = vi.fn().mockResolvedValue({
      name: 'Account',
      label: 'Account Label',
      fields: [
        { name: 'Name', label: 'Account Name', type: 'string', updateable: true, relationshipName: null, referenceTo: [] }
      ]
    });

    // Raw REST payload is a superset of the describe fields (note `attributes`),
    // proving the JSON view renders the raw payload, not the describe-mapped subset.
    const rawPayload = {
      attributes: { type: 'Account', url: '/services/data/v60.0/sobjects/Account/001800000000001AAA' },
      Id: '001800000000001AAA',
      Name: 'Acme Test Corp',
    };

    const apiGetMock = vi.fn(async (path: string) => {
      if (path.includes('/sobjects/Account/describe')) return describeMock();
      if (path.includes('/sobjects/Account/001800000000001AAA')) return rawPayload;
      if (path.includes('/sobjects/')) return globalMock();
      return {};
    });

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    const api = fakeApi({ apiGet: apiGetMock });
    const feature = createInspectRecordFeature({ api });

    await feature.onActivate?.();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const jsonTab = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'JSON') as HTMLButtonElement;
    const fieldsTab = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Fields') as HTMLButtonElement;
    expect(jsonTab).toBeTruthy();
    expect(fieldsTab).toBeTruthy();

    // Defaults to Fields view.
    expect(fieldsTab.getAttribute('aria-pressed')).toBe('true');
    expect(jsonTab.getAttribute('aria-pressed')).toBe('false');
    // The JSON <pre> exists but is empty and its container hidden in Fields view.
    const pre = document.querySelector('pre') as HTMLPreElement;
    expect(pre.textContent).toBe('');
    expect((pre.parentElement as HTMLElement).style.display).toBe('none');

    // Switch to JSON → raw payload pretty-printed in a <pre> via textContent.
    jsonTab.click();
    expect((pre.parentElement as HTMLElement).style.display).toBe('flex');
    expect(pre.textContent).toBe(JSON.stringify(rawPayload, null, 2));
    expect(jsonTab.getAttribute('aria-pressed')).toBe('true');
    expect(fieldsTab.getAttribute('aria-pressed')).toBe('false');

    // Copy button writes the same pretty-printed JSON to the clipboard.
    const copyBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('Copy JSON')) as HTMLButtonElement;
    copyBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(writeText).toHaveBeenCalledWith(JSON.stringify(rawPayload, null, 2));

    // Toggle state is preserved across a re-render (switch back to Fields sticks).
    fieldsTab.click();
    expect(fieldsTab.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('tbody')).toBeTruthy();
  });

  it('filters field lists dynamically', async () => {
    setSalesforceUrl('https://x.lightning.force.com/lightning/r/Account/001800000000001AAA/view');

    const globalMock = vi.fn().mockResolvedValue({
      sobjects: [{ name: 'Account', label: 'Account', keyPrefix: '001' }]
    });

    const describeMock = vi.fn().mockResolvedValue({
      name: 'Account',
      label: 'Account Label',
      fields: [
        { name: 'Id', label: 'Record ID', type: 'id', updateable: false, relationshipName: null, referenceTo: [] },
        { name: 'Name', label: 'Account Name', type: 'string', updateable: true, relationshipName: null, referenceTo: [] },
        { name: 'Phone', label: 'Phone Number', type: 'phone', updateable: true, relationshipName: null, referenceTo: [] }
      ]
    });

    const rowGetMock = vi.fn().mockResolvedValue({
      Id: '001800000000001AAA',
      Name: 'Acme Test Corp',
      Phone: null
    });

    const apiGetMock = vi.fn(async (path: string) => {
      if (path.includes('/sobjects/Account/describe')) return describeMock();
      if (path.includes('/sobjects/Account/001800000000001AAA')) return rowGetMock();
      if (path.includes('/sobjects/')) return globalMock();
      return {};
    });

    const api = fakeApi({ apiGet: apiGetMock });
    const feature = createInspectRecordFeature({ api });

    await feature.onActivate?.();

    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(document.querySelectorAll('tbody tr')).toHaveLength(3);

    // Filter by 'Phone'
    const filterInput = document.querySelector('input[placeholder="Filter fields by label, API name, or value..."]') as HTMLInputElement;
    filterInput.value = 'Phone';
    filterInput.dispatchEvent(new Event('input'));

    expect(document.querySelectorAll('tbody tr')).toHaveLength(1);

    // Hide null values
    const checkbox = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change'));

    expect(document.querySelectorAll('tbody tr')).toHaveLength(0);
  });

  it('accounts for every field it is not showing, by reason', async () => {
    // Both the filter and the null toggle remove rows silently. With 200+ fields
    // on a real object, "Fields: 1 of 3" plus the reason is the difference
    // between a filtered view and one that looks empty because the record is.
    setSalesforceUrl('https://x.lightning.force.com/lightning/r/Account/001800000000001AAA/view');

    const apiGetMock = vi.fn(async (path: string) => {
      if (path.includes('/sobjects/Account/describe')) {
        return {
          name: 'Account',
          label: 'Account Label',
          fields: [
            { name: 'Id', label: 'Record ID', type: 'id', updateable: false, relationshipName: null, referenceTo: [] },
            { name: 'Name', label: 'Account Name', type: 'string', updateable: true, relationshipName: null, referenceTo: [] },
            { name: 'Phone', label: 'Phone Number', type: 'phone', updateable: true, relationshipName: null, referenceTo: [] },
          ],
        };
      }
      if (path.includes('/sobjects/Account/001800000000001AAA')) {
        return { Id: '001800000000001AAA', Name: 'Acme Test Corp', Phone: null };
      }
      if (path.includes('/sobjects/')) return { sobjects: [{ name: 'Account', label: 'Account', keyPrefix: '001' }] };
      return {};
    });

    const feature = createInspectRecordFeature({
      api: fakeApi({ apiGet: apiGetMock as unknown as SalesforceApiClient['apiGet'] }),
    });
    await feature.onActivate?.();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const status = () =>
      Array.from(document.querySelectorAll('.sfdt-toolbar-foot .sfdt-caps'))
        .map((s) => s.textContent)
        .join(' | ');

    // Nothing hidden: the total alone, no "of".
    expect(status()).toContain('Fields: 3');
    expect(status()).not.toContain('Hidden');

    // Nulls hidden — counted as null, not as filtered.
    const checkbox = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change'));
    expect(status()).toContain('Fields: 2 of 3');
    expect(status()).toContain('1 null');
    expect(status()).not.toContain('filtered');

    // Filter on top of that — the two reasons stay separate, and they add up.
    const filterInput = document.querySelector('input[placeholder="Filter fields by label, API name, or value..."]') as HTMLInputElement;
    filterInput.value = 'Record ID';
    filterInput.dispatchEvent(new Event('input'));
    expect(status()).toContain('Fields: 1 of 3');
    expect(status()).toContain('1 null');
    expect(status()).toContain('1 filtered');
  });

  it('states the record in the view header, not just the table', async () => {
    setSalesforceUrl('https://x.lightning.force.com/lightning/r/Account/001800000000001AAA/view');

    const apiGetMock = vi.fn(async (path: string) => {
      if (path.includes('/sobjects/Account/describe')) {
        return {
          name: 'Account',
          label: 'Account Label',
          fields: [{ name: 'Name', label: 'Account Name', type: 'string', updateable: true, relationshipName: null, referenceTo: [] }],
        };
      }
      if (path.includes('/sobjects/Account/001800000000001AAA')) return { Name: 'Acme Test Corp' };
      if (path.includes('/sobjects/')) return { sobjects: [{ name: 'Account', label: 'Account', keyPrefix: '001' }] };
      return {};
    });

    const feature = createInspectRecordFeature({
      api: fakeApi({ apiGet: apiGetMock as unknown as SalesforceApiClient['apiGet'] }),
    });
    await feature.onActivate?.();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // Rendered by the shared shell, so it reads identically as a modal on a
    // Salesforce page and as a Workspace tab.
    const sub = document.querySelector('.sfdt-panel-sub') as HTMLElement;
    expect(sub.textContent).toBe('Account · 001800000000001AAA');
    // The view toggle sits in the header, and only once a record is loaded.
    const segment = document.querySelector('.sfdt-panel-head .sfdt-segment') as HTMLElement;
    expect(segment.style.display).not.toBe('none');
  });

  it('handles in-place editing and saves changes via PATCH', async () => {
    setSalesforceUrl('https://x.lightning.force.com/lightning/r/Account/001800000000001AAA/view');

    const globalMock = vi.fn().mockResolvedValue({
      sobjects: [{ name: 'Account', label: 'Account', keyPrefix: '001' }]
    });

    const describeMock = vi.fn().mockResolvedValue({
      name: 'Account',
      label: 'Account Label',
      fields: [
        { name: 'Name', label: 'Account Name', type: 'string', updateable: true, relationshipName: null, referenceTo: [] }
      ]
    });

    const rowGetMock = vi.fn().mockResolvedValue({
      Name: 'Acme Test Corp'
    });

    const apiGetMock = vi.fn(async (path: string) => {
      if (path.includes('/sobjects/Account/describe')) return describeMock();
      if (path.includes('/sobjects/Account/001800000000001AAA')) return rowGetMock();
      if (path.includes('/sobjects/')) return globalMock();
      return {};
    });

    const apiRequestMock = vi.fn().mockResolvedValue({});

    const api = fakeApi({ apiGet: apiGetMock, apiRequest: apiRequestMock });
    const feature = createInspectRecordFeature({ api });

    await feature.onActivate?.();

    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // Click the VALUE cell's span to start editing. Column-qualified on
    // purpose: the label and type cells now carry spans of their own, so a bare
    // `td span` picks the label and silently tests nothing.
    const valSpan = document.querySelector('tbody tr td:nth-child(4) span') as HTMLSpanElement;
    valSpan.click();

    const input = document.querySelector('tbody tr td input[type="text"]') as HTMLInputElement;
    expect(input.style.display).not.toBe('none');

    // Change value and blur to finish editing
    input.value = 'New Corp Name';
    input.dispatchEvent(new Event('blur'));

    // Re-render and check dirty state
    const saveBar = Array.from(document.querySelectorAll('div')).find(div => div.textContent?.includes('Save Changes'));
    expect(saveBar?.style.display).toBe('flex');

    const saveBtn = Array.from(document.querySelectorAll('button')).find(btn => btn.textContent === 'Save Changes');
    saveBtn?.click();

    await new Promise((r) => setTimeout(r, 0));

    expect(apiRequestMock).toHaveBeenCalledWith(
      'PATCH',
      expect.stringContaining('/sobjects/Account/001800000000001AAA'),
      { Name: 'New Corp Name' }
    );
  });

  it('openFor loads a specific record Id (the context-menu path), ignoring the page URL', async () => {
    // Page is a plain Setup page — the context menu passes an explicit Id from a
    // right-clicked link, so openFor must load THAT record, not the page URL.
    setSalesforceUrl('https://x.lightning.force.com/lightning/setup/SetupOneHome/home');

    const globalMock = vi.fn().mockResolvedValue({
      sobjects: [{ name: 'Account', label: 'Account', keyPrefix: '001' }],
    });
    const describeMock = vi.fn().mockResolvedValue({
      name: 'Account',
      label: 'Account',
      fields: [
        { name: 'Name', label: 'Account Name', type: 'string', updateable: true, relationshipName: null, referenceTo: [] },
      ],
    });
    const rowGetMock = vi.fn().mockResolvedValue({ Name: 'Menu Corp' });

    const apiGetMock = vi.fn(async (path: string) => {
      if (path.includes('/sobjects/Account/describe')) return describeMock();
      if (path.includes('/sobjects/Account/001800000000001AAA')) return rowGetMock();
      if (path.includes('/sobjects/')) return globalMock();
      return {};
    });

    const feature = createInspectRecordFeature({
      api: fakeApi({ apiGet: apiGetMock as unknown as SalesforceApiClient['apiGet'] }),
    });
    await feature.openFor('001800000000001AAA', 'Account');
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const recordInfo = Array.from(document.querySelectorAll('.sfdt-view-overlay span')).find(
      (s) => s.textContent?.includes('Account · 001800000000001AAA'),
    );
    expect(recordInfo).toBeTruthy();
    const values = Array.from(document.querySelectorAll('tbody tr td span')).map((s) => s.textContent);
    expect(values).toContain('Menu Corp');
  });

  it('opens an empty inspector with a blank ID input when the page is not a record', async () => {
    setSalesforceUrl('https://x.lightning.force.com/lightning/setup/SetupOneHome/home');
    const api = fakeApi();
    const feature = createInspectRecordFeature({ api });

    await feature.onActivate?.();
    await new Promise((r) => setTimeout(r, 0));

    const overlay = document.querySelector('.sfdt-view-overlay');
    expect(overlay).not.toBeNull();
    // No record was auto-loaded, so the global describe / record fetch never ran.
    expect(api.apiGet).not.toHaveBeenCalled();
    const idInput = document.querySelector<HTMLInputElement>(
      'input[placeholder^="Paste Salesforce Record ID"]',
    );
    expect(idInput).not.toBeNull();
    expect(idInput!.value).toBe('');
  });

  it('warns and does not query when an invalid ID is submitted', async () => {
    setSalesforceUrl('https://x.lightning.force.com/lightning/setup/SetupOneHome/home');
    const api = fakeApi();
    const feature = createInspectRecordFeature({ api });

    await feature.onActivate?.();
    await new Promise((r) => setTimeout(r, 0));

    const idInput = document.querySelector<HTMLInputElement>(
      'input[placeholder^="Paste Salesforce Record ID"]',
    )!;
    idInput.value = 'not-a-valid-id';
    const inspectBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Inspect',
    ) as HTMLButtonElement;
    inspectBtn.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(document.querySelector('.sfdt-toast')?.textContent).toMatch(/valid 15 or 18 character/);
    expect(api.apiGet).not.toHaveBeenCalled();
  });
});
